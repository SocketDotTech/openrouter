/**
 * Polygon native USDC → Base USDC via CCTP v2 using `router.bridge(...)`.
 *
 * Same burn token / TokenMessenger constraints as {@link swapBridgeViaCctp}:
 * use Circle’s native Polygon USDC (`USDC_POLYGON_CIRCLE`); bridged USDC.e is unsupported.
 *
 * Unlike the monolithic/modular paths in `swapBridgeViaCctp.ts`, this script:
 *   – only supports USDC-in (no OpenOcean AAVE→USDC swap);
 *   – encodes the net `depositForBurn` amount in calldata up front (no splice);
 *   – uses a single `bridge` entrypoint per run (full wallet balance by default).
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaCctpSimple.ts
 *
 * No pre-bridge fee:
 *   FEE_AMOUNT_BPS=0 PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaCctpSimple.ts
 *
 * Router: {@link ROUTER_BY_CHAIN_ID} / `routerAddressForChain(137)` in config.ts.
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  CCTP_CONFIG,
  FEE_BPS,
  bpsOf,
  RPC,
} from './config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from './utils/allowanceHolder';
import { getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import type { BridgeData, FeeData, InputData } from './utils/contractTypes';
import { logTxnSummary } from './utils/txnLogSummary';
import {
  ensureRouterErc20Balance,
  ensureRouterApproval,
} from './utils/reproducibility';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

/**
 * CCTP `depositForBurn` with explicit burn amount (net after optional fee).
 */
function buildDepositForBurnCalldata(
  recipientAddress: string,
  burnToken: string,
  destinationCctpDomain: number,
  amount: bigint,
  fastPath: boolean = true,
): string {
  const iface = new ethers.Interface([
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
  ]);

  const mintRecipient = ethers.zeroPadValue(recipientAddress, 32);
  const maxFee = fastPath ? 1_000_000n : 0n;
  const minFinalityThreshold = fastPath ? 1000 : 2000;

  return iface.encodeFunctionData('depositForBurn', [
    amount,
    destinationCctpDomain,
    mintRecipient,
    burnToken,
    ethers.ZeroHash,
    maxFee,
    minFinalityThreshold,
  ]);
}

function buildBridgeCalldata(
  routerIface: ethers.Interface,
  args: {
    signerAddress: string;
    inputToken: string;
    inputAmount: bigint;
    fee: FeeData;
    tokenMessenger: string;
    depositData: string;
  },
): string {
  const input: InputData = {
    user: args.signerAddress,
    inputToken: args.inputToken,
    inputAmount: args.inputAmount,
  };

  const bridgeData: BridgeData = {
    target: args.tokenMessenger,
    approvalSpender: args.tokenMessenger,
    value: 0n,
  };

  return routerIface.encodeFunctionData('bridge', [
    input,
    args.fee,
    bridgeData,
    args.depositData,
  ]);
}

async function main(): Promise<void> {
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
      `Signer ${signerAddress} has zero Circle native USDC on Polygon. Fund ${inputToken} on Polygon PoS.`,
    );
  }

  const inputAmount = walletBalance - 20n;
  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_POLYGON}`);
  console.log(`Input USDC:      ${ethers.formatUnits(inputAmount, 6)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, 6)}`);
  console.log(`TokenMessenger:  ${polyCctp.tokenMessenger}`);
  console.log(`Burn token:      ${polyCctp.usdcAddress}`);

  const depositData = buildDepositForBurnCalldata(
    signerAddress,
    polyCctp.usdcAddress,
    baseCctp.cctpDomain,
    bridgeAmount,
    true,
  );

  const fee: FeeData = { receiver: signerAddress, amount: feeAmount };
  const routerIface = new ethers.Interface(ROUTER_ABI);
  const execCalldata = buildBridgeCalldata(routerIface, {
    signerAddress,
    inputToken,
    inputAmount,
    fee,
    tokenMessenger: polyCctp.tokenMessenger,
    depositData,
  });

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, inputToken, polyCctp.tokenMessenger);
  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.bridge...');
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    inputToken,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
  );

  logTxnSummary(
    'Polygon USDC → Base USDC — CCTP — Simple bridge',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log(
    `\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
