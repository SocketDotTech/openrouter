/**
 * Route:  Polygon USDC → Base USDC (CCTP v2, no swap)
 * Function: bridge (simple bridge entrypoint)
 * Fee: preFee — FEE_BPS of inputAmount USDC deducted before bridge
 *
 * Bridge amount is pre-encoded in depositForBurn calldata (no splice needed).
 * Uses router.bridge() rather than performExecution / performActions.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/cctp/bridge.preFee.ts
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
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ZERO_BYTES32, type BridgeData, type FeeData, type InputData } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance } from '../utils/reproducibility';
import { resolveApprovalSpender } from '../utils/routerAllowance';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

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
    throw new Error(`Signer ${signerAddress} has zero Circle native USDC on Polygon. Fund ${inputToken} on Polygon PoS.`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_POLYGON}`);
  console.log(`Input USDC:      ${ethers.formatUnits(inputAmount, 6)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, 6)}`);

  const depositData = buildDepositForBurnCalldata(
    signerAddress,
    polyCctp.usdcAddress,
    baseCctp.cctpDomain,
    bridgeAmount,
  );

  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_POLYGON,
    inputToken,
    polyCctp.tokenMessenger,
    bridgeAmount,
  );

  const input: InputData = { user: signerAddress, inputToken, inputAmount };
  const fee: FeeData = { receiver: signerAddress, amount: feeAmount };
  const bridgeData: BridgeData = { target: polyCctp.tokenMessenger, approvalSpender: bridgeApprovalSpender, value: 0n };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const execCalldata = routerIface.encodeFunctionData('bridge', [ZERO_BYTES32, input, fee, bridgeData, depositData]);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_POLYGON);
  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.bridge...');
  const receipt = await execViaAH(signer, ROUTER_POLYGON, inputToken, inputAmount, ROUTER_POLYGON, execCalldata);

  logTxnSummary('Polygon USDC → Base USDC — CCTP — bridge preFee', CHAIN_IDS.POLYGON, receipt);

  console.log(`\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
