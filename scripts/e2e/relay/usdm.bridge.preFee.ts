/**
 * Route:  MegaETH USDM → Base USDC via Relay.link (no swap)
 * Function: bridge (simple bridge entrypoint)
 * Fee: preFee — FEE_BPS of inputAmount USDM deducted before bridge
 *
 * Matches Relay UI:
 *   https://relay.link/bridge/base?fromChainId=4326
 *   &fromCurrency=0xfafddbb3fc7688494971a79cc65dca3ef82079e7
 *   &toCurrency=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/relay/usdm.bridge.preFee.ts
 *
 * Optional: INPUT_AMOUNT=<wei> to bridge a fixed USDM amount instead of wallet balance minus dust.
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

const ROUTER_MEGAETH = routerAddressForChain(CHAIN_IDS.MEGAETH);
const USDM_DECIMALS = 18;
/** Leave 0.01 USDM in wallet for dust / rounding. */
const BALANCE_DUST_WEI = 10n ** 16n;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.MEGAETH);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.USDM_MEGAETH;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero USDM on MegaETH`);
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
  console.log(`Router:          ${ROUTER_MEGAETH}`);
  console.log(`USDM balance:    ${ethers.formatUnits(walletBalance, USDM_DECIMALS)}`);
  console.log(`Input amount:    ${ethers.formatUnits(inputAmount, USDM_DECIMALS)} USDM`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, USDM_DECIMALS)} USDM (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, USDM_DECIMALS)} USDM → Base USDC`);

  console.log('Fetching Relay.link quote (MegaETH USDM → Base USDC)...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_MEGAETH,
    recipient: signerAddress,
    originChainId: CHAIN_IDS.MEGAETH,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.USDM_MEGAETH,
    destinationCurrency: TOKENS.USDC_BASE,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_MEGAETH);

  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_MEGAETH,
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
    ROUTER_MEGAETH,
    inputToken,
    inputAmount,
    ROUTER_MEGAETH,
    execCalldata,
  );

  logTxnSummary('MegaETH USDM → Base USDC — Relay — bridge preFee', CHAIN_IDS.MEGAETH, receipt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
