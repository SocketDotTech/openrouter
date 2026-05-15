/**
 * Route:  Polygon AAVE → USDC (OpenOcean) → Base USDC (CCTP depositForBurn)
 * Function: performModularExecution (modular)
 * Fee: postFee — FEE_BPS of estimatedOut USDC transferred to signer after swap
 *
 * Modular action sequence:
 *   [0] AH.transferFrom(AAVE, signer, router, inputAmount)
 *   [1] AAVE.approve(ooRouter, inputAmount)
 *   [2] ooRouter swap calldata — AAVE → USDC lands in router
 *   [3] USDC.transfer(signer, feeAmount)  — post-swap fee
 *   [4] USDC.approve(tokenMessenger, MaxUint256)
 *   [5] STATICCALL USDC.balanceOf(router)
 *   [6] tokenMessenger.depositForBurn(...)  — spliceArg(0) patches amount from [5]
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/cctp/performModularExecution.postFee.ts
 */
import axios from 'axios';
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
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
  ALLOWANCE_HOLDER,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { encodeApprove, encodeTransfer, encodeBalanceOf, getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterApproval } from '../utils/reproducibility';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

interface OoQuoteResponse {
  data: { to: string; data: string; outAmount: string; minOutAmount: string };
}

async function fetchOpenOceanQuote(inputAmount: bigint): Promise<{
  ooRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.AAVE_POLYGON,
    outTokenAddress: TOKENS.USDC_POLYGON_CIRCLE,
    amount: ethers.formatUnits(inputAmount, 18),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_POLYGON,
    account: ROUTER_POLYGON,
    gasPrice: '1',
  };
  if (OPEN_OCEAN_API_KEY) params.apikey = OPEN_OCEAN_API_KEY;
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.POLYGON}/swap_quote`;
  const response = await axios.get<OoQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

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

  const { balance: walletBalance } = await getWalletErc20Balance(TOKENS.AAVE_POLYGON, signerAddress, provider);
  if (walletBalance === 0n) throw new Error(`Signer ${signerAddress} has zero AAVE on Polygon`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, 18)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];

  console.log('Fetching OpenOcean quote (AAVE → USDC)...');
  const { ooRouter, swapData, estimatedOut, minAmountOut } = await fetchOpenOceanQuote(inputAmount);
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`  OO router:   ${ooRouter}`);
  console.log(`  Est. USDC:   ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(`  Post-fee:    ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`);
  console.log(`  Min USDC:    ${ethers.formatUnits(minAmountOut, 6)}`);

  const depositForBurnData = buildDepositForBurnCalldata(signerAddress, polyCctp.usdcAddress, baseCctp.cctpDomain);

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(signer, TOKENS.USDC_POLYGON_CIRCLE, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, ooRouter);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, polyCctp.tokenMessenger);

  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahIface.encodeFunctionData('transferFrom', [TOKENS.AAVE_POLYGON, signerAddress, ROUTER_POLYGON, inputAmount]));
  exec.call(TOKENS.AAVE_POLYGON, encodeApprove(ooRouter, inputAmount));
  exec.call(ooRouter, swapData);
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeApprove(polyCctp.tokenMessenger, ethers.MaxUint256));
  const usdcBalance = exec.staticCall(TOKENS.USDC_POLYGON_CIRCLE, encodeBalanceOf(ROUTER_POLYGON));
  exec.call(polyCctp.tokenMessenger, depositForBurnData).spliceArg(0, usdcBalance.returnWord());

  const callData = routerIface.encodeFunctionData('performModularExecution', [ZERO_BYTES32, exec.toActions()]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_POLYGON, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, inputAmount, ROUTER_POLYGON, callData);

  logTxnSummary(
    'Polygon AAVE → Base USDC (CCTP) — performModularExecution postFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log(`\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
