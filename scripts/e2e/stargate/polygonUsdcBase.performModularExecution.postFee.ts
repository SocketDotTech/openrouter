/**
 * Route:  Polygon USDC → Base USDC (Stargate USDC Pool, no swap)
 * Function: performModularExecution (modular)
 * Fee: postFee — FEE_BPS of inputAmount USDC transferred to signer; staticCall balance spliced
 *      into Stargate amountLD at STARGATE_AMOUNT_LD_OFFSET (byte 196).
 *
 * Modular action sequence:
 *   [0] AH.transferFrom(USDC, signer, router, inputAmount)
 *   [1] USDC.transfer(signer, feeAmount)
 *   [2] USDC.approve(stargatePool, MaxUint256)
 *   [3] STATICCALL USDC.balanceOf(router)
 *   [4] nativeCall(Stargate, sendData, nativeFeeWithBuffer) — splicePayloadWord(196) from [3]
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/stargate/polygonUsdcBase.performModularExecution.postFee.ts
 */
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
  ALLOWANCE_HOLDER,
  STARGATE_USDC_POLYGON,
  BASE_LZ_EID,
  STARGATE_AMOUNT_LD_OFFSET,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { encodeApprove, encodeTransfer, encodeBalanceOf, getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import { ModularActionsBuilder } from '../utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterApproval } from '../utils/reproducibility';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

const STARGATE_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];
const STARGATE_IFACE = new ethers.Interface(STARGATE_ABI);

async function fetchStargateQuote(
  provider: ethers.JsonRpcProvider,
  bridgeAmountLD: bigint,
  recipient: string,
): Promise<{ nativeFeeWithBuffer: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(STARGATE_USDC_POLYGON, STARGATE_ABI, provider);
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = { dstEid: BASE_LZ_EID, to: to32, amountLD: bridgeAmountLD, minAmountLD: 0n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' };
  const [fee, oft] = await Promise.all([contract.quoteSend(sendParam, false), contract.quoteOFT(sendParam)]);
  return {
    nativeFeeWithBuffer: ((fee.nativeFee as bigint) * 105n) / 100n,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

function buildStargateCalldata(nativeFee: bigint, recipient: string): string {
  return STARGATE_IFACE.encodeFunctionData('send', [
    { dstEid: BASE_LZ_EID, to: ethers.zeroPadValue(recipient, 32), amountLD: 0n, minAmountLD: 0n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' },
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

  const { balance: walletBalance } = await getWalletErc20Balance(TOKENS.USDC_POLYGON_CIRCLE, signerAddress, provider);
  if (walletBalance === 0n) throw new Error(`Signer ${signerAddress} has zero USDC on Polygon`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const estimatedBridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`USDC balance:  ${ethers.formatUnits(walletBalance, 6)}`);
  console.log(`Post-fee:      ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`);
  console.log(`Est. bridge:   ${ethers.formatUnits(estimatedBridgeAmount, 6)} USDC`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log('Fetching Stargate quote (Polygon → Base USDC pool)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchStargateQuote(provider, estimatedBridgeAmount, signerAddress);
  console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} POL`);
  console.log(`  Est. received: ${ethers.formatUnits(amountReceivedLD, 6)} USDC`);

  await ensureRouterErc20Balance(signer, TOKENS.USDC_POLYGON_CIRCLE, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, STARGATE_USDC_POLYGON);

  const stargateData = buildStargateCalldata(nativeFeeWithBuffer, signerAddress);

  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahIface.encodeFunctionData('transferFrom', [TOKENS.USDC_POLYGON_CIRCLE, signerAddress, ROUTER_POLYGON, inputAmount]));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeApprove(STARGATE_USDC_POLYGON, ethers.MaxUint256));
  const usdcBalance = exec.staticCall(TOKENS.USDC_POLYGON_CIRCLE, encodeBalanceOf(ROUTER_POLYGON));
  exec.nativeCall(STARGATE_USDC_POLYGON, stargateData, nativeFeeWithBuffer)
    .splicePayloadWord(BigInt(STARGATE_AMOUNT_LD_OFFSET), usdcBalance.returnWord());

  const callData = routerIface.encodeFunctionData('performModularExecution', [ZERO_BYTES32, exec.toActions()]);

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.USDC_POLYGON_CIRCLE, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, inputAmount, ROUTER_POLYGON, callData, nativeFeeWithBuffer);

  logTxnSummary(
    'Polygon USDC → Base USDC (Stargate USDC pool) — performModularExecution postFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log('\nUSDC arrives on Base once LZ delivers the message.');
}

main().catch((err) => { console.error(err); process.exit(1); });
