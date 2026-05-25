/**
 * Route:  Polygon USDT0 → Arbitrum USDT0 (USDT0 OFT Adapter, LayerZero v2, no swap)
 * Function: bridge (simple bridge entrypoint)
 * Fee: preFee — FEE_BPS of inputAmount USDT0 deducted before bridge
 *
 * Bridge amount is pre-encoded in OFT send() calldata (no splice needed).
 * bridge.value = nativeFeeWithBuffer forwarded as LZ msg.value.
 * Uses router.bridge() rather than performExecution / performActions.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/oft/bridge.preFee.ts
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
import { ZERO_BYTES32, type BridgeData, type FeeData, type InputData } from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance } from '../utils/reproducibility';
import { resolveApprovalSpender } from '../utils/routerAllowance';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);
const LZ_EXTRA_OPTIONS = Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex();

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
  const sendParam = {
    dstEid: ARBITRUM_LZ_EID,
    to: to32,
    amountLD: bridgeAmountLD,
    minAmountLD: 0n,
    extraOptions: LZ_EXTRA_OPTIONS,
    composeMsg: '0x',
    oftCmd: '0x',
  };
  const [fee, oft] = await Promise.all([
    contract.quoteSend(sendParam, false),
    contract.quoteOFT(sendParam),
  ]);
  return {
    nativeFeeWithBuffer: ((fee.nativeFee as bigint) * 105n) / 100n,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

/**
 * Builds OFT send() calldata with the exact bridgeAmount pre-encoded (no 0 placeholder).
 * Used by router.bridge() which has no splice mechanism.
 */
function buildOftSendCalldata(bridgeAmount: bigint, nativeFee: bigint, recipient: string): string {
  return OFT_IFACE.encodeFunctionData('send', [
    {
      dstEid: ARBITRUM_LZ_EID,
      to: ethers.zeroPadValue(recipient, 32),
      amountLD: bridgeAmount,
      minAmountLD: 0n,
      extraOptions: LZ_EXTRA_OPTIONS,
      composeMsg: '0x',
      oftCmd: '0x',
    },
    { nativeFee, lzTokenFee: 0n },
    recipient,
  ]);
}

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.USDT0_POLYGON;
  const { balance: walletBalance } = await getWalletErc20Balance(inputToken, signerAddress, provider);
  if (walletBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero USDT0 on Polygon`);
  }

  const inputAmount = walletBalance - 20n;
  if (inputAmount === 0n) throw new Error('Balance too small');

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`Signer:          ${signerAddress}`);
  console.log(`Router:          ${ROUTER_POLYGON}`);
  console.log(`USDT0 balance:   ${ethers.formatUnits(walletBalance, 6)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, 6)} USDT0 (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(bridgeAmount, 6)}`);

  console.log('Fetching OFT quote (Polygon → Arbitrum)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchOftQuote(provider, bridgeAmount, signerAddress);
  console.log(`  nativeFee+5%:  ${ethers.formatEther(nativeFeeWithBuffer)} POL`);
  console.log(`  Est. received: ${ethers.formatUnits(amountReceivedLD, 6)} USDT0`);

  const sendData = buildOftSendCalldata(bridgeAmount, nativeFeeWithBuffer, signerAddress);

  const input: InputData = { user: signerAddress, inputToken, inputAmount };
  const fee: FeeData = { receiver: signerAddress, amount: feeAmount };
  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_POLYGON,
    inputToken,
    USDT0_OFT_ADAPTER_POLYGON,
    bridgeAmount,
  );

  const bridgeData: BridgeData = {
    target: USDT0_OFT_ADAPTER_POLYGON,
    approvalSpender: bridgeApprovalSpender,
    value: nativeFeeWithBuffer,
  };

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const execCalldata = routerIface.encodeFunctionData('bridge', [ZERO_BYTES32, input, fee, bridgeData, sendData]);

  await ensureRouterErc20Balance(signer, inputToken, ROUTER_POLYGON);
  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  console.log('Sending AllowanceHolder.exec → router.bridge...');
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    inputToken,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
    nativeFeeWithBuffer,
  );

  logTxnSummary('Polygon USDT0 → Arbitrum USDT0 (OFT) — bridge preFee', CHAIN_IDS.POLYGON, receipt);

  console.log('\nUSDT0 arrives on Arbitrum once LZ delivers the message.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
