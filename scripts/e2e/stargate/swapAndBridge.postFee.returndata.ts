/**
 * Route:  Arbitrum USDC → native ETH (OpenOcean) → Base ETH (Stargate Native Pool, LayerZero v2)
 * Flags:  post-fee (fee taken from ETH output after swap), output read from swap returndata word 0
 *         bridge-value flag: router forwards finalETH as msg.value to Stargate
 *
 * Post-fee (bit0=1): feeAmount = FEE_BPS of estimatedOut ETH, deducted from swap output.
 * Returndata (bit1=0): final ETH amount is read from word 0 of the swap call returndata.
 * BridgeValue (bit2=1): router forwards finalETH as msg.value to Stargate send().
 *
 * amountLD = estimatedOut - feeAmount - nativeFeeWithBuffer (conservative floor).
 * StargatePoolNative checks msg.value >= amountLD + nativeFee; satisfied since actual >= minAmountOut.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/stargate/swapAndBridge.postFee.returndata.ts
 */
import axios from "axios";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  NATIVE_TOKEN_ADDRESS,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
  STARGATE_NATIVE_ARB,
  BASE_LZ_EID,
} from "../config";
import {
  execViaAH,
  ensureAllowanceForAllowanceHolder,
} from "../utils/allowanceHolder";
import { getWalletErc20Balance } from "../utils/erc20";
import { ROUTER_ABI } from "../utils/routerAbi";
import {
  ZERO_BYTES32,
  BRIDGE_VALUE_FLAG,
  ZERO_ADDRESS,
} from "../utils/contractTypes";
import { logTxnSummary } from "../utils/txnLogSummary";
import {
  ensureRouterErc20Balance,
  ensureRouterNativeBalance,
  ensureRouterApproval,
} from "../utils/reproducibility";

// post-fee (0x01) | bridge-value (0x04): forward finalETH as msg.value
const FLAGS = 0x01n | BRIDGE_VALUE_FLAG;
const ROUTER_ARB = routerAddressForChain(CHAIN_IDS.ARBITRUM);

const STARGATE_ABI = [
  "function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)",
  "function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)",
  "function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable",
];

const STARGATE_IFACE = new ethers.Interface(STARGATE_ABI);

interface OoQuoteResponse {
  data: { to: string; data: string; outAmount: string; minOutAmount: string };
}

async function fetchOpenOceanQuote(inputAmount: bigint): Promise<{
  ooRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.USDC_ARB,
    outTokenAddress: NATIVE_TOKEN_ADDRESS,
    amount: ethers.formatUnits(inputAmount, 6),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_ARB,
    account: ROUTER_ARB,
    gasPrice: "1",
  };
  if (OPEN_OCEAN_API_KEY) params.apikey = OPEN_OCEAN_API_KEY;
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.ARBITRUM}/swap_quote`;
  const response = await axios.get<OoQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

async function fetchStargateQuote(
  provider: ethers.JsonRpcProvider,
  bridgeAmountLD: bigint,
  recipient: string
): Promise<{ nativeFee: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(
    STARGATE_NATIVE_ARB,
    STARGATE_ABI,
    provider
  );
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = {
    dstEid: BASE_LZ_EID,
    to: to32,
    amountLD: bridgeAmountLD,
    minAmountLD: 0n,
    extraOptions: "0x",
    composeMsg: "0x",
    oftCmd: "0x",
  };
  const [fee, oft] = await Promise.all([
    contract.quoteSend(sendParam, false),
    contract.quoteOFT(sendParam),
  ]);
  return {
    nativeFee: fee.nativeFee as bigint,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

function buildStargateCalldata(
  nativeFee: bigint,
  recipient: string,
  amountLD: bigint
): string {
  return STARGATE_IFACE.encodeFunctionData("send", [
    {
      dstEid: BASE_LZ_EID,
      to: ethers.zeroPadValue(recipient, 32),
      amountLD,
      minAmountLD: 0n,
      extraOptions: "0x",
      composeMsg: "0x",
      oftCmd: "0x",
    },
    { nativeFee, lzTokenFee: 0n },
    recipient,
  ]);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var required");

  const provider = new ethers.JsonRpcProvider(RPC.ARBITRUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance } = await getWalletErc20Balance(
    TOKENS.USDC_ARB,
    signerAddress,
    provider
  );
  if (walletBalance === 0n)
    throw new Error(`Signer ${signerAddress} has zero USDC on Arbitrum`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error("Balance too small");

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ARB}`);
  console.log(
    `Flags:         0x${FLAGS.toString(
      16
    )} (post-fee, returndata, bridge-value)`
  );
  console.log(`USDC balance:  ${ethers.formatUnits(walletBalance, 6)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log("Fetching OpenOcean quote (USDC → ETH)...");
  const { ooRouter, swapData, estimatedOut, minAmountOut } =
    await fetchOpenOceanQuote(inputAmount);

  // post-fee: deduct from estimated ETH output after swap
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`  OO router:   ${ooRouter}`);
  console.log(`  Est. ETH:    ${ethers.formatEther(estimatedOut)}`);
  console.log(
    `  Post-fee:    ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`
  );
  console.log(`  Min ETH:     ${ethers.formatEther(minAmountOut)}`);

  console.log("Fetching Stargate quote...");
  const bridgeEstimate = estimatedOut - feeAmount;
  const { nativeFee, amountReceivedLD } = await fetchStargateQuote(
    provider,
    bridgeEstimate,
    signerAddress
  );
  const nativeFeeWithBuffer = (nativeFee * 105n) / 100n;
  console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} ETH`);
  console.log(`  Est. received: ${ethers.formatEther(amountReceivedLD)} ETH`);

  // amountLD = estimatedOut - feeAmount - nativeFeeWithBuffer (conservative floor)
  const amountLD = estimatedOut - feeAmount - nativeFeeWithBuffer;
  if (amountLD <= 0n)
    throw new Error(
      "estimatedOut too small to cover fee + nativeFeeWithBuffer"
    );

  await ensureRouterErc20Balance(signer, TOKENS.USDC_ARB, ROUTER_ARB);
  await ensureRouterNativeBalance(signer, ROUTER_ARB);
  await ensureRouterApproval(signer, ROUTER_ARB, TOKENS.USDC_ARB, ooRouter);

  const stargateData = buildStargateCalldata(
    nativeFeeWithBuffer,
    signerAddress,
    amountLD
  );

  const callData = routerIface.encodeFunctionData("swapAndBridge", [
    ZERO_BYTES32,
    {
      user: signerAddress,
      inputToken: TOKENS.USDC_ARB,
      inputAmount: inputAmount,
    },
    FLAGS,
    { receiver: signerAddress, amount: feeAmount },
    {
      target: ooRouter,
      approvalSpender: ooRouter,
      outputToken: NATIVE_TOKEN_ADDRESS,
      value: 0n,
      minOutput: minAmountOut,
      returnDataWordOffset: 0n,
    },
    swapData,
    {
      target: STARGATE_NATIVE_ARB,
      approvalSpender: ZERO_ADDRESS,
      value: 0n,
    },
    stargateData,
  ]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.USDC_ARB, inputAmount);
  const receipt = await execViaAH(
    signer,
    ROUTER_ARB,
    TOKENS.USDC_ARB,
    inputAmount,
    ROUTER_ARB,
    callData,
    0n
  );

  logTxnSummary(
    `Arbitrum USDC → Base ETH (Stargate) — swapAndBridge postFee/returndata`,
    CHAIN_IDS.ARBITRUM,
    receipt
  );

  console.log("\nETH arrives on Base once LZ delivers the message.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
