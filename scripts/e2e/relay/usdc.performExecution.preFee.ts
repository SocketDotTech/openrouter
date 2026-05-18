/**
 * Route:  Polygon USDC → Base USDC via Relay.link (no swap)
 * Function: performExecution (monolithic)
 * Fee: preFee — FEE_BPS of inputAmount USDC deducted before bridge
 *
 * Fetches a Relay.link /quote/v2 for the net bridge amount, then encodes a
 * MonolithicExecutionCall with preFee and the deposit calldata.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/relay/usdc.performExecution.preFee.ts
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
import {
  MonolithicExecutionCall,
  NO_FEE,
  NO_SWAP,
  ZERO_BYTES32,
  monolithicArgs,
} from '../utils/contractTypes';
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

  const inputToken = TOKENS.USDC_POLYGON_CIRCLE;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero Circle native USDC on Polygon`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_POLYGON}`);
  console.log(`USDC balance:    ${ethers.formatUnits(walletBalance, 6)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, 6)}`);

  console.log('Fetching Relay.link quote...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_POLYGON,
    recipient: signerAddress,
    originChainId: CHAIN_IDS.POLYGON,
    destinationChainId: CHAIN_IDS.BASE,
    originCurrency: TOKENS.USDC_POLYGON_CIRCLE,
    destinationCurrency: TOKENS.USDC_BASE,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, inputToken, relaySpender);

  const mono: MonolithicExecutionCall = {
    exec: {
      input: { user: signerAddress, inputToken, inputAmount },
      preFee: { receiver: signerAddress, amount: feeAmount },
      swap: NO_SWAP,
      postFee: NO_FEE,
      bridge: { target: depositTarget, approvalSpender: relaySpender, value: 0n },
      flags: 0n,
    },
    swapCallData: '0x',
    bridgeCallData: depositData,
  };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const execCalldata = routerIface.encodeFunctionData('performExecution', monolithicArgs(mono, ZERO_BYTES32));

  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.performExecution...');
  const receipt = await execViaAH(signer, ROUTER_POLYGON, inputToken, inputAmount, ROUTER_POLYGON, execCalldata);

  logTxnSummary('Polygon USDC → Base USDC — Relay — performExecution preFee', CHAIN_IDS.POLYGON, receipt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
