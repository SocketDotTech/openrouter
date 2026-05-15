/**
 * Route:  Polygon AAVE → USDC (OpenOcean) → Base USDC (CCTP depositForBurn)
 * Function: performExecution (monolithic)
 * Fee: postFee — FEE_BPS of estimatedOut USDC deducted after swap
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/cctp/performExecution.postFee.ts
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
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import {
  MonolithicExecutionCall,
  NO_FEE,
  ZERO_BYTES32,
  bridgeAmountPositionFlag,
  monolithicArgs,
} from '../utils/contractTypes';
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

  const mono: MonolithicExecutionCall = {
    exec: {
      input: { user: signerAddress, inputToken: TOKENS.AAVE_POLYGON, inputAmount },
      preFee: NO_FEE,
      swap: {
        target: ooRouter,
        approvalSpender: ooRouter,
        outputToken: TOKENS.USDC_POLYGON_CIRCLE,
        value: 0n,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      postFee: { receiver: signerAddress, amount: feeAmount },
      bridge: { target: polyCctp.tokenMessenger, approvalSpender: polyCctp.tokenMessenger, value: 0n },
      flags: bridgeAmountPositionFlag(4),
    },
    swapCallData: swapData,
    bridgeCallData: depositForBurnData,
  };

  const callData = routerIface.encodeFunctionData('performExecution', monolithicArgs(mono, ZERO_BYTES32));

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_POLYGON, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, inputAmount, ROUTER_POLYGON, callData);

  logTxnSummary(
    'Polygon AAVE → Base USDC (CCTP) — performExecution postFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log(`\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
