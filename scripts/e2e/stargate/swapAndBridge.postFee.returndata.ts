/**
 * Route:  Base USDC → native ETH (OpenOcean) → Arbitrum ETH (Stargate Native Pool on Base, LayerZero v2)
 * Flags:  post-fee (fee taken from ETH output after swap), output read from swap returndata word 0
 *         bridge-value + bridge-amount-position flags: router splices finalETH into amountLD and
 *         forwards finalETH + nativeFeeWithBuffer as msg.value to Stargate
 *
 * Post-fee (bit0=1): feeAmount = FEE_BPS of estimatedOut ETH, deducted from swap output.
 * Returndata (bit1=0): final ETH amount is read from word 0 of the swap call returndata.
 * BridgeValue (bit2=1): router forwards finalETH + nativeFeeWithBuffer as msg.value to Stargate.
 * BridgeAmountPosition (bit3=1): router splices finalETH into amountLD at STARGATE_AMOUNT_LD_OFFSET.
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
  STARGATE_NATIVE_BASE,
  ARBITRUM_LZ_EID,
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
  bridgeAmountPositionFlag,
  swapAndBridgeArgs,
} from "../utils/contractTypes";
import { STARGATE_AMOUNT_LD_OFFSET } from "../config";
import { logTxnSummary } from "../utils/txnLogSummary";
import {
  ensureRouterErc20Balance,
  ensureRouterNativeBalance,
  ensureRouterApproval,
} from "../utils/reproducibility";

// post-fee (0x01) | bridge-value (0x04) | bridge-amount-position (0x08 + offset): splice finalETH into amountLD + forward with nativeFee
const FLAGS = 0x01n | BRIDGE_VALUE_FLAG | bridgeAmountPositionFlag(STARGATE_AMOUNT_LD_OFFSET);
const ROUTER_BASE = routerAddressForChain(CHAIN_IDS.BASE);

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
    inTokenAddress: TOKENS.USDC_BASE,
    outTokenAddress: NATIVE_TOKEN_ADDRESS,
    amount: ethers.formatUnits(inputAmount, 6),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_BASE,
    account: ROUTER_BASE,
    gasPrice: "1",
  };
  if (OPEN_OCEAN_API_KEY) params.apikey = OPEN_OCEAN_API_KEY;
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.BASE}/swap_quote`;
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
    STARGATE_NATIVE_BASE,
    STARGATE_ABI,
    provider
  );
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = {
    dstEid: ARBITRUM_LZ_EID,
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
      dstEid: ARBITRUM_LZ_EID,
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

  const provider = new ethers.JsonRpcProvider(RPC.BASE);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance } = await getWalletErc20Balance(
    TOKENS.USDC_BASE,
    signerAddress,
    provider
  );
  if (walletBalance === 0n)
    throw new Error(`Signer ${signerAddress} has zero USDC on Base`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error("Balance too small");

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_BASE}`);
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

  console.log("Fetching Stargate quote (Base native pool → Arbitrum)...");
  const bridgeEstimate = estimatedOut - feeAmount;
  const { nativeFee, amountReceivedLD } = await fetchStargateQuote(
    provider,
    bridgeEstimate,
    signerAddress
  );
  const nativeFeeWithBuffer = (nativeFee * 105n) / 100n;
  console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} ETH`);
  console.log(`  Est. received: ${ethers.formatEther(amountReceivedLD)} ETH`);

  // bridgeEstimate is a placeholder for amountLD; router splices the actual finalETH at runtime
  const amountLD = bridgeEstimate;

  await ensureRouterErc20Balance(signer, TOKENS.USDC_BASE, ROUTER_BASE);
  await ensureRouterNativeBalance(signer, ROUTER_BASE);
  await ensureRouterApproval(signer, ROUTER_BASE, TOKENS.USDC_BASE, ooRouter);

  const stargateData = buildStargateCalldata(
    nativeFeeWithBuffer,
    signerAddress,
    amountLD
  );

  const callData = routerIface.encodeFunctionData("swapAndBridge", swapAndBridgeArgs(
    ZERO_BYTES32,
    FLAGS,
    {
      user: signerAddress,
      inputToken: TOKENS.USDC_BASE,
      inputAmount: inputAmount,
    },
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
      target: STARGATE_NATIVE_BASE,
      approvalSpender: ZERO_ADDRESS,
      value: nativeFeeWithBuffer,
    },
    stargateData,
  ));

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.USDC_BASE, inputAmount);
  const receipt = await execViaAH(
    signer,
    ROUTER_BASE,
    TOKENS.USDC_BASE,
    inputAmount,
    ROUTER_BASE,
    callData,
    nativeFeeWithBuffer
  );

  logTxnSummary(
    `Base USDC → Arbitrum ETH (Stargate) — swapAndBridge postFee/returndata`,
    CHAIN_IDS.BASE,
    receipt
  );

  console.log("\nETH arrives on Arbitrum once LZ delivers the message.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
