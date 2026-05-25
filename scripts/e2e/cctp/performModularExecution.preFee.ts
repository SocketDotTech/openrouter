/**
 * Route:  Polygon USDC → Base USDC (CCTP depositForBurn, no swap)
 * Function: performActions (modular)
 * Fee: preFee — FEE_BPS of inputAmount USDC transferred to signer before bridge
 *
 * Modular action sequence:
 *   [0] AH.transferFrom(USDC, signer, router, inputAmount)
 *   [1] USDC.transfer(signer, feeAmount)  — pre-bridge fee
 *   [2] USDC.approve(tokenMessenger, MaxUint256)
 *   [3] STATICCALL USDC.balanceOf(router)
 *   [4] tokenMessenger.depositForBurn(...)  — spliceArg(0) patches amount from [3]
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/cctp/performActions.preFee.ts
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
  ALLOWANCE_HOLDER,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { encodeTransfer, encodeBalanceOf, getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance } from '../utils/reproducibility';
import { modularApproveIfNeeded } from '../utils/routerAllowance';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

function buildDepositForBurnCalldata(
  recipientAddress: string,
  burnToken: string,
  destinationCctpDomain: number,
): string {
  const iface = new ethers.Interface([
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
  ]);
  return iface.encodeFunctionData('depositForBurn', [
    0n,
    destinationCctpDomain,
    ethers.zeroPadValue(recipientAddress, 32),
    burnToken,
    ethers.ZeroHash,
    1_000_000n,
    1000,
  ]);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY env var required');

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance } = await getWalletErc20Balance(TOKENS.USDC_POLYGON_CIRCLE, signerAddress, provider);
  if (walletBalance === 0n) throw new Error(`Signer ${signerAddress} has zero Circle native USDC on Polygon`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`USDC balance:  ${ethers.formatUnits(walletBalance, 6)}`);
  console.log(`Pre-fee:       ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`);
  console.log(`Net to bridge: ${ethers.formatUnits(inputAmount - feeAmount, 6)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];

  const depositForBurnData = buildDepositForBurnCalldata(signerAddress, polyCctp.usdcAddress, baseCctp.cctpDomain);

  await ensureRouterErc20Balance(signer, TOKENS.USDC_POLYGON_CIRCLE, ROUTER_POLYGON);

  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahIface.encodeFunctionData('transferFrom', [TOKENS.USDC_POLYGON_CIRCLE, signerAddress, ROUTER_POLYGON, inputAmount]));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeTransfer(signerAddress, feeAmount));
  await modularApproveIfNeeded(
    exec,
    provider,
    ROUTER_POLYGON,
    TOKENS.USDC_POLYGON_CIRCLE,
    polyCctp.tokenMessenger,
    bridgeAmount,
    ethers.MaxUint256,
  );
  const usdcBalance = exec.staticCall(TOKENS.USDC_POLYGON_CIRCLE, encodeBalanceOf(ROUTER_POLYGON));
  exec.call(polyCctp.tokenMessenger, depositForBurnData).spliceArg(0, usdcBalance.returnWord());

  const callData = routerIface.encodeFunctionData('performActions', [ZERO_BYTES32, exec.toActions()]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.USDC_POLYGON_CIRCLE, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, inputAmount, ROUTER_POLYGON, callData);

  logTxnSummary(
    'Polygon USDC → Base USDC (CCTP) — performActions preFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log(`\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
