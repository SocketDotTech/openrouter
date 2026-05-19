/**
 * Route:  Ethereum ETH → Arbitrum ETH (Arbitrum inbox depositEth, no swap)
 * Function: bridge
 * Fee: preFee — FEE_BPS of inputAmount ETH deducted before bridge
 *
 * Input is native ETH — call router.bridge directly (msg.value = inputAmount).
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
import { ZERO_ADDRESS, ZERO_BYTES32, bridgeArgs, type BridgeData, type FeeData, type InputData } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterNativeBalance } from '../utils/reproducibility';

const ROUTER_ETH = routerAddressForChain(CHAIN_IDS.ETHEREUM);

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
    console.warn(
      `  Arb fee estimation failed (${(err as Error).message}), using fallback: ${ethers.formatEther(fallback)} ETH`,
    );
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
    console.warn(
      `  Warning: bridgeValue (${ethers.formatEther(bridgeValue)}) may be below Arbitrum bridge cost (${ethers.formatEther(arbFee)})`,
    );
  }

  await ensureRouterNativeBalance(signer, ROUTER_ETH);

  const input: InputData = { user: signerAddress, inputToken: NATIVE_TOKEN_ADDRESS, inputAmount };
  const fee: FeeData = { receiver: signerAddress, amount: feeAmount };
  const bridgeData: BridgeData = { target: ARBITRUM_INBOX, approvalSpender: ZERO_ADDRESS, value: bridgeValue };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const callData = routerIface.encodeFunctionData(
    'bridge',
    bridgeArgs(ZERO_BYTES32, input, fee, bridgeData, buildDepositEthCalldata()),
  );

  console.log('Sending direct router tx → router.bridge...');
  const receipt = await execDirect(signer, ROUTER_ETH, callData, inputAmount);

  logTxnSummary('Ethereum ETH → Arbitrum ETH (depositEth direct) — bridge preFee', CHAIN_IDS.ETHEREUM, receipt);

  console.log('\nETH arrives on Arbitrum once the retryable ticket is processed.');

  void arbFee;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
