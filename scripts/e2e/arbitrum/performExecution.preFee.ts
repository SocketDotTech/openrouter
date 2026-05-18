/**
 * Route:  Ethereum ETH → Arbitrum ETH (Arbitrum inbox depositEth, no swap)
 * Function: performExecution (monolithic)
 * Fee: preFee — FEE_BPS of inputAmount ETH deducted before bridge
 *
 * BRIDGE_VALUE_FLAG set: router forwards the remaining ETH after preFee as
 * msg.value to inbox.depositEth(). Input is native ETH so we call execDirect
 * (no AllowanceHolder needed — router checks msg.value >= inputAmount directly).
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/arbitrum/performExecution.preFee.ts
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  ARBITRUM_INBOX,
  FEE_BPS,
  bpsOf,
  RPC,
  NATIVE_TOKEN_ADDRESS,
} from '../config';
import { execDirect } from '../utils/allowanceHolder';
import { ROUTER_ABI } from '../utils/routerAbi';
import {
  MonolithicExecutionCall,
  BRIDGE_VALUE_FLAG,
  NO_FEE,
  NO_SWAP,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  monolithicArgs,
} from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterNativeBalance } from '../utils/reproducibility';

const ROUTER_ETH = routerAddressForChain(CHAIN_IDS.ETHEREUM);

/** Gas reserve kept in the signer's wallet to cover the transaction itself. */
const GAS_RESERVE = ethers.parseEther('0.005');

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

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.ETHEREUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const rawBalance = await provider.getBalance(signerAddress);
  const inputAmount = rawBalance - GAS_RESERVE - 20n;
  if (inputAmount <= 0n) {
    throw new Error(`Signer ${signerAddress} has insufficient ETH on Ethereum (balance: ${ethers.formatEther(rawBalance)})`);
  }

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeValue = inputAmount - feeAmount;

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_ETH}`);
  console.log(`ETH balance:     ${ethers.formatEther(rawBalance)}`);
  console.log(`Input amount:    ${ethers.formatEther(inputAmount)} (balance minus gas reserve)`);
  console.log(`Pre-bridge fee:  ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`);
  console.log(`Bridge value:    ${ethers.formatEther(bridgeValue)} ETH`);

  const arbFee = await estimateArbitrumBridgeFee(provider);
  if (bridgeValue < arbFee) {
    console.warn(`  Warning: bridgeValue (${ethers.formatEther(bridgeValue)}) may be below Arbitrum bridge cost (${ethers.formatEther(arbFee)})`);
  }

  await ensureRouterNativeBalance(signer, ROUTER_ETH);

  const mono: MonolithicExecutionCall = {
    exec: {
      input: { user: signerAddress, inputToken: NATIVE_TOKEN_ADDRESS, inputAmount },
      preFee: { receiver: signerAddress, amount: feeAmount },
      swap: NO_SWAP,
      postFee: NO_FEE,
      bridge: { target: ARBITRUM_INBOX, approvalSpender: ZERO_ADDRESS, value: 0n },
      flags: BRIDGE_VALUE_FLAG,
    },
    swapCallData: '0x',
    bridgeCallData: buildDepositEthCalldata(),
  };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const callData = routerIface.encodeFunctionData('performExecution', monolithicArgs(mono, ZERO_BYTES32));

  // Native ETH input — send directly to the router; no AllowanceHolder needed.
  console.log('Sending direct router tx → router.performExecution...');
  const receipt = await execDirect(signer, ROUTER_ETH, callData, inputAmount);

  logTxnSummary('Ethereum ETH → Arbitrum ETH (depositEth direct) — performExecution preFee', CHAIN_IDS.ETHEREUM, receipt);

  console.log('\nETH arrives on Arbitrum once the retryable ticket is processed.');

  void arbFee;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
