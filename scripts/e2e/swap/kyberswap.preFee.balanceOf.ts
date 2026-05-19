/**
 * Route:  Polygon AAVE → USDC (KyberSwap) — standalone swap, no bridge
 * Flags:  pre-fee (fee taken from AAVE input before swap), output measured as USDC balanceOf delta
 *
 * Pre-fee (bit0=0): feeAmount = FEE_BPS of inputAmount AAVE, deducted before the swap.
 * BalanceOf (bit1=1): final USDC amount is measured as router USDC balance change (not returndata).
 *
 * KyberSwap build calldata encodes exact input amounts, so the quote is for swapInput
 * (inputAmount − preFeeAmount) to match the router's approval amount at execution time.
 * returnData mode is not available for KyberSwap — it routes output directly to recipient.
 *
 * USDC lands in signer's wallet on Polygon.
 *
 * Usage:
 *   PRIVATE_KEY=0x... KYBERSWAP_API_KEY=... ts-node scripts/e2e/swap/kyberswap.preFee.balanceOf.ts
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
  KYBERSWAP_API_KEY,
  SWAP_SLIPPAGE_BPS,
} from "../config";
import {
  execViaAH,
  ensureAllowanceForAllowanceHolder,
} from "../utils/allowanceHolder";
import { getWalletErc20Balance } from "../utils/erc20";
import { ROUTER_ABI } from "../utils/routerAbi";
import { ZERO_BYTES32, swapArgs } from "../utils/contractTypes";
import { logTxnSummary } from "../utils/txnLogSummary";
import {
  ensureRouterErc20Balance,
  ensureRouterApproval,
} from "../utils/reproducibility";

// pre-fee (0x00) | balance-of (0x02)
const FLAGS = 0x02n;
const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);
const KYBERSWAP_BASE_URL = "https://aggregator-api.kyberswap.com";
const KYBERSWAP_CHAIN = "polygon";

interface KyberRouteData {
  routeSummary: object;
  routerAddress: string;
}

interface KyberBuildData {
  routerAddress: string;
  amountOut: string;
  data: string;
  transactionValue: string;
}

/**
 * Fetches a KyberSwap route quote then builds executable calldata.
 * Sets sender and recipient both to the router so output lands in the router
 * for balanceOf delta measurement.
 */
async function fetchKyberSwapQuote(
  amountIn: bigint,
  routerAddress: string,
): Promise<{
  ksRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
  value: bigint;
}> {
  const headers: Record<string, string> = {};
  if (KYBERSWAP_API_KEY) {
    headers["x-client-id"] = KYBERSWAP_API_KEY;
  }

  const routeUrl =
    `${KYBERSWAP_BASE_URL}/${KYBERSWAP_CHAIN}/api/v1/routes` +
    `?tokenIn=${TOKENS.AAVE_POLYGON}&tokenOut=${TOKENS.USDC_POLYGON_CIRCLE}` +
    `&amountIn=${amountIn.toString()}&excludedSources=bebop&gasInclude=true`;

  const routeResp = await axios.get<{ code: number; data: KyberRouteData }>(
    routeUrl,
    { headers },
  );
  if (!routeResp.data?.data?.routeSummary) {
    throw new Error(
      `KyberSwap routes call failed: ${JSON.stringify(routeResp.data)}`,
    );
  }
  const { routeSummary } = routeResp.data.data;

  const buildUrl = `${KYBERSWAP_BASE_URL}/${KYBERSWAP_CHAIN}/api/v1/route/build`;
  const buildResp = await axios.post<{ code: number; data: KyberBuildData }>(
    buildUrl,
    {
      routeSummary,
      sender: routerAddress,
      recipient: routerAddress,
      slippageTolerance: SWAP_SLIPPAGE_BPS,
    },
    { headers },
  );
  if (!buildResp.data?.data?.data) {
    throw new Error(
      `KyberSwap build call failed: ${JSON.stringify(buildResp.data)}`,
    );
  }

  const { routerAddress: ksRouter, amountOut, data, transactionValue } =
    buildResp.data.data;
  const estimatedOut = BigInt(amountOut);

  return {
    ksRouter,
    swapData: data,
    estimatedOut,
    minAmountOut:
      (estimatedOut * (10000n - BigInt(SWAP_SLIPPAGE_BPS))) / 10000n,
    value: BigInt(transactionValue ?? "0"),
  };
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var required");
  if (!KYBERSWAP_API_KEY) {
    console.warn(
      "KYBERSWAP_API_KEY not set — unauthenticated requests may be rate-limited",
    );
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance } = await getWalletErc20Balance(
    TOKENS.AAVE_POLYGON,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero AAVE on Polygon`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error("Balance too small");

  // pre-fee: deduct from input AAVE before the swap
  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  // quote for the reduced swap input so KyberSwap calldata encodes the correct amount
  const swapInput = inputAmount - feeAmount;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Flags:         0x${FLAGS.toString(16)} (pre-fee, balanceOf)`);
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);
  console.log(
    `Pre-fee:       ${ethers.formatUnits(feeAmount, 18)} AAVE (${FEE_BPS} bps)`,
  );
  console.log(`Swap input:    ${ethers.formatUnits(swapInput, 18)} AAVE`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log("Fetching KyberSwap quote (AAVE → USDC)...");
  const { ksRouter, swapData, estimatedOut, minAmountOut, value } =
    await fetchKyberSwapQuote(swapInput, ROUTER_POLYGON);

  console.log(`  KS router:   ${ksRouter}`);
  console.log(`  Est. USDC:   ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(`  Min USDC:    ${ethers.formatUnits(minAmountOut, 6)}`);

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(
    signer,
    TOKENS.USDC_POLYGON_CIRCLE,
    ROUTER_POLYGON,
  );
  await ensureRouterApproval(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    ksRouter,
  );

  const callData = routerIface.encodeFunctionData("swap", swapArgs(
    ZERO_BYTES32,
    FLAGS,
    {
      user: signerAddress,
      inputToken: TOKENS.AAVE_POLYGON,
      inputAmount: inputAmount,
    },
    { receiver: signerAddress, amount: feeAmount },
    {
      target: ksRouter,
      approvalSpender: ksRouter,
      outputToken: TOKENS.USDC_POLYGON_CIRCLE,
      value,
      minOutput: minAmountOut,
      returnDataWordOffset: 0n,
    },
    swapData,
    signerAddress,
  ));

  await ensureAllowanceForAllowanceHolder(
    signer,
    TOKENS.AAVE_POLYGON,
    inputAmount,
  );
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    inputAmount,
    ROUTER_POLYGON,
    callData,
  );

  logTxnSummary(
    `Polygon AAVE → USDC — kyberswap preFee/balanceOf`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
  console.log(`\nUSDC is now in signer's wallet on Polygon.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
