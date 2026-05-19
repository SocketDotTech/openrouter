/**
 * Route:  Ethereum AAVE → ETH (OpenOcean) → Arbitrum ETH (inbox depositEth)
 * Function: swapAndBridge
 * Fee: postFee — FEE_BPS of estimatedOut ETH deducted after swap
 *
 * BRIDGE_VALUE_FLAG: router forwards swap output as msg.value to inbox.depositEth().
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
  BRIDGE_VALUE_FLAG,
  POST_FEE_FLAG,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  swapAndBridgeArgs,
} from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterNativeBalance } from '../utils/reproducibility';
import { resolveApprovalSpender } from '../utils/routerAllowance';

const FLAGS = POST_FEE_FLAG | BRIDGE_VALUE_FLAG;
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

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_ETH, ROUTER_ETH);
  await ensureRouterNativeBalance(signer, ROUTER_ETH);

  const swapApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_ETH,
    TOKENS.AAVE_ETH,
    ooRouter,
    inputAmount,
  );

  const callData = routerIface.encodeFunctionData(
    'swapAndBridge',
    swapAndBridgeArgs(
      ZERO_BYTES32,
      FLAGS,
      { user: signerAddress, inputToken: TOKENS.AAVE_ETH, inputAmount },
      { receiver: signerAddress, amount: feeAmount },
      {
        target: ooRouter,
        approvalSpender: swapApprovalSpender,
        outputToken: NATIVE_TOKEN_ADDRESS,
        value: 0n,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      swapData,
      { target: ARBITRUM_INBOX, approvalSpender: ZERO_ADDRESS, value: 0n },
      buildDepositEthCalldata(),
    ),
  );

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_ETH, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_ETH, TOKENS.AAVE_ETH, inputAmount, ROUTER_ETH, callData, 0n);

  logTxnSummary('Ethereum AAVE → Arbitrum ETH (depositEth) — swapAndBridge postFee', CHAIN_IDS.ETHEREUM, receipt);

  console.log('\nETH arrives on Arbitrum once the retryable ticket is processed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
