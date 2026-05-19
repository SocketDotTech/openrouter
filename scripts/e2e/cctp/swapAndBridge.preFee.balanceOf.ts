/**
 * Route:  Polygon AAVE → USDC (OpenOcean) → Base USDC (CCTP depositForBurn)
 * Flags:  pre-fee (fee taken from AAVE input before swap), output measured as USDC balanceOf delta
 *         bridge amount spliced into depositForBurn calldata at byte offset 4 (amount param)
 *
 * Pre-fee (bit0=0): feeAmount = FEE_BPS of inputAmount, deducted from AAVE before the swap.
 * BalanceOf (bit1=1): final USDC amount is measured as router USDC balance change (not returndata).
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/cctp/swapAndBridge.preFee.balanceOf.ts
 */
import axios from "axios";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  CCTP_CONFIG,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
} from "../config";
import {
  execViaAH,
  ensureAllowanceForAllowanceHolder,
} from "../utils/allowanceHolder";
import { getWalletErc20Balance } from "../utils/erc20";
import { ROUTER_ABI } from "../utils/routerAbi";
import { ZERO_BYTES32, bridgeAmountPositionFlag, swapAndBridgeArgs } from "../utils/contractTypes";
import { logTxnSummary } from "../utils/txnLogSummary";
import {
  ensureRouterErc20Balance,
  ensureRouterApproval,
} from "../utils/reproducibility";

// pre-fee (0x00) | balance-of (0x02) | bridge amount at byte offset 4 (depositForBurn amount param)
const FLAGS = 0x02n | bridgeAmountPositionFlag(4);
const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

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
    inTokenAddress: TOKENS.AAVE_POLYGON,
    outTokenAddress: TOKENS.USDC_POLYGON_CIRCLE,
    amount: ethers.formatUnits(inputAmount, 18),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_POLYGON,
    account: ROUTER_POLYGON,
    gasPrice: "1",
  };
  if (OPEN_OCEAN_API_KEY) params.apikey = OPEN_OCEAN_API_KEY;
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.POLYGON}/swap_quote`;
  const response = await axios.get<OoQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

function buildDepositForBurnCalldata(
  recipientAddress: string,
  burnToken: string,
  destinationCctpDomain: number
): string {
  const iface = new ethers.Interface([
    "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external",
  ]);
  return iface.encodeFunctionData("depositForBurn", [
    0n,
    destinationCctpDomain,
    ethers.zeroPadValue(recipientAddress, 32),
    burnToken,
    ethers.ZeroHash,
    1_000_000n,
    1000,
  ]);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var required");

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance } = await getWalletErc20Balance(
    TOKENS.AAVE_POLYGON,
    signerAddress,
    provider
  );
  if (walletBalance === 0n)
    throw new Error(`Signer ${signerAddress} has zero AAVE on Polygon`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error("Balance too small");

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(
    `Flags:         0x${FLAGS.toString(
      16
    )} (pre-fee, balanceOf, bridge-amount-pos=4)`
  );
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];

  console.log("Fetching OpenOcean quote (AAVE → USDC)...");
  const { ooRouter, swapData, minAmountOut } = await fetchOpenOceanQuote(
    inputAmount
  );

  // pre-fee: deduct from input AAVE before the swap
  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const swapInputAmount = inputAmount - feeAmount;
  console.log(`  OO router:   ${ooRouter}`);
  console.log(
    `  Pre-fee:     ${ethers.formatUnits(feeAmount, 18)} AAVE (${FEE_BPS} bps)`
  );
  console.log(`  Swap input:  ${ethers.formatUnits(swapInputAmount, 18)} AAVE`);
  console.log(`  Min USDC:    ${ethers.formatUnits(minAmountOut, 6)}`);

  const depositForBurnData = buildDepositForBurnCalldata(
    signerAddress,
    polyCctp.usdcAddress,
    baseCctp.cctpDomain
  );

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(
    signer,
    TOKENS.USDC_POLYGON_CIRCLE,
    ROUTER_POLYGON
  );
  await ensureRouterApproval(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    ooRouter
  );
  await ensureRouterApproval(
    signer,
    ROUTER_POLYGON,
    TOKENS.USDC_POLYGON_CIRCLE,
    polyCctp.tokenMessenger
  );

  const callData = routerIface.encodeFunctionData("swapAndBridge", swapAndBridgeArgs(
    ZERO_BYTES32,
    FLAGS,
    {
      user: signerAddress,
      inputToken: TOKENS.AAVE_POLYGON,
      inputAmount: inputAmount,
    },
    { receiver: signerAddress, amount: feeAmount },
    {
      target: ooRouter,
      approvalSpender: ooRouter,
      outputToken: TOKENS.USDC_POLYGON_CIRCLE,
      value: 0n,
      minOutput: minAmountOut,
      returnDataWordOffset: 0n,
    },
    swapData,
    {
      target: polyCctp.tokenMessenger,
      approvalSpender: polyCctp.tokenMessenger,
      value: 0n,
    },
    depositForBurnData,
  ));

  await ensureAllowanceForAllowanceHolder(
    signer,
    TOKENS.AAVE_POLYGON,
    inputAmount
  );
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    inputAmount,
    ROUTER_POLYGON,
    callData
  );

  logTxnSummary(
    `Polygon AAVE → Base USDC (CCTP) — swapAndBridge preFee/balanceOf`,
    CHAIN_IDS.POLYGON,
    receipt
  );

  console.log(
    `\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
