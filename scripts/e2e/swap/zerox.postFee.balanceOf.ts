/**
 * Route:  Polygon AAVE → USDC (0x v2 AllowanceHolder) — standalone swap, no bridge
 * Flags:  post-fee (fee taken from USDC output after swap), output measured as USDC balanceOf delta
 *
 * Post-fee (bit0=1): feeAmount = FEE_BPS of estimatedOut USDC, deducted from swap output.
 * BalanceOf (bit1=1): final USDC amount is measured as router USDC balance change (not returndata).
 *
 * 0x v2 uses the AllowanceHolder contract (0x000…1fF3) as both the approval target and the swap
 * call target. taker=router (router holds the tokens and makes the AH call), recipient=router
 * (output lands in router for post-fee deduction and balanceOf delta measurement).
 *
 * USDC lands in signer's wallet on Polygon.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ZEROX_API_KEY=... ts-node scripts/e2e/swap/zerox.postFee.balanceOf.ts
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
  ZEROX_API_KEY,
  SWAP_SLIPPAGE_BPS,
  allowanceHolderForChain,
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
} from '../utils/reproducibility';
import { resolveApprovalSpender } from '../utils/routerAllowance';

// post-fee (0x01) | balance-of (0x02)
const FLAGS = 0x03n;
const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);
const ALLOWANCE_HOLDER = allowanceHolderForChain(CHAIN_IDS.POLYGON);
const ZEROX_BASE_URL = "https://api.0x.org";

interface ZeroXTransaction {
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
}

interface ZeroXQuoteResponse {
  transaction: ZeroXTransaction;
  buyAmount: string;
  minBuyAmount: string;
  issues?: {
    balance?: { token: string; actual: string; expected: string };
    allowance?: { actual: string; spender: string };
    simulationIncomplete?: boolean;
  };
}

/**
 * Fetches a 0x v2 AllowanceHolder swap quote.
 * taker and recipient are both set to the router so the router executes the call
 * and receives the output for post-fee deduction and balanceOf delta measurement.
 *
 * Balance/allowance issues in the response are expected at quote time (the router
 * will have the tokens at execution time) and are ignored.
 */
async function fetchZeroXQuote(
  sellAmount: bigint,
  taker: string,
  recipient: string,
  txOrigin: string,
): Promise<{
  swapTarget: string;
  swapData: string;
  buyAmount: bigint;
  minBuyAmount: bigint;
  value: bigint;
}> {
  if (!ZEROX_API_KEY) {
    throw new Error("ZEROX_API_KEY env var required");
  }

  const url =
    `${ZEROX_BASE_URL}/swap/allowance-holder/quote` +
    `?chainId=${CHAIN_IDS.POLYGON}` +
    `&buyToken=${TOKENS.USDC_POLYGON_CIRCLE}` +
    `&sellToken=${TOKENS.AAVE_POLYGON}` +
    `&sellAmount=${sellAmount.toString()}` +
    `&taker=${taker}` +
    `&recipient=${recipient}` +
    `&txOrigin=${txOrigin}` +
    `&slippageBps=${SWAP_SLIPPAGE_BPS}`;

  const resp = await axios.get<ZeroXQuoteResponse>(url, {
    headers: {
      "0x-api-key": ZEROX_API_KEY,
      "0x-version": "v2",
    },
  });

  if (!resp.data?.transaction) {
    throw new Error(`0x quote call failed: ${JSON.stringify(resp.data)}`);
  }

  const { transaction, buyAmount, minBuyAmount } = resp.data;
  return {
    swapTarget: transaction.to,
    swapData: transaction.data,
    buyAmount: BigInt(buyAmount),
    minBuyAmount: BigInt(minBuyAmount),
    value: BigInt(transaction.value ?? "0"),
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
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero AAVE on Polygon`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error("Balance too small");

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Flags:         0x${FLAGS.toString(16)} (post-fee, balanceOf)`);
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log("Fetching 0x quote (AAVE → USDC)...");
  const { swapTarget, swapData, buyAmount, minBuyAmount, value } =
    await fetchZeroXQuote(inputAmount, ROUTER_POLYGON, ROUTER_POLYGON, signerAddress);

  // post-fee: deduct from estimated USDC output after swap
  const feeAmount = bpsOf(buyAmount, FEE_BPS);
  console.log(`  0x target:   ${swapTarget}`);
  console.log(`  Est. USDC:   ${ethers.formatUnits(buyAmount, 6)}`);
  console.log(
    `  Post-fee:    ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`,
  );
  console.log(`  Min USDC:    ${ethers.formatUnits(minBuyAmount, 6)}`);

  // The 0x AllowanceHolder is the approval spender; swapTarget should equal ALLOWANCE_HOLDER
  const approvalSpender = ALLOWANCE_HOLDER;

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(
    signer,
    TOKENS.USDC_POLYGON_CIRCLE,
    ROUTER_POLYGON,
  );

  const swapApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    approvalSpender,
    inputAmount,
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
      target: swapTarget,
      approvalSpender: swapApprovalSpender,
      outputToken: TOKENS.USDC_POLYGON_CIRCLE,
      value,
      minOutput: minBuyAmount,
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
    `Polygon AAVE → USDC — 0x postFee/balanceOf`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
  console.log(`\nUSDC is now in signer's wallet on Polygon.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
