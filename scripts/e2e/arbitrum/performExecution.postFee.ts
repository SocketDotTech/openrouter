/**
 * Route:  Ethereum AAVE → ETH (OpenOcean) → Arbitrum ETH (inbox depositEth)
 * Function: performExecution (monolithic)
 * Fee: postFee — FEE_BPS of estimatedOut ETH deducted after swap
 *
 * BRIDGE_VALUE_FLAG set: router forwards actualFinalETH as msg.value to inbox.depositEth().
 * Input is AAVE (ERC-20) so AllowanceHolder.exec is required.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/arbitrum/performExecution.postFee.ts
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
  NATIVE_TOKEN_ADDRESS,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import {
  MonolithicExecutionCall,
  BRIDGE_VALUE_FLAG,
  NO_FEE,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  monolithicArgs,
} from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterNativeBalance, ensureRouterApproval } from '../utils/reproducibility';

const ROUTER_ETH = routerAddressForChain(CHAIN_IDS.ETHEREUM);

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
  if (estimatedOut < feeAmount + arbFee) {
    console.warn(`  Warning: estimated ETH may be insufficient to cover fee + bridge cost`);
  }

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_ETH, ROUTER_ETH);
  await ensureRouterNativeBalance(signer, ROUTER_ETH);
  await ensureRouterApproval(signer, ROUTER_ETH, TOKENS.AAVE_ETH, ooRouter);

  const mono: MonolithicExecutionCall = {
    exec: {
      input: { user: signerAddress, inputToken: TOKENS.AAVE_ETH, inputAmount },
      preFee: NO_FEE,
      swap: {
        target: ooRouter,
        approvalSpender: ooRouter,
        outputToken: NATIVE_TOKEN_ADDRESS,
        value: 0n,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      postFee: { receiver: signerAddress, amount: feeAmount },
      bridge: { target: ARBITRUM_INBOX, approvalSpender: ZERO_ADDRESS, value: 0n },
      flags: BRIDGE_VALUE_FLAG,
    },
    swapCallData: swapData,
    bridgeCallData: buildDepositEthCalldata(),
  };

  const callData = routerIface.encodeFunctionData('performExecution', monolithicArgs(mono, ZERO_BYTES32));

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_ETH, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_ETH, TOKENS.AAVE_ETH, inputAmount, ROUTER_ETH, callData, 0n);

  logTxnSummary(
    'Ethereum AAVE → Arbitrum ETH (depositEth) — performExecution postFee',
    CHAIN_IDS.ETHEREUM,
    receipt,
  );

  console.log('\nETH arrives on Arbitrum once the retryable ticket is processed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
