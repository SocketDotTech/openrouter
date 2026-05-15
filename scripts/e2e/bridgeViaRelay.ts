/**
 * Script 1 — Bridge AAVE (Polygon PoS) → AAVE (Base) via Relay.link
 *
 * Flow:
 *   1. Spend half of the signer’s Polygon AAVE balance twice: first via
 *      performExecution (monolithic), then via performModularExecution, each leg
 *      using balance/2 of the initial snapshot.
 *   2. For each leg: Relay.link /quote/v2 for AAVE→AAVE cross-chain swap for the
 *      net relay amount (slice − feeAmount).
 *   3. Parse approve + deposit steps → build mono or modular payload.
 *   4. AllowanceHolder.exec → router.performExecution / performModularExecution.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelay.ts
 *   Polygon USDC (Circle) → Base USDC:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelay.ts usdc-polygon-base
 *
 * Router addresses: {@link ROUTER_BY_CHAIN_ID} / `routerAddressForChain` in config.ts.
 * Override Polygon with `ROUTER_CHAIN_137` or legacy `ROUTER_ADDRESS` if needed.
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
  ALLOWANCE_HOLDER,
} from './config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from './utils/allowanceHolder';
import {
  encodeApprove,
  encodeTransfer,
  getWalletErc20Balance,
} from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import type { ModularAction } from './utils/modularActionsBuilder/index';
import { MonolithicExecution, NO_FEE, NO_SWAP } from './utils/contractTypes';
import { fetchRelayQuoteV2, parseRelayQuote } from './utils/relayLinkQuote';
import { sleep } from './utils/sleep';
import { logTxnSummary } from './utils/txnLogSummary';
import {
  ensureRouterErc20Balance,
  ensureRouterApproval,
} from './utils/reproducibility';

/** Router on Polygon — quotes + modular recipient target must match executing chain deployment. */
const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

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
      inputToken: TOKENS.AAVE_POLYGON,
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
      amountPositions: [],
      useFinalAmountAsValue: false,
    },
  };
}

function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  bridgeAmount: bigint,
  relaySpender: string,
  depositTarget: string,
  depositData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.AAVE_POLYGON,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.AAVE_POLYGON, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.AAVE_POLYGON, encodeApprove(relaySpender, bridgeAmount));
  exec.call(depositTarget, depositData);
  return exec.toActions();
}

async function executeLeg(args: {
  label: string;
  useModular: boolean;
  signer: ethers.Wallet;
  signerAddress: string;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const { label, useModular, signer, signerAddress, inputAmount, routerIface } =
    args;

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`\n── ${label} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);
  console.log(`Input slice:    ${ethers.formatUnits(inputAmount, 18)} AAVE`);
  console.log(
    `Fee (pre-bridge): ${ethers.formatUnits(feeAmount, 18)} (${FEE_BPS} bps)`,
  );
  console.log(`Relay amount:    ${ethers.formatUnits(bridgeAmount, 18)}`);

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

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, relaySpender);

  let execCalldata: string;
  if (useModular) {
    const actions = buildModularActions(
      signerAddress,
      ROUTER_POLYGON,
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
  } else {
    const execPayload = buildMonolithicExecution(
      signerAddress,
      inputAmount,
      feeAmount,
      relaySpender,
      depositTarget,
      depositData,
    );
    execCalldata = routerIface.encodeFunctionData('performExecution', [
      execPayload,
    ]);
  }

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_POLYGON, inputAmount);

  console.log('Sending AllowanceHolder.exec...');
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
  );

  const modeLabel = useModular ? 'Modular' : 'Monolithic';
  logTxnSummary(
    `Polygon AAVE → Base AAVE — Relay — ${modeLabel}`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
}

function buildMonolithicExecutionUsdcPolygonToBase(
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
      inputToken: TOKENS.USDC_POLYGON_CIRCLE,
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
      amountPositions: [],
      useFinalAmountAsValue: false,
    },
  };
}

function buildModularActionsUsdcPolygonToBase(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  bridgeAmount: bigint,
  relaySpender: string,
  depositTarget: string,
  depositData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.USDC_POLYGON_CIRCLE,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeApprove(relaySpender, bridgeAmount));
  exec.call(depositTarget, depositData);
  return exec.toActions();
}

async function executeLegUsdcPolygonToBase(args: {
  label: string;
  useModular: boolean;
  signer: ethers.Wallet;
  signerAddress: string;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const { label, useModular, signer, signerAddress, inputAmount, routerIface } =
    args;

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`\n── ${label} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);
  console.log(`Input slice:    ${ethers.formatUnits(inputAmount, 6)} USDC`);
  console.log(
    `Fee (pre-bridge): ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`,
  );
  console.log(`Relay amount:    ${ethers.formatUnits(bridgeAmount, 6)}`);

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

  await ensureRouterErc20Balance(signer, TOKENS.USDC_POLYGON_CIRCLE, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, relaySpender);

  let execCalldata: string;
  if (useModular) {
    const actions = buildModularActionsUsdcPolygonToBase(
      signerAddress,
      ROUTER_POLYGON,
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
  } else {
    const execPayload = buildMonolithicExecutionUsdcPolygonToBase(
      signerAddress,
      inputAmount,
      feeAmount,
      relaySpender,
      depositTarget,
      depositData,
    );
    execCalldata = routerIface.encodeFunctionData('performExecution', [
      execPayload,
    ]);
  }

  await ensureAllowanceForAllowanceHolder(
    signer,
    TOKENS.USDC_POLYGON_CIRCLE,
    inputAmount,
  );

  console.log('Sending AllowanceHolder.exec...');
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.USDC_POLYGON_CIRCLE,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
  );

  const modeLabel = useModular ? 'Modular' : 'Monolithic';
  logTxnSummary(
    `Polygon USDC → Base USDC — Relay — ${modeLabel}`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
}

async function mainUsdcPolygonToBaseRelay() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.USDC_POLYGON_CIRCLE;
  const { balance: walletBalance } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero balance of ${inputToken}. Fund the wallet with Polygon native Circle USDC first.`,
    );
  }

  const legAmount = (walletBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error(
      `Wallet balance (${walletBalance}) is too small to split into two nonzero halves.`,
    );
  }

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Input token:   ${inputToken}`);
  console.log(`Full balance:  ${ethers.formatUnits(walletBalance, 6)} USDC`);
  console.log(
    `Per execution: ${ethers.formatUnits(legAmount, 6)} USDC (50% snapshots)`,
  );

  const routerIface = new ethers.Interface(ROUTER_ABI);

  await executeLegUsdcPolygonToBase({
    label: '1/2 Monolithic',
    useModular: false,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log('Sleeping ~3s before modular execution...');
  await sleep(3000);

  await executeLegUsdcPolygonToBase({
    label: '2/2 Modular',
    useModular: true,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log(
    '\nCompleted monolithic then modular executions (Relay Polygon USDC → Base USDC).',
  );
}

async function main() {
  const relayE2eCase = process.argv[2]?.toLowerCase();
  if (relayE2eCase === 'usdc-polygon-base' || relayE2eCase === 'usdc') {
    await mainUsdcPolygonToBaseRelay();
    return;
  }

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.AAVE_POLYGON;
  const { balance: walletBalance } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero balance of ${inputToken}. Fund the wallet with Polygon AAVE first.`,
    );
  }

  const legAmount = (walletBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error(
      `Wallet balance (${walletBalance}) is too small to split into two nonzero halves.`,
    );
  }

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Input token:   ${inputToken}`);
  console.log(`Full balance:  ${ethers.formatUnits(walletBalance, 18)} AAVE`);
  console.log(
    `Per execution: ${ethers.formatUnits(legAmount, 18)} AAVE (50% snapshots)`,
  );

  const routerIface = new ethers.Interface(ROUTER_ABI);

  await executeLeg({
    label: '1/2 Monolithic',
    useModular: false,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log('Sleeping ~3s before modular execution...');
  await sleep(3000);

  await executeLeg({
    label: '2/2 Modular',
    useModular: true,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log(
    '\nCompleted monolithic then modular executions (Relay Polygon → Base AAVE).',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
