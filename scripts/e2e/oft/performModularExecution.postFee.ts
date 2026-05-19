/**
 * Route:  Polygon AAVE → USDT0 (OpenOcean) → Arbitrum USDT0 (USDT0 OFT Adapter, LayerZero v2)
 * Function: performActions (modular)
 * Fee: postFee — FEE_BPS of estimatedOut USDT0 transferred to signer after swap
 *
 * Modular action sequence:
 *   [0] AH.transferFrom(AAVE, signer, router, inputAmount)
 *   [1] AAVE.approve(ooRouter, inputAmount)
 *   [2] ooRouter swap — AAVE → USDT0 lands in router
 *   [3] USDT0.transfer(signer, feeAmount)
 *   [4] USDT0.approve(adapter, MaxUint256)
 *   [5] STATICCALL USDT0.balanceOf(router)
 *   [6] nativeCall adapter.send(...) — spliceWord patches amountLD at offset 196 from [5]
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/oft/performActions.postFee.ts
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { Options } from '@layerzerolabs/lz-v2-utilities';
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
  ALLOWANCE_HOLDER,
  ARBITRUM_LZ_EID,
  USDT0_OFT_ADAPTER_POLYGON,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { encodeApprove, encodeTransfer, encodeBalanceOf, getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterApproval } from '../utils/reproducibility';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);
const LZ_EXTRA_OPTIONS = Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex();
const OFT_AMOUNT_LD_OFFSET = 196;

const OFT_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];
const OFT_IFACE = new ethers.Interface(OFT_ABI);

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
    outTokenAddress: TOKENS.USDT0_POLYGON,
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

async function fetchOftQuote(
  provider: ethers.JsonRpcProvider,
  bridgeAmountLD: bigint,
  recipient: string,
): Promise<{ nativeFeeWithBuffer: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(USDT0_OFT_ADAPTER_POLYGON, OFT_ABI, provider);
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = { dstEid: ARBITRUM_LZ_EID, to: to32, amountLD: bridgeAmountLD, minAmountLD: 0n, extraOptions: LZ_EXTRA_OPTIONS, composeMsg: '0x', oftCmd: '0x' };
  const [fee, oft] = await Promise.all([contract.quoteSend(sendParam, false), contract.quoteOFT(sendParam)]);
  return {
    nativeFeeWithBuffer: ((fee.nativeFee as bigint) * 105n) / 100n,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

function buildOftSendCalldata(nativeFee: bigint, recipient: string): string {
  return OFT_IFACE.encodeFunctionData('send', [
    { dstEid: ARBITRUM_LZ_EID, to: ethers.zeroPadValue(recipient, 32), amountLD: 0n, minAmountLD: 0n, extraOptions: LZ_EXTRA_OPTIONS, composeMsg: '0x', oftCmd: '0x' },
    { nativeFee, lzTokenFee: 0n },
    recipient,
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

  console.log('Fetching OpenOcean quote (AAVE → USDT0)...');
  const { ooRouter, swapData, estimatedOut, minAmountOut } = await fetchOpenOceanQuote(inputAmount);
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  const bridgeAmount = estimatedOut - feeAmount;
  console.log(`  OO router:   ${ooRouter}`);
  console.log(`  Est. USDT0:  ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(`  Post-fee:    ${ethers.formatUnits(feeAmount, 6)} USDT0 (${FEE_BPS} bps)`);
  console.log(`  Min USDT0:   ${ethers.formatUnits(minAmountOut, 6)}`);

  console.log('Fetching OFT quote (Polygon → Arbitrum)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchOftQuote(provider, bridgeAmount, signerAddress);
  console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} POL`);
  console.log(`  Est. received: ${ethers.formatUnits(amountReceivedLD, 6)} USDT0`);

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(signer, TOKENS.USDT0_POLYGON, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, ooRouter);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDT0_POLYGON, USDT0_OFT_ADAPTER_POLYGON);

  const oftSendData = buildOftSendCalldata(nativeFeeWithBuffer, signerAddress);

  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahIface.encodeFunctionData('transferFrom', [TOKENS.AAVE_POLYGON, signerAddress, ROUTER_POLYGON, inputAmount]));
  exec.call(TOKENS.AAVE_POLYGON, encodeApprove(ooRouter, inputAmount));
  exec.call(ooRouter, swapData);
  exec.call(TOKENS.USDT0_POLYGON, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.USDT0_POLYGON, encodeApprove(USDT0_OFT_ADAPTER_POLYGON, ethers.MaxUint256));
  const usdt0Balance = exec.staticCall(TOKENS.USDT0_POLYGON, encodeBalanceOf(ROUTER_POLYGON));
  exec.nativeCall(USDT0_OFT_ADAPTER_POLYGON, oftSendData, nativeFeeWithBuffer)
    .spliceWord(BigInt(OFT_AMOUNT_LD_OFFSET), usdt0Balance.returnWord());

  const callData = routerIface.encodeFunctionData('performActions', [ZERO_BYTES32, exec.toActions()]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_POLYGON, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, inputAmount, ROUTER_POLYGON, callData, nativeFeeWithBuffer);

  logTxnSummary(
    'Polygon AAVE → Arbitrum USDT0 (OFT) — performActions postFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log('\nUSDT0 arrives on Arbitrum once LZ delivers the message.');
}

main().catch((err) => { console.error(err); process.exit(1); });
