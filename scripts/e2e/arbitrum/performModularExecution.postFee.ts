/**
 * Route:  Ethereum AAVE → ETH (OpenOcean) → Arbitrum ETH (inbox depositEth)
 * Function: performActions (modular)
 * Fee: postFee — FEE_BPS of estimatedOut ETH sent to signer after swap
 *
 * Modular action sequence:
 *   [0] AH.transferFrom(AAVE, signer, router, inputAmount)
 *   [1] AAVE.approve(ooRouter, inputAmount)
 *   [2] call(ooRouter, swapData) — AAVE → ETH lands in router
 *   [3] nativeCall(signer, '0x', feeAmount) — ETH fee to signer
 *   [4] nativeCall(inbox, depositEth(), bridgeValue)
 *
 * Input is AAVE (ERC-20) so AllowanceHolder.exec is required.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/arbitrum/performActions.postFee.ts
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  ARBITRUM_INBOX,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
  allowanceHolderForChain,
  NATIVE_TOKEN_ADDRESS,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterNativeBalance } from '../utils/reproducibility';
import { modularApproveIfNeeded } from '../utils/routerAllowance';

const ROUTER_ETH = routerAddressForChain(CHAIN_IDS.ETHEREUM);
const ALLOWANCE_HOLDER = allowanceHolderForChain(CHAIN_IDS.ETHEREUM);

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
    inTokenAddress: TOKENS.AAVE_ETH,
    outTokenAddress: NATIVE_TOKEN_ADDRESS,
    amount: ethers.formatUnits(inputAmount, 18),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_ETH,
    account: ROUTER_ETH,
    gasPrice: '20',
  };
  if (OPEN_OCEAN_API_KEY) params.apikey = OPEN_OCEAN_API_KEY;
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.ETHEREUM}/swap_quote`;
  const response = await axios.get<OoQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

function buildDepositEthCalldata(): string {
  return new ethers.Interface([
    'function depositEth() external payable returns (uint256)',
  ]).encodeFunctionData('depositEth', []);
}

async function estimateArbitrumBridgeFee(provider: ethers.Provider): Promise<bigint> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ParentToChildMessageGasEstimator } = require('@arbitrum/sdk');
    const estimator = new ParentToChildMessageGasEstimator(provider);
    const l2GasPrice = (await new ethers.JsonRpcProvider(RPC.ARBITRUM).getFeeData()).gasPrice ?? 0n;
    const submissionFee = await estimator.estimateSubmissionFee(provider, 0n, 0n);
    const executionCost = 250000n * (l2GasPrice + (l2GasPrice * 20n) / 100n);
    const totalFee = BigInt(submissionFee.toString()) + executionCost;
    console.log(`  Estimated Arbitrum bridge fee: ${ethers.formatEther(totalFee)} ETH`);
    return totalFee;
  } catch (err) {
    const fallback = ethers.parseEther('0.001');
    console.warn(`  Arb fee estimation failed (${(err as Error).message}), using fallback: ${ethers.formatEther(fallback)} ETH`);
    return fallback;
  }
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY env var required');

  const provider = new ethers.JsonRpcProvider(RPC.ETHEREUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance, decimals } = await getWalletErc20Balance(TOKENS.AAVE_ETH, signerAddress, provider);
  if (walletBalance === 0n) throw new Error(`Signer ${signerAddress} has zero AAVE on Ethereum`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ETH}`);
  console.log(`AAVE balance:  ${ethers.formatUnits(walletBalance, decimals)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log('Fetching OpenOcean quote (AAVE → ETH)...');
  const { ooRouter, swapData, estimatedOut, minAmountOut } = await fetchOpenOceanQuote(inputAmount);
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`  OO router:   ${ooRouter}`);
  console.log(`  Est. ETH:    ${ethers.formatEther(estimatedOut)}`);
  console.log(`  Post-fee:    ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`);
  console.log(`  Min ETH:     ${ethers.formatEther(minAmountOut)}`);

  const arbFee = await estimateArbitrumBridgeFee(provider);
  // bridgeValue uses minAmountOut-based floor so the nativeCall carries at least the bridge cost
  const bridgeValue = minAmountOut > feeAmount ? minAmountOut - feeAmount : 0n;
  console.log(`  Bridge value: ${ethers.formatEther(bridgeValue)} ETH (floor for nativeCall)`);

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_ETH, ROUTER_ETH);
  await ensureRouterNativeBalance(signer, ROUTER_ETH);

  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahIface.encodeFunctionData('transferFrom', [TOKENS.AAVE_ETH, signerAddress, ROUTER_ETH, inputAmount]));
  await modularApproveIfNeeded(exec, provider, ROUTER_ETH, TOKENS.AAVE_ETH, ooRouter, inputAmount, inputAmount);
  exec.call(ooRouter, swapData);
  exec.nativeCall(signerAddress, '0x', feeAmount);
  exec.nativeCall(ARBITRUM_INBOX, buildDepositEthCalldata(), bridgeValue);

  const callData = routerIface.encodeFunctionData('performActions', [ZERO_BYTES32, exec.toActions()]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_ETH, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_ETH, TOKENS.AAVE_ETH, inputAmount, ROUTER_ETH, callData, 0n);

  logTxnSummary(
    'Ethereum AAVE → Arbitrum ETH (depositEth) — performActions postFee',
    CHAIN_IDS.ETHEREUM,
    receipt,
  );

  console.log('\nETH arrives on Arbitrum once the retryable ticket is processed.');

  // Suppress unused-variable warning for arbFee (kept for informational logging above)
  void arbFee;
}

main().catch((err) => { console.error(err); process.exit(1); });
