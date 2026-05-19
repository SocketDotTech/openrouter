/**
 * Route:  Polygon POL (native) → USDT0 (OpenOcean) → Arbitrum USDT0 (LZ OFT Adapter)
 * Function: performActions (modular)
 * Fee: postFee — FEE_BPS of estimatedOut USDT0 transferred to signer after swap
 *
 * Input is native POL; msg.value = ooSwapNativeWei + nativeFeeWithBuffer.
 *
 * Modular action sequence:
 *   [0] nativeCall(ooRouter, swapData, polOrEthToOo)  — POL → USDT0 lands in router
 *   [1] USDT0.transfer(signer, feeAmount)
 *   [2] USDT0.approve(adapter, MaxUint256)
 *   [3] STATICCALL USDT0.balanceOf(router)
 *   [4] nativeCall(adapter, oftSendData, nativeFeeWithBuffer) — splicePayloadWord(196) from [3]
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/stargate/polygonPolUsdt0Arb.performActions.postFee.ts
 */
import axios from 'axios';
import { ethers, parseEther } from 'ethers';
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
  NATIVE_TOKEN_ADDRESS,
  USDT0_OFT_ADAPTER_POLYGON,
  ARBITRUM_LZ_EID,
  STARGATE_AMOUNT_LD_OFFSET,
} from '../config';
import { execViaAH } from '../utils/allowanceHolder';
import { encodeTransfer, encodeBalanceOf } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterNativeBalance } from '../utils/reproducibility';
import { modularApproveIfNeeded } from '../utils/routerAllowance';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);
const LZ_EXTRA_OPTIONS = Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex();
const NATIVE_INPUT_GAS_RESERVE = parseEther('0.01');
const NATIVE_INPUT_GAS_LIMIT_ESTIMATE = 2_000_000n;

const OFT_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];
const OFT_IFACE = new ethers.Interface(OFT_ABI);

interface OoQuoteResponse {
  data: { to: string; data: string; value?: string; outAmount: string; minOutAmount: string };
}

async function fetchOpenOceanQuote(inputAmountWei: bigint): Promise<{
  ooRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
  nativeSwapWei: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: NATIVE_TOKEN_ADDRESS,
    outTokenAddress: TOKENS.USDT0_POLYGON,
    amount: ethers.formatEther(inputAmountWei),
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
    nativeSwapWei: q.value !== undefined && q.value !== '' ? BigInt(q.value) : 0n,
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

  const rawBalance = await provider.getBalance(signerAddress);
  if (rawBalance <= NATIVE_INPUT_GAS_RESERVE) {
    throw new Error(`Signer ${signerAddress} POL balance (${ethers.formatEther(rawBalance)}) below reserve`);
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 500_000_000n;
  const gasReserve = maxFeePerGas * NATIVE_INPUT_GAS_LIMIT_ESTIMATE;
  console.log(`  Gas reserve: ${ethers.formatEther(gasReserve)} POL`);

  let inputAmountWei = rawBalance - NATIVE_INPUT_GAS_RESERVE - 20n;
  if (inputAmountWei <= 0n) throw new Error('POL balance too small');

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`POL balance:   ${ethers.formatEther(rawBalance)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  let ooRouter = '';
  let swapData = '';
  let nativeSwapWei = 0n;
  let feeAmount = 0n;
  let estimatedBridgeAmount = 0n;
  let nativeFeeWithBuffer = 0n;
  let amountReceivedLD = 0n;

  for (let iter = 0; iter < 6; iter++) {
    console.log('Fetching OpenOcean quote (POL → USDT0)...');
    const q = await fetchOpenOceanQuote(inputAmountWei);
    ooRouter = q.ooRouter;
    swapData = q.swapData;
    nativeSwapWei = q.nativeSwapWei;
    feeAmount = bpsOf(q.estimatedOut, FEE_BPS);
    estimatedBridgeAmount = q.estimatedOut - feeAmount;
    console.log(`  OO router:   ${ooRouter}`);
    console.log(`  Est. USDT0:  ${ethers.formatUnits(q.estimatedOut, 6)}`);
    console.log(`  Post-fee:    ${ethers.formatUnits(feeAmount, 6)} USDT0`);

    console.log('Fetching OFT quote (Polygon → Arbitrum)...');
    ({ nativeFeeWithBuffer, amountReceivedLD } = await fetchOftQuote(provider, estimatedBridgeAmount, signerAddress));
    console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} POL`);
    console.log(`  Est. received: ${ethers.formatUnits(amountReceivedLD, 6)} USDT0`);

    const maxAffordable = rawBalance - nativeFeeWithBuffer - gasReserve;
    if (maxAffordable <= 0n) {
      throw new Error(`POL balance cannot cover lz fee (${ethers.formatEther(nativeFeeWithBuffer)}) + gas reserve`);
    }
    if (inputAmountWei <= maxAffordable) {
      break;
    }
    console.warn(`  Capping swap input from ${ethers.formatEther(inputAmountWei)} to ${ethers.formatEther(maxAffordable)} POL`);
    inputAmountWei = maxAffordable;
  }

  await ensureRouterErc20Balance(signer, TOKENS.USDT0_POLYGON, ROUTER_POLYGON);
  await ensureRouterNativeBalance(signer, ROUTER_POLYGON);

  const rawOoWei = nativeSwapWei > 0n ? nativeSwapWei : inputAmountWei;
  const polOrEthToOo = rawOoWei <= inputAmountWei ? rawOoWei : inputAmountWei;

  const oftSendData = buildOftSendCalldata(nativeFeeWithBuffer, signerAddress);

  const exec = new ModularActionsBuilder();
  exec.nativeCall(ooRouter, swapData, polOrEthToOo);
  exec.call(TOKENS.USDT0_POLYGON, encodeTransfer(signerAddress, feeAmount));
  await modularApproveIfNeeded(
    exec,
    provider,
    ROUTER_POLYGON,
    TOKENS.USDT0_POLYGON,
    USDT0_OFT_ADAPTER_POLYGON,
    estimatedBridgeAmount,
    ethers.MaxUint256,
  );
  const usdt0Balance = exec.staticCall(TOKENS.USDT0_POLYGON, encodeBalanceOf(ROUTER_POLYGON));
  exec.nativeCall(USDT0_OFT_ADAPTER_POLYGON, oftSendData, nativeFeeWithBuffer)
    .splicePayloadWord(BigInt(STARGATE_AMOUNT_LD_OFFSET), usdt0Balance.returnWord());

  const txValue = inputAmountWei + nativeFeeWithBuffer;
  const callData = routerIface.encodeFunctionData('performActions', [ZERO_BYTES32, exec.toActions()]);

  const receipt = await execViaAH(signer, ROUTER_POLYGON, NATIVE_TOKEN_ADDRESS, inputAmountWei, ROUTER_POLYGON, callData, txValue);

  logTxnSummary(
    'Polygon POL → USDT0 (OO) → Arbitrum USDT0 (OFT) — performActions postFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log('\nUSDT0 arrives on Arbitrum once LZ delivers the message.');

  void amountReceivedLD;
}

main().catch((err) => { console.error(err); process.exit(1); });
