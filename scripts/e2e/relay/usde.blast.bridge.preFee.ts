/**
 * Route:  Blast USDe → Base USDC via Relay.link (no on-router swap)
 * Function: bridge (simple bridge entrypoint)
 * Fee: preFee — FEE_BPS of inputAmount USDe deducted before bridge
 *
 * Matches Relay UI:
 *   https://relay.link/bridge/base?fromChainId=81457
 *   &fromCurrency=0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34
 *   &toCurrency=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/relay/usde.blast.bridge.preFee.ts
 *
 * Optional: INPUT_AMOUNT=<wei> to bridge a fixed USDe amount instead of wallet balance minus dust.
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

const ROUTER_BLAST = routerAddressForChain(CHAIN_IDS.BLAST);
const USDE_DECIMALS = 18;
/** Leave 0.01 USDe in wallet for dust / rounding. */
const BALANCE_DUST_WEI = 10n ** 16n;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.BLAST);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.USDE_BLAST;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero USDe on Blast`);
  }

  const inputAmountOverride = process.env.INPUT_AMOUNT?.trim();
  let inputAmount: bigint;
  if (inputAmountOverride) {
    inputAmount = BigInt(inputAmountOverride);
    if (inputAmount > walletBalance) {
      throw new Error(`INPUT_AMOUNT ${inputAmount} exceeds wallet balance ${walletBalance}`);
    }
  } else {
    inputAmount = walletBalance - BALANCE_DUST_WEI;
    if (inputAmount <= 0n) {
      throw new Error('Balance too small after dust reserve');
    }
  }

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;
  if (bridgeAmount <= 0n) {
    throw new Error('Bridge amount must be positive after fee');
  }

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_BLAST}`);
  console.log(`USDe balance:    ${ethers.formatUnits(walletBalance, USDE_DECIMALS)}`);
  console.log(`Input amount:    ${ethers.formatUnits(inputAmount, USDE_DECIMALS)} USDe`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, USDE_DECIMALS)} USDe (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, USDE_DECIMALS)} USDe → Base USDC`);

  console.log('Fetching Relay.link quote (Blast USDe → Base USDC)...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_BLAST,
    recipient: signerAddress,
    originChainId: CHAIN_IDS.BLAST,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.USDE_BLAST,
    destinationCurrency: TOKENS.USDC_BASE,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_BLAST);

  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_BLAST,
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
  const receipt = await execViaAH(
    signer,
    ROUTER_BLAST,
    inputToken,
    inputAmount,
    ROUTER_BLAST,
    execCalldata,
  );

  logTxnSummary('Blast USDe → Base USDC — Relay — bridge preFee', CHAIN_IDS.BLAST, receipt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
