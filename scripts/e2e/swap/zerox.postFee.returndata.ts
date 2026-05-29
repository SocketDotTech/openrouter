/**
 * Route:  Polygon AAVE → USDC (0x v2 AllowanceHolder) — standalone swap, no bridge
 * Flags:  post-fee (fee taken from USDC output after swap), output read from swap returndata word 0
 *
 * Post-fee (bit0=1): feeAmount = FEE_BPS of estimatedOut USDC, deducted from swap output.
 * Returndata (bit1=0): final USDC amount is read from word 0 of the swap call returndata.
 *
 * 0x: taker=router, recipient=router so gross USDC stays on the router for post-fee settle
 * (same quote shape as balanceOf post-fee; only the output-measurement flag differs).
 *
 * USDC lands in signer's wallet on Polygon.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ZEROX_API_KEY=... ts-node scripts/e2e/swap/zerox.postFee.returndata.ts
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

// post-fee (0x01) | returndata (no 0x02)
const FLAGS = 0x01n;
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
 * taker and recipient are the router so execution and settlement stay on-contract for post-fee.
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
  console.log(`Flags:         0x${FLAGS.toString(16)} (post-fee, returndata)`);
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

  const approvalSpender = ALLOWANCE_HOLDER;

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);

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
    `Polygon AAVE → USDC — 0x postFee/returndata`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
  console.log(`\nUSDC is now in signer's wallet on Polygon.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
