/**
 * Route:  Mantle MNT (native) → USDC (OpenOcean) → Base USDC (Stargate USDC Pool)
 * Function: swapAndBridge
 * Fee: postFee — FEE_BPS of estimatedOut USDC deducted after swap
 *
 * Input is native MNT; msg.value = ooSwapNativeWei + nativeFeeWithBuffer.
 * swap.value = MNT forwarded to OO router; bridge.value = nativeFeeWithBuffer (LZ fee).
 * Bridge amount position flag splices actual post-fee USDC balance at byte 196.
 *
 * For native-input cases this script must be run with sufficient MNT balance.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/stargate/mantleMntUsdcBase.swapAndBridge.postFee.ts
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
  NATIVE_TOKEN_ADDRESS,
  STARGATE_USDC_MANTLE,
  BASE_LZ_EID,
  STARGATE_AMOUNT_LD_OFFSET,
} from '../config';
import { execViaAH } from '../utils/allowanceHolder';
import { ROUTER_ABI } from '../utils/routerAbi';
import {
  POST_FEE_FLAG,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  bridgeAmountPositionFlag,
  swapAndBridgeArgs,
} from '../utils/contractTypes';
import { logTxnSummary } from '../utils/txnLogSummary';
import { ensureRouterErc20Balance, ensureRouterNativeBalance } from '../utils/reproducibility';
import { resolveApprovalSpender } from '../utils/routerAllowance';

const ROUTER_MANTLE = routerAddressForChain(CHAIN_IDS.MANTLE);
const FLAGS = POST_FEE_FLAG | bridgeAmountPositionFlag(STARGATE_AMOUNT_LD_OFFSET);
/** Max share of wallet MNT used for swap input + Stargate LZ fee; remainder covers tx gas. */
const NATIVE_SPEND_BPS = 8000n;

const STARGATE_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];
const STARGATE_IFACE = new ethers.Interface(STARGATE_ABI);

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
    outTokenAddress: TOKENS.USDC_MANTLE,
    amount: ethers.formatEther(inputAmountWei),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: ROUTER_MANTLE,
    account: ROUTER_MANTLE,
    gasPrice: '1',
  };
  if (OPEN_OCEAN_API_KEY) {
    params.apikey = OPEN_OCEAN_API_KEY;
  }
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.MANTLE}/swap_quote`;
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

async function fetchStargateQuote(
  provider: ethers.JsonRpcProvider,
  bridgeAmountLD: bigint,
  recipient: string,
): Promise<{ nativeFeeWithBuffer: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(STARGATE_USDC_MANTLE, STARGATE_ABI, provider);
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = {
    dstEid: BASE_LZ_EID,
    to: to32,
    amountLD: bridgeAmountLD,
    minAmountLD: 0n,
    extraOptions: '0x',
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

function buildStargateCalldata(nativeFee: bigint, recipient: string): string {
  return STARGATE_IFACE.encodeFunctionData('send', [
    {
      dstEid: BASE_LZ_EID,
      to: ethers.zeroPadValue(recipient, 32),
      amountLD: 0n,
      minAmountLD: 0n,
      extraOptions: '0x',
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

  const provider = new ethers.JsonRpcProvider(RPC.MANTLE);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const rawBalance = await provider.getBalance(signerAddress);
  if (rawBalance === 0n) {
    throw new Error(`Signer ${signerAddress} has zero MNT on Mantle`);
  }

  const nativeSpendBudget = (rawBalance * NATIVE_SPEND_BPS) / 10000n;
  if (nativeSpendBudget <= 20n) {
    throw new Error('MNT balance too small for 80% spend budget');
  }

  let inputAmountWei = nativeSpendBudget - 20n;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_MANTLE}`);
  console.log(`MNT balance:   ${ethers.formatEther(rawBalance)}`);
  console.log(
    `Spend budget:  ${ethers.formatEther(nativeSpendBudget)} MNT (${Number(NATIVE_SPEND_BPS) / 100}% for input + LZ fee)`,
  );

  const routerIface = new ethers.Interface(ROUTER_ABI);

  let ooRouter = '';
  let swapData = '';
  let nativeSwapWei = 0n;
  let feeAmount = 0n;
  let estimatedBridgeAmount = 0n;
  let minAmountOut = 0n;
  let nativeFeeWithBuffer = 0n;
  let amountReceivedLD = 0n;

  for (let iter = 0; iter < 6; iter++) {
    console.log('Fetching OpenOcean quote (MNT → USDC)...');
    const q = await fetchOpenOceanQuote(inputAmountWei);
    ooRouter = q.ooRouter;
    swapData = q.swapData;
    nativeSwapWei = q.nativeSwapWei;
    feeAmount = bpsOf(q.estimatedOut, FEE_BPS);
    estimatedBridgeAmount = q.estimatedOut - feeAmount;
    minAmountOut = q.minAmountOut;
    console.log(`  OO router:   ${ooRouter}`);
    console.log(`  Est. USDC:   ${ethers.formatUnits(q.estimatedOut, 6)}`);
    console.log(`  Post-fee:    ${ethers.formatUnits(feeAmount, 6)} USDC`);

    console.log('Fetching Stargate quote (Mantle → Base USDC pool)...');
    ({ nativeFeeWithBuffer, amountReceivedLD } = await fetchStargateQuote(
      provider,
      estimatedBridgeAmount,
      signerAddress,
    ));
    console.log(`  nativeFee+5%: ${ethers.formatEther(nativeFeeWithBuffer)} MNT`);
    console.log(`  Est. received: ${ethers.formatUnits(amountReceivedLD, 6)} USDC`);

    const maxInput = nativeSpendBudget - nativeFeeWithBuffer;
    if (maxInput <= 0n) {
      throw new Error(
        `80% spend budget (${ethers.formatEther(nativeSpendBudget)} MNT) cannot cover LZ fee (${ethers.formatEther(nativeFeeWithBuffer)} MNT)`,
      );
    }
    if (inputAmountWei <= maxInput) {
      break;
    }
    console.warn(
      `  Capping swap input from ${ethers.formatEther(inputAmountWei)} to ${ethers.formatEther(maxInput)} MNT (input + LZ fee <= 80% budget)`,
    );
    inputAmountWei = maxInput;
  }

  console.log(`  Swap input:    ${ethers.formatEther(inputAmountWei)} MNT`);
  console.log(`  Tx value:      ${ethers.formatEther(inputAmountWei + nativeFeeWithBuffer)} MNT`);

  await ensureRouterErc20Balance(signer, TOKENS.USDC_MANTLE, ROUTER_MANTLE);
  await ensureRouterNativeBalance(signer, ROUTER_MANTLE);

  const bridgeApprovalSpender = await resolveApprovalSpender(
    provider,
    ROUTER_MANTLE,
    TOKENS.USDC_MANTLE,
    STARGATE_USDC_MANTLE,
    estimatedBridgeAmount,
  );

  const rawOoWei = nativeSwapWei > 0n ? nativeSwapWei : inputAmountWei;
  const mntToOo = rawOoWei <= inputAmountWei ? rawOoWei : inputAmountWei;

  const stargateSendData = buildStargateCalldata(nativeFeeWithBuffer, signerAddress);

  const txValue = inputAmountWei + nativeFeeWithBuffer;
  const callData = routerIface.encodeFunctionData(
    'swapAndBridge',
    swapAndBridgeArgs(
      ZERO_BYTES32,
      FLAGS,
      { user: signerAddress, inputToken: NATIVE_TOKEN_ADDRESS, inputAmount: inputAmountWei },
      { receiver: signerAddress, amount: feeAmount },
      {
        target: ooRouter,
        approvalSpender: ZERO_ADDRESS,
        outputToken: TOKENS.USDC_MANTLE,
        value: mntToOo,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      swapData,
      {
        target: STARGATE_USDC_MANTLE,
        approvalSpender: bridgeApprovalSpender,
        value: nativeFeeWithBuffer,
      },
      stargateSendData,
    ),
  );

  const receipt = await execViaAH(
    signer,
    ROUTER_MANTLE,
    NATIVE_TOKEN_ADDRESS,
    inputAmountWei,
    ROUTER_MANTLE,
    callData,
    txValue,
  );

  logTxnSummary(
    'Mantle MNT → USDC (OO) → Base USDC (Stargate) — swapAndBridge postFee',
    CHAIN_IDS.MANTLE,
    receipt,
  );

  console.log('\nUSDC arrives on Base once LZ delivers the message.');

  void amountReceivedLD;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
