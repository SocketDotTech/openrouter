/**
 * Script 1 — Bridge AAVE (Arbitrum) → PEPE (Base) via Relay.link
 *
 * Flow:
 *   1. Fetch a Relay.link /quote/v2 for AAVE→PEPE cross-chain swap.
 *      The quote is requested for (inputAmount - feeAmount) to account for the
 *      pre-bridge fee we take first.
 *   2. Parse the approve step to extract the Relay spender address.
 *   3. Build either a monolithic or modular execution payload (controlled by
 *      USE_MODULAR env var).
 *   4. Call AllowanceHolder.exec → router.performExecution / performModularExecution.
 *
 * The script spends the signer’s full on-chain balance of AAVE on Arbitrum as the input amount (fund the wallet and approve AH as needed).
 *
 * Usage:
 *   ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelay.ts
 *   USE_MODULAR=true ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelay.ts
 *
 * Notes on the Relay.link quote API:
 *   - steps[0] is an ERC-20 approve (or absent for native input).
 *     The approve spender can be decoded from steps[0].items[0].data.data bytes 16..36.
 *   - steps[1] is the actual deposit call: steps[1].items[0].data.{ to, data }.
 *   - Relay quotes EXACT_INPUT so the amount in the deposit calldata is already
 *     correct for the quoted amount; we do NOT splice it at runtime.
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  ROUTER_ADDRESS,
  TOKENS,
  FEE_BPS,
  bpsOf,
  RPC,
  RELAY_API_KEY,
  ALLOWANCE_HOLDER,
} from './config';
import { execViaAH } from './utils/allowanceHolder';
import { encodeApprove, encodeTransfer, getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import {
  MonolithicExecution,
  Action,
  CallType,
  NO_FEE,
  NO_SWAP,
  ZERO_ADDRESS,
} from './utils/contractTypes';

// ─── Relay.link quote ─────────────────────────────────────────────────────────

interface RelayStep {
  items: Array<{
    data: {
      to?: string;
      data?: string;
    };
  }>;
}

interface RelayQuoteResponse {
  steps: RelayStep[];
}

/**
 * Fetches a cross-chain quote from Relay.link for AAVE→PEPE.
 *
 * @param routerAddress  The router contract (= the "user" that sends the deposit)
 * @param recipient      The final recipient on Base (signer's EOA)
 * @param amount         Net amount after fee, in AAVE wei
 */
async function fetchRelayQuote(
  routerAddress: string,
  recipient: string,
  amount: bigint,
): Promise<RelayQuoteResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (RELAY_API_KEY) {
    headers['x-api-key'] = RELAY_API_KEY;
  }

  const body = {
    user: routerAddress,
    recipient,
    originChainId: CHAIN_IDS.ARBITRUM,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.AAVE_ARB,
    destinationCurrency: TOKENS.AAVE_BASE,
    tradeType: 'EXACT_INPUT',
    amount: amount.toString(),
  };

  const response = await axios.post<RelayQuoteResponse>(
    'https://api.relay.link/quote/v2',
    body,
    { headers },
  );
  return response.data;
}

/**
 * Parses the Relay.link quote to extract:
 *  - relaySpender: the address that needs ERC-20 approval (from approve step calldata)
 *  - depositTarget: the contract to call with depositData
 *  - depositData: the calldata for the deposit call
 */
function parseRelayQuote(quote: RelayQuoteResponse): {
  relaySpender: string;
  depositTarget: string;
  depositData: string;
} {
  const approveIface = new ethers.Interface([
    'function approve(address spender, uint256 amount) external returns (bool)',
  ]);

  const approveStep = quote.steps[0];
  const approveDataHex = approveStep.items[0].data.data ?? '';
  let relaySpender: string;
  try {
    relaySpender = ethers.getAddress(
      approveIface.decodeFunctionData('approve', approveDataHex)[0],
    );
  } catch {
    /** Some routes use Permit2 signatures instead of naked approve; spender may still appear in abi.encode-like layout. Fallback: last 20 bytes of first argument word. */
    const normalized = approveDataHex.startsWith('0x') ? approveDataHex.slice(2) : approveDataHex;
    if (normalized.length < 8 + 64) {
      throw new Error('Relay approve step calldata too short for fallback spender parse');
    }
    const spender40 = normalized.slice(8 + 24, 8 + 24 + 40);

    relaySpender = ethers.getAddress('0x' + spender40);
  }

  const depositStep = quote.steps[1];
  const depositItem = depositStep.items[0].data;
  const depositTarget = depositItem.to ?? '';
  const depositData = depositItem.data ?? '0x';

  return { relaySpender, depositTarget, depositData };
}

// ─── Monolithic builder ───────────────────────────────────────────────────────

/**
 * Builds a MonolithicExecution that:
 *  - Pulls inputAmount of AAVE from user via AH
 *  - Sends feeAmount of AAVE to signer as pre-bridge fee
 *  - Approves Relay spender for (inputAmount - feeAmount)
 *  - Calls Relay deposit target with deposit calldata (amount already correct in calldata)
 */
function buildMonolithicExecution(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  relaySpender: string,
  depositTarget: string,
  depositData: string,
): MonolithicExecution {
  return {
    input: {
      user: signerAddress,
      inputToken: TOKENS.AAVE_ARB,
      inputAmount,
    },
    preFee: {
      receiver: signerAddress,
      amount: feeAmount,
    },
    swap: NO_SWAP,
    postFee: NO_FEE,
    bridge: {
      target: depositTarget,
      approvalSpender: relaySpender,
      value: 0n,
      data: depositData,
      amountPositions: [], // Relay calldata is already for the correct amount
      useFinalAmountAsValue: false,
    },
  };
}

// ─── Modular builder ──────────────────────────────────────────────────────────

/**
 * Builds an Action array that achieves the same flow as monolithic but
 * as discrete steps:
 *   [0] Pull AAVE from user via AH.transferFrom (AH already has allowance)
 *   [1] Transfer feeAmount AAVE to signer (pre-bridge fee)
 *   [2] Approve Relay spender for bridgeAmount AAVE
 *   [3] Call Relay deposit
 *
 * Note: In the modular path the router calls AH.transferFrom directly as an
 * action, since AH has the transient allowance granted by AH.exec() on entry.
 * AH.transferFrom selector: 0x15dacbea (address token, address owner, address recipient, uint256 amount)
 */
function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  bridgeAmount: bigint,
  relaySpender: string,
  depositTarget: string,
  depositData: string,
): Action[] {
  // AH.transferFrom(token, owner, recipient, amount) = 0x15dacbea
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.AAVE_ARB,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  return [
    // 0: pull AAVE from user via AllowanceHolder.transferFrom
    {
      callType: CallType.CALL,
      target: ALLOWANCE_HOLDER,
      value: 0n,
      data: ahTransferFromData,
      splices: [],
    },
    // 1: send pre-bridge fee to signer in AAVE
    {
      callType: CallType.CALL,
      target: TOKENS.AAVE_ARB,
      value: 0n,
      data: encodeTransfer(signerAddress, feeAmount),
      splices: [],
    },
    // 2: approve Relay spender for bridgeAmount
    {
      callType: CallType.CALL,
      target: TOKENS.AAVE_ARB,
      value: 0n,
      data: encodeApprove(relaySpender, bridgeAmount),
      splices: [],
    },
    // 3: call Relay deposit — amount already encoded in depositData
    {
      callType: CallType.CALL,
      target: depositTarget,
      value: 0n,
      data: depositData,
      splices: [],
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.ARBITRUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.AAVE_ARB;
  const { balance: inputAmount, decimals: inputDecimals } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (inputAmount === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero balance of ${inputToken}. Fund the wallet with AAVE on Arbitrum first.`,
    );
  }
  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  const useModular = false;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ADDRESS}`);
  console.log(`Input token:   ${inputToken}`);
  console.log(`Input amount:  ${ethers.formatUnits(inputAmount, inputDecimals)} (full wallet balance)`);
  console.log(
    `Fee amount:    ${ethers.formatUnits(feeAmount, inputDecimals)} (${FEE_BPS} bps)`,
  );
  console.log(`Bridge amount: ${ethers.formatUnits(bridgeAmount, inputDecimals)}`);
  console.log(`Mode:          ${useModular ? 'MODULAR' : 'MONOLITHIC'}`);
  console.log('');

  // Fetch Relay.link quote for bridgeAmount
  console.log('Fetching Relay.link quote...');
  const quote = await fetchRelayQuote(
    ROUTER_ADDRESS,
    signerAddress,
    bridgeAmount,
  );
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);
  console.log('');

  const routerIface = new ethers.Interface(ROUTER_ABI);
  let execCalldata: string;

  if (useModular) {
    const actions = buildModularActions(
      signerAddress,
      ROUTER_ADDRESS,
      inputAmount,
      feeAmount,
      bridgeAmount,
      relaySpender,
      depositTarget,
      depositData,
    );
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [
      actions,
    ]);
    console.log('Using performModularExecution');
  } else {
    const exec = buildMonolithicExecution(
      signerAddress,
      inputAmount,
      feeAmount,
      relaySpender,
      depositTarget,
      depositData,
    );
    execCalldata = routerIface.encodeFunctionData('performExecution', [exec]);
    console.log('Using performExecution (monolithic)');
  }

  console.log('Sending AllowanceHolder.exec transaction...');
  const receipt = await execViaAH(
    signer,
    ROUTER_ADDRESS, // operator
    TOKENS.AAVE_ARB, // token to grant allowance for
    inputAmount, // amount
    ROUTER_ADDRESS, // target (the router)
    execCalldata,
  );

  console.log(`\nSuccess! Gas used: ${receipt.gasUsed.toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
