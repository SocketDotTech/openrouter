/**
 * Route:  Polygon AAVE → USDC (0x v2 AllowanceHolder) — standalone swap, no bridge
 * Flags:  pre-fee (fee taken from AAVE input before swap), output read from swap returndata word 0
 *
 * Pre-fee (bit0=0): feeAmount = FEE_BPS of inputAmount AAVE, deducted before the swap.
 * Returndata (bit1=0): final USDC amount is read from word 0 of the swap call returndata.
 *
 * 0x: taker=router (AllowanceHolder entry), recipient=signer so output USDC goes to the user
 * while the router decodes `filledAmount` / return data per `returnDataWordOffset`.
 *
 * Quote uses swapInput (inputAmount − preFeeAmount) so calldata matches execution.
 *
 * USDC lands in signer's wallet on Polygon.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ZEROX_API_KEY=... ts-node scripts/e2e/swap/zerox.preFee.returndata.ts
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
  ALLOWANCE_HOLDER,
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

// pre-fee (0x00) | returndata (no 0x02)
const FLAGS = 0x00n;
const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);
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
 * taker=router, recipient=user so bought USDC is delivered to the user (pre-fee + returndata).
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

  // pre-fee: deduct from input AAVE before the swap
  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const swapInput = inputAmount - feeAmount;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Flags:         0x${FLAGS.toString(16)} (pre-fee, returndata)`);
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);
  console.log(
    `Pre-fee:       ${ethers.formatUnits(feeAmount, 18)} AAVE (${FEE_BPS} bps)`,
  );
  console.log(`Swap input:    ${ethers.formatUnits(swapInput, 18)} AAVE`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log("Fetching 0x quote (AAVE → USDC)...");
  const { swapTarget, swapData, buyAmount, minBuyAmount, value } =
    await fetchZeroXQuote(
      swapInput,
      ROUTER_POLYGON,
      signerAddress,
      signerAddress,
    );

  console.log(`  0x target:   ${swapTarget}`);
  console.log(`  Est. USDC:   ${ethers.formatUnits(buyAmount, 6)}`);
  console.log(`  Min USDC:    ${ethers.formatUnits(minBuyAmount, 6)}`);

  const approvalSpender = ALLOWANCE_HOLDER;

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterApproval(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    approvalSpender,
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
      approvalSpender,
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
    `Polygon AAVE → USDC — 0x preFee/returndata`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
  console.log(`\nUSDC is now in signer's wallet on Polygon.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
