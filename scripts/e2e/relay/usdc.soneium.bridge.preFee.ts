/**
 * Route:  Soneium bridged USDC → Base USDC via Relay.link (no on-router swap)
 * Function: bridge (simple bridge entrypoint)
 * Fee: preFee — FEE_BPS of inputAmount USDC deducted before bridge
 *
 * Matches Relay UI:
 *   https://relay.link/bridge/base?fromChainId=1868
 *   &fromCurrency=0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369
 *   &toCurrency=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/relay/usdc.soneium.bridge.preFee.ts
 *
 * Optional: INPUT_AMOUNT=<wei> to bridge a fixed USDC amount instead of wallet balance minus dust.
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

const ROUTER_SONEIUM = routerAddressForChain(CHAIN_IDS.SONEIUM);
const USDC_DECIMALS = 6;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.SONEIUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.USDC_SONEIUM;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero bridged USDC on Soneium`);
  }

  const inputAmountOverride = process.env.INPUT_AMOUNT?.trim();
  let inputAmount: bigint;
  if (inputAmountOverride) {
    inputAmount = BigInt(inputAmountOverride);
    if (inputAmount > walletBalance) {
      throw new Error(`INPUT_AMOUNT ${inputAmount} exceeds wallet balance ${walletBalance}`);
    }
  } else {
    inputAmount = walletBalance - 20n;
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
  console.log(`Router:          ${ROUTER_SONEIUM}`);
  console.log(`USDC balance:    ${ethers.formatUnits(walletBalance, USDC_DECIMALS)}`);
  console.log(`Input amount:    ${ethers.formatUnits(inputAmount, USDC_DECIMALS)} USDC`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, USDC_DECIMALS)} USDC (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, USDC_DECIMALS)} USDC → Base USDC`);

  console.log('Fetching Relay.link quote (Soneium USDC → Base USDC)...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_SONEIUM,
    recipient: signerAddress,
    originChainId: CHAIN_IDS.SONEIUM,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.USDC_SONEIUM,
    destinationCurrency: TOKENS.USDC_BASE,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_SONEIUM);

  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_SONEIUM,
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
    ROUTER_SONEIUM,
    inputToken,
    inputAmount,
    ROUTER_SONEIUM,
    execCalldata,
  );

  logTxnSummary('Soneium USDC → Base USDC — Relay — bridge preFee', CHAIN_IDS.SONEIUM, receipt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
