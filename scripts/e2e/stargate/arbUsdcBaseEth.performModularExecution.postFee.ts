/**
 * Route:  Arbitrum USDC → ETH (OpenOcean) → Base ETH (Stargate Native ETH Pool)
 * Function: performActions (modular)
 * Fee: postFee — FEE_BPS of estimatedOut ETH sent to signer after swap
 *
 * Modular action sequence:
 *   [0] AH.transferFrom(USDC, signer, router, inputAmount)
 *   [1] USDC.approve(ooRouter, inputAmount)
 *   [2] call(ooRouter, swapData) — USDC → ETH lands in router
 *   [3] nativeCall(signer, '0x', feeAmount) — ETH fee out
 *   [4] nativeCall(Stargate, sendData, bridgeValue) — value = amountLD + nativeFeeWithBuffer
 *
 * amountLD = minAmountOut - feeAmount - nativeFeeWithBuffer (pre-encoded, surplus stays in router).
 * bridgeValue = minAmountOut - feeAmount (amountLD + nativeFeeWithBuffer).
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/stargate/arbUsdcBaseEth.performActions.postFee.ts
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
  allowanceHolderForChain,
  NATIVE_TOKEN_ADDRESS,
  STARGATE_NATIVE_ARB,
  BASE_LZ_EID,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterNativeBalance } from '../utils/reproducibility';
import { modularApproveIfNeeded } from '../utils/routerAllowance';

const ROUTER_ARB = routerAddressForChain(CHAIN_IDS.ARBITRUM);
const ALLOWANCE_HOLDER = allowanceHolderForChain(CHAIN_IDS.ARBITRUM);

const STARGATE_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];
const STARGATE_IFACE = new ethers.Interface(STARGATE_ABI);

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
    inTokenAddress: TOKENS.USDC_ARB,
    outTokenAddress: NATIVE_TOKEN_ADDRESS,
    amount: ethers.formatUnits(inputAmount, 6),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_ARB,
    account: ROUTER_ARB,
    gasPrice: '1',
  };
  if (OPEN_OCEAN_API_KEY) params.apikey = OPEN_OCEAN_API_KEY;
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.ARBITRUM}/swap_quote`;
  const response = await axios.get<OoQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

async function fetchStargateQuote(
  provider: ethers.JsonRpcProvider,
  bridgeAmountLD: bigint,
  recipient: string,
): Promise<{ nativeFeeWithBuffer: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(STARGATE_NATIVE_ARB, STARGATE_ABI, provider);
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = { dstEid: BASE_LZ_EID, to: to32, amountLD: bridgeAmountLD, minAmountLD: 0n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' };
  const [fee, oft] = await Promise.all([contract.quoteSend(sendParam, false), contract.quoteOFT(sendParam)]);
  return {
    nativeFeeWithBuffer: ((fee.nativeFee as bigint) * 105n) / 100n,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

function buildStargateCalldata(nativeFee: bigint, amountLD: bigint, recipient: string): string {
  return STARGATE_IFACE.encodeFunctionData('send', [
    { dstEid: BASE_LZ_EID, to: ethers.zeroPadValue(recipient, 32), amountLD, minAmountLD: 0n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' },
    { nativeFee, lzTokenFee: 0n },
    recipient,
  ]);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY env var required');

  const provider = new ethers.JsonRpcProvider(RPC.ARBITRUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: walletBalance } = await getWalletErc20Balance(TOKENS.USDC_ARB, signerAddress, provider);
  if (walletBalance === 0n) throw new Error(`Signer ${signerAddress} has zero USDC on Arbitrum`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ARB}`);
  console.log(`USDC balance:  ${ethers.formatUnits(walletBalance, 6)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log('Fetching OpenOcean quote (USDC → ETH on Arbitrum)...');
  const { ooRouter, swapData, estimatedOut, minAmountOut } = await fetchOpenOceanQuote(inputAmount);
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  const estimatedBridgeAmount = estimatedOut - feeAmount;
  console.log(`  OO router:   ${ooRouter}`);
  console.log(`  Est. ETH:    ${ethers.formatEther(estimatedOut)}`);
  console.log(`  Post-fee:    ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`);
  console.log(`  Min ETH:     ${ethers.formatEther(minAmountOut)}`);

  console.log('Fetching Stargate quote (Arbitrum → Base native pool)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchStargateQuote(provider, estimatedBridgeAmount, signerAddress);
  console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} ETH`);
  console.log(`  Est. received: ${ethers.formatEther(amountReceivedLD)} ETH`);

  const amountLD = minAmountOut - feeAmount - nativeFeeWithBuffer;
  if (amountLD <= 0n) throw new Error('minAmountOut too small to cover fee + nativeFee');
  // bridgeValue = amountLD + nativeFeeWithBuffer = minAmountOut - feeAmount
  const bridgeValue = minAmountOut - feeAmount;

  await ensureRouterErc20Balance(signer, TOKENS.USDC_ARB, ROUTER_ARB);
  await ensureRouterNativeBalance(signer, ROUTER_ARB);

  const stargateData = buildStargateCalldata(nativeFeeWithBuffer, amountLD, signerAddress);

  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahIface.encodeFunctionData('transferFrom', [TOKENS.USDC_ARB, signerAddress, ROUTER_ARB, inputAmount]));
  await modularApproveIfNeeded(exec, provider, ROUTER_ARB, TOKENS.USDC_ARB, ooRouter, inputAmount, inputAmount);
  exec.call(ooRouter, swapData);
  exec.nativeCall(signerAddress, '0x', feeAmount);
  exec.nativeCall(STARGATE_NATIVE_ARB, stargateData, bridgeValue);

  const callData = routerIface.encodeFunctionData('performActions', [ZERO_BYTES32, exec.toActions()]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.USDC_ARB, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_ARB, TOKENS.USDC_ARB, inputAmount, ROUTER_ARB, callData, nativeFeeWithBuffer);

  logTxnSummary(
    'Arbitrum USDC → ETH (OO) → Base ETH (Stargate native) — performActions postFee',
    CHAIN_IDS.ARBITRUM,
    receipt,
  );

  console.log('\nETH arrives on Base once LZ delivers the message.');
}

main().catch((err) => { console.error(err); process.exit(1); });
