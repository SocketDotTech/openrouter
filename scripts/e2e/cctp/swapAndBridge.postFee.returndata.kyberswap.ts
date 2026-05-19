/**
 * Route:  Polygon AAVE → USDC (KyberSwap) → Base USDC (CCTP depositForBurn)
 * Flags:  post-fee (fee taken from USDC output after swap), output read from swap returndata word 0
 *         bridge amount spliced into depositForBurn calldata at byte offset 4 (amount param)
 *
 * Post-fee (bit0=1): feeAmount = FEE_BPS of estimatedOut USDC, deducted from swap output.
 * Returndata (bit1=0): final USDC amount is read from word 0 of the swap call returndata.
 *
 * Usage:
 *   PRIVATE_KEY=0x... KYBERSWAP_API_KEY=... ts-node scripts/e2e/cctp/swapAndBridge.postFee.returndata.kyberswap.ts
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
  KYBERSWAP_API_KEY,
  SWAP_SLIPPAGE_BPS,
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

// post-fee (0x01) | bridge amount at byte offset 4 (depositForBurn amount param)
const FLAGS = 0x01n | bridgeAmountPositionFlag(4);
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
 * Post-fee Kyber build: sender and recipient are the router so gross USDC stays on-contract
 * before fee deduction and CCTP burn (same net shape as the OpenOcean post-fee script).
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
  if (walletBalance === 0n)
    throw new Error(`Signer ${signerAddress} has zero AAVE on Polygon`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error("Balance too small");

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(
    `Flags:         0x${FLAGS.toString(
      16
    )} (post-fee, returndata, bridge-amount-pos=4)`,
  );
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];

  console.log("Fetching KyberSwap quote (AAVE → USDC)...");
  const { ksRouter, swapData, estimatedOut, minAmountOut, value } =
    await fetchKyberSwapQuote(inputAmount, ROUTER_POLYGON);

  // post-fee: deduct from estimated USDC output after swap
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`  KS router:   ${ksRouter}`);
  console.log(`  Est. USDC:   ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(
    `  Post-fee:    ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`,
  );
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
    ksRouter
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
      target: ksRouter,
      approvalSpender: ksRouter,
      outputToken: TOKENS.USDC_POLYGON_CIRCLE,
      value,
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
    `Polygon AAVE → Base USDC (CCTP) — swapAndBridge postFee/returndata (Kyber)`,
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
