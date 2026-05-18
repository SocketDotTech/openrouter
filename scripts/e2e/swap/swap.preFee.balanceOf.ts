/**
 * Route:  Polygon AAVE → USDC (OpenOcean) — standalone swap, no bridge
 * Flags:  pre-fee (fee taken from AAVE input before swap), output measured as USDC balanceOf delta
 *
 * Pre-fee (bit0=0): feeAmount = FEE_BPS of inputAmount AAVE, deducted before the swap.
 * BalanceOf (bit1=1): final USDC amount is measured as router USDC balance change (not returndata).
 *
 * USDC lands in signer's wallet on Polygon.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swap/swap.preFee.balanceOf.ts
 */
import axios from "axios";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
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
import { ZERO_BYTES32 } from "../utils/contractTypes";
import { logTxnSummary } from "../utils/txnLogSummary";
import {
  ensureRouterErc20Balance,
  ensureRouterApproval,
} from "../utils/reproducibility";

// pre-fee (0x00) | balance-of (0x02)
const FLAGS = 0x02n;
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
  console.log(`Flags:         0x${FLAGS.toString(16)} (pre-fee, balanceOf)`);
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log("Fetching OpenOcean quote (AAVE → USDC)...");
  const { ooRouter, swapData, estimatedOut, minAmountOut } =
    await fetchOpenOceanQuote(inputAmount);

  // pre-fee: deduct from input AAVE before the swap
  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  console.log(`  OO router:   ${ooRouter}`);
  console.log(
    `  Pre-fee:     ${ethers.formatUnits(feeAmount, 18)} AAVE (${FEE_BPS} bps)`
  );
  console.log(`  Est. USDC:   ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(`  Min USDC:    ${ethers.formatUnits(minAmountOut, 6)}`);

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

  const callData = routerIface.encodeFunctionData("swap", [
    ZERO_BYTES32,
    {
      user: signerAddress,
      inputToken: TOKENS.AAVE_POLYGON,
      inputAmount: inputAmount,
    },
    signerAddress,
    FLAGS,
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
  ]);

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
    `Polygon AAVE → USDC — swap preFee/balanceOf`,
    CHAIN_IDS.POLYGON,
    receipt
  );

  console.log(`\nUSDC is now in signer's wallet on Polygon.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
