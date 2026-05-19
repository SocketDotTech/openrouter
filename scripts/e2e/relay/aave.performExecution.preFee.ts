/**
 * Route:  Polygon AAVE → Base AAVE via Relay.link (no swap)
 * Function: bridge
 * Fee: preFee — FEE_BPS of inputAmount AAVE deducted before bridge
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/relay/aave.performExecution.preFee.ts
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
import { ZERO_BYTES32, bridgeArgs, type BridgeData, type FeeData, type InputData } from '../utils/contractTypes';
import { fetchRelayQuoteV2, parseRelayQuote } from '../utils/relayLinkQuote';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterApproval } from '../utils/reproducibility';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.AAVE_POLYGON;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero AAVE on Polygon`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_POLYGON}`);
  console.log(`AAVE balance:    ${ethers.formatUnits(walletBalance, 18)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, 18)} AAVE (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, 18)}`);

  console.log('Fetching Relay.link quote...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_POLYGON,
    recipient: signerAddress,
    originChainId: CHAIN_IDS.POLYGON,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.AAVE_POLYGON,
    destinationCurrency: TOKENS.AAVE_BASE,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, inputToken, relaySpender);

  const input: InputData = { user: signerAddress, inputToken, inputAmount };
  const fee: FeeData = { receiver: signerAddress, amount: feeAmount };
  const bridgeData: BridgeData = { target: depositTarget, approvalSpender: relaySpender, value: 0n };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const execCalldata = routerIface.encodeFunctionData('bridge', bridgeArgs(ZERO_BYTES32, input, fee, bridgeData, depositData));

  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.bridge...');
  const receipt = await execViaAH(signer, ROUTER_POLYGON, inputToken, inputAmount, ROUTER_POLYGON, execCalldata);

  logTxnSummary('Polygon AAVE → Base AAVE — Relay — bridge preFee', CHAIN_IDS.POLYGON, receipt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
