/**
 * Route:  Polygon USDT0 → Arbitrum USDT0 (USDT0 OFT Adapter, LayerZero v2, no swap)
 * Function: performExecution (monolithic)
 * Fee: preFee — FEE_BPS of inputAmount USDT0 deducted before bridge
 *
 * Bridge amount position flag splices actual post-fee balance into send() amountLD at byte 196.
 * bridge.value = nativeFeeWithBuffer forwarded as LZ msg.value.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/oft/performExecution.preFee.ts
 */
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
  ARBITRUM_LZ_EID,
  USDT0_OFT_ADAPTER_POLYGON,
} from '../config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from '../utils/allowanceHolder';
import { getWalletErc20Balance } from '../utils/erc20';
import { ROUTER_ABI } from '../utils/routerAbi';
import {
  MonolithicExecutionCall,
  NO_FEE,
  NO_SWAP,
  ZERO_BYTES32,
  bridgeAmountPositionFlag,
  monolithicArgs,
} from '../utils/contractTypes';
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

  const { balance: walletBalance } = await getWalletErc20Balance(TOKENS.USDT0_POLYGON, signerAddress, provider);
  if (walletBalance === 0n) throw new Error(`Signer ${signerAddress} has zero USDT0 on Polygon`);

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`USDT0 balance: ${ethers.formatUnits(walletBalance, 6)}`);
  console.log(`Pre-fee:       ${ethers.formatUnits(feeAmount, 6)} USDT0 (${FEE_BPS} bps)`);
  console.log(`Net to bridge: ${ethers.formatUnits(bridgeAmount, 6)}`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log('Fetching OFT quote (Polygon → Arbitrum)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchOftQuote(provider, bridgeAmount, signerAddress);
  console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} POL`);
  console.log(`  Est. received: ${ethers.formatUnits(amountReceivedLD, 6)} USDT0`);

  await ensureRouterErc20Balance(signer, TOKENS.USDT0_POLYGON, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDT0_POLYGON, USDT0_OFT_ADAPTER_POLYGON);

  const oftSendData = buildOftSendCalldata(nativeFeeWithBuffer, signerAddress);

  const mono: MonolithicExecutionCall = {
    exec: {
      input: { user: signerAddress, inputToken: TOKENS.USDT0_POLYGON, inputAmount },
      preFee: { receiver: signerAddress, amount: feeAmount },
      swap: NO_SWAP,
      postFee: NO_FEE,
      bridge: { target: USDT0_OFT_ADAPTER_POLYGON, approvalSpender: USDT0_OFT_ADAPTER_POLYGON, value: nativeFeeWithBuffer },
      flags: bridgeAmountPositionFlag(OFT_AMOUNT_LD_OFFSET),
    },
    swapCallData: '0x',
    bridgeCallData: oftSendData,
  };

  const callData = routerIface.encodeFunctionData('performExecution', monolithicArgs(mono, ZERO_BYTES32));

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.USDT0_POLYGON, inputAmount);
  const receipt = await execViaAH(signer, ROUTER_POLYGON, TOKENS.USDT0_POLYGON, inputAmount, ROUTER_POLYGON, callData, nativeFeeWithBuffer);

  logTxnSummary(
    'Polygon USDT0 → Arbitrum USDT0 (OFT direct) — performExecution preFee',
    CHAIN_IDS.POLYGON,
    receipt,
  );

  console.log('\nUSDT0 arrives on Arbitrum once LZ delivers the message.');
}

main().catch((err) => { console.error(err); process.exit(1); });
