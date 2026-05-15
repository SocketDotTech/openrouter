/**
 * Script — Bridge AAVE (Polygon PoS) → AAVE (Base) via Relay.link
 *          using the `bridge(InputData, bytes feeBytes, BridgeData)` entrypoint.
 *
 * Flow:
 *   1. Read signer's Polygon AAVE (or USDC) balance.
 *   2. Compute fee via FEE_BPS; encode as 64-byte ABI word-pair (receiver, amount).
 *      If FEE_AMOUNT_BPS=0, feeBytes is `0x` and the contract skips the fee entirely.
 *   3. Fetch Relay.link /quote/v2 for the net bridge amount (inputAmount − fee).
 *   4. AllowanceHolder.exec → router.bridge(input, feeBytes, bridgeData).
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelaySimple.ts
 *
 *   USDC path (Polygon Circle USDC → Base USDC):
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelaySimple.ts usdc
 *
 *   No fee:
 *   FEE_AMOUNT_BPS=0 PRIVATE_KEY=0x... ts-node scripts/e2e/bridgeViaRelaySimple.ts
 *
 * Router addresses: {@link ROUTER_BY_CHAIN_ID} / `routerAddressForChain` in config.ts.
 * Override with `ROUTER_CHAIN_137` or legacy `ROUTER_ADDRESS` if needed.
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
} from './config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from './utils/allowanceHolder';
import { getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import type { InputData, StaticBridgeData } from './utils/contractTypes';
import { fetchRelayQuoteV2, parseRelayQuote } from './utils/relayLinkQuote';
import { logTxnSummary } from './utils/txnLogSummary';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

// ─── feeBytes encoding ────────────────────────────────────────────────────────

/**
 * Encode fee as the 64-byte ABI word-pair expected by the contract:
 *   abi.encode(address receiver, uint256 amount)
 * Returns `'0x'` when feeAmount is zero so the contract skips the transfer.
 */
function encodeFeeBytes(receiver: string, feeAmount: bigint): string {
  if (feeAmount === 0n) {
    return '0x';
  }
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [receiver, feeAmount],
  );
}

// ─── Execution builder ────────────────────────────────────────────────────────

interface BridgeParams {
  signerAddress: string;
  inputToken: string;
  inputAmount: bigint;
  feeBytes: string;
  relaySpender: string;
  depositTarget: string;
  /** Bridge calldata with finalAmount (= inputAmount - feeAmount) already encoded inside. */
  depositData: string;
}

function buildBridgeCalldata(routerIface: ethers.Interface, p: BridgeParams): string {
  const input: InputData = {
    user: p.signerAddress,
    inputToken: p.inputToken,
    inputAmount: p.inputAmount,
  };

  // No amountPositions or useFinalAmountAsValue — the caller bakes the net amount
  // directly into depositData before calling.
  const bridgeData: StaticBridgeData = {
    target: p.depositTarget,
    approvalSpender: p.relaySpender,
    value: 0n,
    data: p.depositData,
  };

  return routerIface.encodeFunctionData('bridge', [input, p.feeBytes, bridgeData]);
}

// ─── Execution leg ────────────────────────────────────────────────────────────

interface LegConfig {
  label: string;
  inputToken: string;
  decimals: number;
  symbol: string;
  originChainId: number;
  destinationChainId: number;
  destinationCurrency: string;
}

async function executeLeg(args: {
  config: LegConfig;
  signer: ethers.Wallet;
  signerAddress: string;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const { config, signer, signerAddress, inputAmount, routerIface } = args;

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  const fmt = (n: bigint) => ethers.formatUnits(n, config.decimals);

  console.log(`\n── ${config.label} ──`);
  console.log(`Input:           ${fmt(inputAmount)} ${config.symbol}`);
  console.log(`Fee (${FEE_BPS} bps):    ${fmt(feeAmount)} ${config.symbol}`);
  console.log(`Bridge amount:   ${fmt(bridgeAmount)} ${config.symbol}`);

  // feeBytes: `0x` if no fee, else abi-encoded (receiver=signer, amount)
  const feeBytes = encodeFeeBytes(signerAddress, feeAmount);
  console.log(`feeBytes:        ${feeBytes === '0x' ? '0x (no fee)' : `${feeBytes.slice(0, 18)}… (${feeBytes.length / 2 - 1} bytes)`}`);

  console.log('Fetching Relay.link quote...');
  const quote = await fetchRelayQuoteV2({
    routerAddress: ROUTER_POLYGON,
    recipient: signerAddress,
    originChainId: config.originChainId,
    destinationChainId: config.destinationChainId,
    originCurrency: config.inputToken,
    destinationCurrency: config.destinationCurrency,
    amount: bridgeAmount,
  });
  const { relaySpender, depositTarget, depositData } = parseRelayQuote(quote);
  console.log(`Relay spender:   ${relaySpender}`);
  console.log(`Deposit target:  ${depositTarget}`);

  const execCalldata = buildBridgeCalldata(routerIface, {
    signerAddress,
    inputToken: config.inputToken,
    inputAmount,
    feeBytes,
    relaySpender,
    depositTarget,
    depositData,
  });

  await ensureAllowanceForAllowanceHolder(signer, config.inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.bridge...');
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    config.inputToken,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
  );

  logTxnSummary(config.label, config.originChainId, receipt);
}

// ─── Entry points ─────────────────────────────────────────────────────────────

async function run(useUsdc: boolean): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const legConfig: LegConfig = useUsdc
    ? {
        label: 'Polygon USDC → Base USDC — Relay — Simple Bridge',
        inputToken: TOKENS.USDC_POLYGON_CIRCLE,
        decimals: 6,
        symbol: 'USDC',
        originChainId: CHAIN_IDS.POLYGON,
        destinationChainId: CHAIN_IDS.BASE,
        destinationCurrency: TOKENS.USDC_BASE,
      }
    : {
        label: 'Polygon AAVE → Base AAVE — Relay — Simple Bridge',
        inputToken: TOKENS.AAVE_POLYGON,
        decimals: 18,
        symbol: 'AAVE',
        originChainId: CHAIN_IDS.POLYGON,
        destinationChainId: CHAIN_IDS.BASE,
        destinationCurrency: TOKENS.AAVE_BASE,
      };

  const { balance: walletBalance } = await getWalletErc20Balance(
    legConfig.inputToken,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero balance of ${legConfig.inputToken}. Fund the wallet first.`,
    );
  }

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Input token:   ${legConfig.inputToken}`);
  console.log(
    `Balance:       ${ethers.formatUnits(walletBalance, legConfig.decimals)} ${legConfig.symbol}`,
  );

  const routerIface = new ethers.Interface(ROUTER_ABI);

  await executeLeg({
    config: legConfig,
    signer,
    signerAddress,
    inputAmount: walletBalance,
    routerIface,
  });

  console.log('\nDone.');
}

async function main(): Promise<void> {
  const arg = process.argv[2]?.toLowerCase();
  const useUsdc = arg === 'usdc' || arg === 'usdc-polygon-base';
  await run(useUsdc);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
