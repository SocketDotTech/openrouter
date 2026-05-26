/**
 * Route:  Mantle ENA → Base AAVE via Relay.link (no swap)
 * Function: bridge (simple bridge entrypoint)
 * Fee: preFee — FEE_BPS of inputAmount ENA deducted before bridge
 *
 * Bridge amount is pre-encoded in Relay deposit calldata.
 * Uses router.bridge() rather than performExecution / performActions.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/relay/ena.bridge.preFee.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  FEE_BPS,
  bpsOf,
  RPC,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ZERO_BYTES32, type BridgeData, type FeeData, type InputData } from '../utils/contractTypes';
import { fetchRelayQuoteV2, parseRelayQuote } from '../utils/relayLinkQuote';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance } from '../utils/reproducibility';
import { resolveApprovalSpender } from '../utils/routerAllowance';

const ROUTER_MANTLE = routerAddressForChain(CHAIN_IDS.MANTLE);
const ENA_DECIMALS = 18;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.MANTLE);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.ENA_MANTLE;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero ENA on Mantle`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) {
    throw new Error('Balance too small');
  }

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_MANTLE}`);
  console.log(`ENA balance:     ${ethers.formatUnits(walletBalance, ENA_DECIMALS)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, ENA_DECIMALS)} ENA (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, ENA_DECIMALS)}`);

  console.log('Fetching Relay.link quote (Mantle ENA → Base AAVE)...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_MANTLE,
    recipient: signerAddress,
    originChainId: CHAIN_IDS.MANTLE,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.ENA_MANTLE,
    destinationCurrency: TOKENS.AAVE_BASE,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_MANTLE);

  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_MANTLE,
    inputToken,
    relaySpender,
    bridgeAmount,
  );

  const input: InputData = { user: signerAddress, inputToken, inputAmount };
  const fee: FeeData = { receiver: signerAddress, amount: feeAmount };
  const bridgeData: BridgeData = { target: depositTarget, approvalSpender: bridgeApprovalSpender, value: 0n };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const execCalldata = routerIface.encodeFunctionData('bridge', [ZERO_BYTES32, input, fee, bridgeData, depositData]);

  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.bridge...');
  const receipt = await execViaAH(signer, ROUTER_MANTLE, inputToken, inputAmount, ROUTER_MANTLE, execCalldata);

  logTxnSummary('Mantle ENA → Base AAVE — Relay — bridge preFee', CHAIN_IDS.MANTLE, receipt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
