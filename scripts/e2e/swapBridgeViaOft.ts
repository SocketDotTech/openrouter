/**
 * Script — Swap AAVE Polygon → USDT0 Polygon, then bridge to Arbitrum USDT via USDT0 OFT (LayerZero v2)
 *
 * Two independent scenarios run back-to-back (monolithic + modular each):
 *
 * Case 1 — AAVE Polygon → USDT0 Polygon (OpenOcean) → Arbitrum USDT (USDT0 OFT bridge)
 *   1. OpenOcean swap_quote: AAVE → USDT0 on Polygon (router is sender + recipient of swap)
 *   2. Approve AllowanceHolder (0x AH) for the AAVE input amount
 *   3. Post-swap fee: FEE_BPS of the OpenOcean USDT0 output amount is transferred to signer EOA
 *   4. OFT quote: quoteSend + quoteOFT on the USDT0 OFT Adapter (Polygon) to get LZ nativeFee + amountReceivedLD
 *   5. Build send() calldata: amountLD = 0 placeholder, spliced at runtime (byte offset 196)
 *   6. Execute via AllowanceHolder.exec(); msg.value = nativeFeeWithBuffer (5% buffer on LZ fee)
 *
 * Case 2 — USDT0 Polygon → Arbitrum USDT (direct OFT bridge, no swap)
 *   1. Pre-bridge fee: FEE_BPS of input USDT0 transferred to signer EOA
 *   2. OFT quote + send() calldata (same as above)
 *   3. Execute; msg.value = nativeFeeWithBuffer
 *
 * OFT mechanics (Polygon USDT0 uses OFT_ADAPTER — approval required):
 *   - Call quoteSend() + quoteOFT() on USDT0_OFT_ADAPTER_POLYGON (dstEid = ARBITRUM_LZ_EID 30110)
 *   - Approve the OFT Adapter to spend TOKENS.USDT0_POLYGON before calling send()
 *   - Pass nativeFeeWithBuffer as msg.value (POL on Polygon) so the router forwards LZ fee to the adapter
 *   - amountLD in send() is spliced at byte offset 196 from the actual post-fee token balance
 *
 * sendParam.amountLD offset derivation (same as Stargate):
 *   ABI layout after 4-byte selector:
 *     sendParam_ptr (32) | fee.nativeFee (32) | fee.lzTokenFee (32) | refundAddress (32) | tail...
 *   Tail (sendParam body):
 *     dstEid (32) | to (32) | amountLD (32) ← byte 4 + 3*32 + 2*32 = 196 from calldata start
 *
 * LZ extraOptions for USDT0 OFT (addExecutorLzReceiveOption(65000, 0)):
 *   Generated at runtime via @layerzerolabs/lz-v2-utilities Options SDK.
 *   Equivalent to: type3(0x0003) | workerId(0x01) | optLen(0x0011) | optType(0x01) | uint128(65000)
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaOft.ts all
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaOft.ts aave-usdt0-oft
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaOft.ts usdt0-direct
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
  ALLOWANCE_HOLDER,
  ARBITRUM_LZ_EID,
  USDT0_OFT_ADAPTER_POLYGON,
} from './config';
import {
  execViaAH,
  ensureAllowanceForAllowanceHolder,
} from './utils/allowanceHolder';
import {
  encodeApprove,
  encodeTransfer,
  encodeBalanceOf,
  getWalletErc20Balance,
} from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import type { ModularAction } from './utils/modularActionsBuilder/index';
import {
  MonolithicExecutionCall,
  NO_FEE,
  NO_SWAP,
  bridgeAmountPositionFlag,
  monolithicArgs,
} from './utils/contractTypes';
import { sleep } from './utils/sleep';
import { logTxnSummary } from './utils/txnLogSummary';
import {
  ensureRouterErc20Balance,
  ensureRouterApproval,
} from './utils/reproducibility';

const ROUTER_POLYGON = routerAddressForChain(CHAIN_IDS.POLYGON);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Byte offset of sendParam.amountLD within the OFT send() calldata (same as Stargate). */
const OFT_AMOUNT_LD_OFFSET = 196;

/**
 * LZ executor options for the OFT bridge: TYPE_3 + addExecutorLzReceiveOption(gas=65000, value=0).
 * Generated via the @layerzerolabs/lz-v2-utilities SDK (same as oft.service.ts in bungee-backend).
 */
const LZ_EXTRA_OPTIONS = Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex();

// ─── OFT ABI ─────────────────────────────────────────────────────────────────

/** Minimal OFT / OFT Adapter ABI for quoting and sending. */
const OFT_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];

const OFT_IFACE = new ethers.Interface(OFT_ABI);

// ─── OpenOcean quote ──────────────────────────────────────────────────────────

interface OoSwapQuoteResponse {
  data: {
    to: string;
    data: string;
    value: string;
    outAmount: string;
    minOutAmount: string;
  };
}

/**
 * Fetches an OpenOcean swap_quote for AAVE → USDT0 on Polygon.
 * The router address is used as both sender and account so tokens land in the router.
 */
async function fetchOpenOceanQuote(
  inputAmount: bigint,
  slippageBps: number = 100,
): Promise<{
  ooRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.AAVE_POLYGON,
    outTokenAddress: TOKENS.USDT0_POLYGON,
    amount: ethers.formatUnits(inputAmount, 18), // AAVE has 18 decimals
    slippage: (slippageBps / 100).toString(),
    sender: ROUTER_POLYGON,
    account: ROUTER_POLYGON,
    gasPrice: '1',
  };
  if (OPEN_OCEAN_API_KEY) {
    params.apikey = OPEN_OCEAN_API_KEY;
  }

  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.POLYGON}/swap_quote`;
  const response = await axios.get<OoSwapQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

// ─── OFT quote ────────────────────────────────────────────────────────────────

interface OftQuoteResult {
  nativeFee: bigint;
  nativeFeeWithBuffer: bigint;
  amountReceivedLD: bigint;
}

/**
 * Fetches the LZ nativeFee and expected received amount from the USDT0 OFT Adapter on Polygon.
 *
 * @param provider        JSON-RPC provider for Polygon
 * @param bridgeAmountLD  Amount of USDT0 (6 decimals on Polygon) to bridge
 * @param recipient       Recipient address on Arbitrum (also used as refundAddress)
 */
async function fetchOftQuote(
  provider: ethers.JsonRpcProvider,
  bridgeAmountLD: bigint,
  recipient: string,
): Promise<OftQuoteResult> {
  const contract = new ethers.Contract(
    USDT0_OFT_ADAPTER_POLYGON,
    OFT_ABI,
    provider,
  );
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

  const nativeFee = fee.nativeFee as bigint;
  const nativeFeeWithBuffer = (nativeFee * 105n) / 100n; // 5% buffer

  return {
    nativeFee,
    nativeFeeWithBuffer,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

// ─── OFT send() calldata builder ─────────────────────────────────────────────

/**
 * Encodes the OFT Adapter send() calldata.
 * amountLD is set to 0 as a placeholder — the router splices the actual amount
 * at byte offset 196 from the router's post-fee token balance at execution time.
 *
 * @param nativeFee   LZ fee in POL (with 5% buffer already applied)
 * @param recipient   Recipient on Arbitrum (also used as refundAddress)
 */
function buildOftSendCalldata(nativeFee: bigint, recipient: string): string {
  return OFT_IFACE.encodeFunctionData('send', [
    {
      dstEid: ARBITRUM_LZ_EID,
      to: ethers.zeroPadValue(recipient, 32),
      amountLD: 0n, // placeholder — spliced at runtime at offset 196
      minAmountLD: 0n,
      extraOptions: LZ_EXTRA_OPTIONS,
      composeMsg: '0x',
      oftCmd: '0x',
    },
    { nativeFee, lzTokenFee: 0n },
    recipient, // refundAddress
  ]);
}

// ─── Case 1: AAVE → USDT0 (OpenOcean swap) → USDT0 Base (OFT bridge) ─────────

/**
 * Monolithic for Case 1:
 *   - Swap AAVE → USDT0 via OpenOcean (swap step)
 *   - Post-swap fee: FEE_BPS of estimated USDT0 output transferred to signer
 *   - Bridge remaining USDT0 via OFT Adapter (approval required)
 *   - bridge amount position flag splices actual balance into amountLD at byte 196
 *   - bridge.value = nativeFeeWithBuffer (forwarded as LZ msg.value)
 */
function buildCase1Monolithic(
  signer: string,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouter: string,
  swapData: string,
  oftSendData: string,
  nativeFeeWithBuffer: bigint,
): MonolithicExecutionCall {
  return {
    exec: {
      input: {
        user: signer,
        inputToken: TOKENS.AAVE_POLYGON,
        inputAmount,
      },
      preFee: NO_FEE,
      swap: {
        target: ooRouter,
        approvalSpender: ooRouter,
        outputToken: TOKENS.USDT0_POLYGON,
        value: 0n,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      postFee: {
        receiver: signer,
        amount: feeAmount,
      },
      bridge: {
        target: USDT0_OFT_ADAPTER_POLYGON,
        approvalSpender: USDT0_OFT_ADAPTER_POLYGON, // adapter needs ERC-20 approval
        value: nativeFeeWithBuffer, // forwarded as LZ native fee
      },
      flags: bridgeAmountPositionFlag(OFT_AMOUNT_LD_OFFSET),
    },
    swapCallData: swapData,
    bridgeCallData: oftSendData,
  };
}

/**
 * Modular for Case 1:
 *   [0] AH.transferFrom(AAVE, signer, router, inputAmount)
 *   [1] AAVE.approve(ooRouter, inputAmount)
 *   [2] ooRouter swap calldata — AAVE → USDT0 lands in router
 *   [3] USDT0.transfer(signer, feeAmount)   — post-swap fee to signer
 *   [4] USDT0.approve(adapter, MaxUint256)  — allow adapter to pull USDT0
 *   [5] STATICCALL USDT0.balanceOf(router)  — capture post-fee balance
 *   [6] nativeCall adapter.send(...)        — spliceWord patches amountLD from [5]
 */
function buildCase1Modular(
  signer: string,
  inputAmount: bigint,
  feeAmount: bigint,
  ooRouter: string,
  swapData: string,
  oftSendData: string,
  nativeFeeWithBuffer: bigint,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.AAVE_POLYGON,
    signer,
    ROUTER_POLYGON,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.AAVE_POLYGON, encodeApprove(ooRouter, inputAmount));
  exec.call(ooRouter, swapData); // AAVE → USDT0 lands in router
  exec.call(TOKENS.USDT0_POLYGON, encodeTransfer(signer, feeAmount)); // post-swap fee
  exec.call(
    TOKENS.USDT0_POLYGON,
    encodeApprove(USDT0_OFT_ADAPTER_POLYGON, ethers.MaxUint256),
  );
  const usdt0Balance = exec.staticCall(
    TOKENS.USDT0_POLYGON,
    encodeBalanceOf(ROUTER_POLYGON),
  );
  exec
    .nativeCall(USDT0_OFT_ADAPTER_POLYGON, oftSendData, nativeFeeWithBuffer)
    .spliceWord(BigInt(OFT_AMOUNT_LD_OFFSET), usdt0Balance.returnWord());

  return exec.toActions();
}

async function executeCase1Leg(args: {
  label: string;
  useModular: boolean;
  signer: ethers.Wallet;
  signerAddress: string;
  provider: ethers.JsonRpcProvider;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const {
    label,
    useModular,
    signer,
    signerAddress,
    provider,
    inputAmount,
    routerIface,
  } = args;
  console.log(`\n── ${label} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);

  console.log('Fetching OpenOcean quote (Polygon AAVE → USDT0)...');
  const { ooRouter, swapData, estimatedOut, minAmountOut } =
    await fetchOpenOceanQuote(inputAmount);

  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  const bridgeAmount = estimatedOut - feeAmount;

  console.log(`  OO router:         ${ooRouter}`);
  console.log(`  Est. USDT0 out:    ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(
    `  Post-swap fee:     ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`,
  );
  console.log(`  Min USDT0 out:     ${ethers.formatUnits(minAmountOut, 6)}`);
  console.log(`  Bridge amount:     ${ethers.formatUnits(bridgeAmount, 6)}`);

  console.log('Fetching USDT0 OFT quote (Polygon → Arbitrum)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchOftQuote(
    provider,
    bridgeAmount,
    signerAddress,
  );

  console.log(
    `  nativeFee +5%buf:  ${ethers.formatEther(nativeFeeWithBuffer)} POL`,
  );
  console.log(
    `  Est. received:     ${ethers.formatUnits(amountReceivedLD, 6)} USDT0`,
  );

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(signer, TOKENS.USDT0_POLYGON, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, ooRouter);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDT0_POLYGON, USDT0_OFT_ADAPTER_POLYGON);

  const oftSendData = buildOftSendCalldata(nativeFeeWithBuffer, signerAddress);

  let execCalldata: string;
  if (useModular) {
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [
      buildCase1Modular(
        signerAddress,
        inputAmount,
        feeAmount,
        ooRouter,
        swapData,
        oftSendData,
        nativeFeeWithBuffer,
      ),
    ]);
  } else {
    execCalldata = routerIface.encodeFunctionData('performExecution', monolithicArgs(
      buildCase1Monolithic(
        signerAddress,
        inputAmount,
        feeAmount,
        minAmountOut,
        ooRouter,
        swapData,
        oftSendData,
        nativeFeeWithBuffer,
      ),
    ));
  }

  await ensureAllowanceForAllowanceHolder(
    signer,
    TOKENS.AAVE_POLYGON,
    inputAmount,
  );

  console.log(
    `AllowanceHolder.exec (txValue = ${ethers.formatEther(
      nativeFeeWithBuffer,
    )} ETH)...`,
  );
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
    nativeFeeWithBuffer,
  );

  logTxnSummary(
    `Arbitrum AAVE → USDT (OO swap) → Arbitrum USDT0 (OFT) — ${
      useModular ? 'Modular' : 'Monolithic'
    }`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
}

// ─── Case 2: Arbitrum USDT → Base USDT0 (direct OFT bridge, no swap) ─────────

/**
 * Monolithic for Case 2:
 *   - No swap (NO_SWAP)
 *   - Pre-bridge fee: FEE_BPS of input USDT0 transferred to signer
 *   - Bridge remaining USDT0 via OFT Adapter (approval required)
 *   - bridge amount position flag splices actual balance at byte 196
 *   - bridge.value = nativeFeeWithBuffer (forwarded as LZ msg.value)
 */
function buildCase2Monolithic(
  signer: string,
  inputAmount: bigint,
  feeAmount: bigint,
  oftSendData: string,
  nativeFeeWithBuffer: bigint,
): MonolithicExecutionCall {
  return {
    exec: {
      input: {
        user: signer,
        inputToken: TOKENS.USDT0_POLYGON,
        inputAmount,
      },
      preFee: {
        receiver: signer,
        amount: feeAmount,
      },
      swap: NO_SWAP,
      postFee: NO_FEE,
      bridge: {
        target: USDT0_OFT_ADAPTER_POLYGON,
        approvalSpender: USDT0_OFT_ADAPTER_POLYGON,
        value: nativeFeeWithBuffer,
      },
      flags: bridgeAmountPositionFlag(OFT_AMOUNT_LD_OFFSET),
    },
    swapCallData: '0x',
    bridgeCallData: oftSendData,
  };
}

/**
 * Modular for Case 2:
 *   [0] AH.transferFrom(USDT0, signer, router, inputAmount)
 *   [1] USDT0.transfer(signer, feeAmount)   — pre-bridge fee to signer
 *   [2] USDT0.approve(adapter, MaxUint256)  — allow adapter to pull USDT0
 *   [3] STATICCALL USDT0.balanceOf(router)  — capture post-fee balance
 *   [4] nativeCall adapter.send(...)        — spliceWord patches amountLD from [3]
 */
function buildCase2Modular(
  signer: string,
  inputAmount: bigint,
  feeAmount: bigint,
  oftSendData: string,
  nativeFeeWithBuffer: bigint,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.USDT0_POLYGON,
    signer,
    ROUTER_POLYGON,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.USDT0_POLYGON, encodeTransfer(signer, feeAmount)); // pre-bridge fee
  exec.call(
    TOKENS.USDT0_POLYGON,
    encodeApprove(USDT0_OFT_ADAPTER_POLYGON, ethers.MaxUint256),
  );
  const usdt0Balance = exec.staticCall(
    TOKENS.USDT0_POLYGON,
    encodeBalanceOf(ROUTER_POLYGON),
  );
  exec
    .nativeCall(USDT0_OFT_ADAPTER_POLYGON, oftSendData, nativeFeeWithBuffer)
    .spliceWord(BigInt(OFT_AMOUNT_LD_OFFSET), usdt0Balance.returnWord());

  return exec.toActions();
}

async function executeCase2Leg(args: {
  label: string;
  useModular: boolean;
  signer: ethers.Wallet;
  signerAddress: string;
  provider: ethers.JsonRpcProvider;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const {
    label,
    useModular,
    signer,
    signerAddress,
    provider,
    inputAmount,
    routerIface,
  } = args;
  console.log(`\n── ${label} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  const bridgeAmount = inputAmount - feeAmount;

  console.log(`  Input USDT0:       ${ethers.formatUnits(inputAmount, 6)}`);
  console.log(
    `  Pre-bridge fee:    ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`,
  );
  console.log(`  Net to bridge:     ${ethers.formatUnits(bridgeAmount, 6)}`);

  console.log('Fetching USDT0 OFT quote (Polygon → Arbitrum)...');
  const { nativeFeeWithBuffer, amountReceivedLD } = await fetchOftQuote(
    provider,
    bridgeAmount,
    signerAddress,
  );

  console.log(
    `  nativeFee +5%buf:  ${ethers.formatEther(nativeFeeWithBuffer)} POL`,
  );
  console.log(
    `  Est. received:     ${ethers.formatUnits(amountReceivedLD, 6)} USDT0`,
  );

  await ensureRouterErc20Balance(signer, TOKENS.USDT0_POLYGON, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDT0_POLYGON, USDT0_OFT_ADAPTER_POLYGON);

  const oftSendData = buildOftSendCalldata(nativeFeeWithBuffer, signerAddress);

  let execCalldata: string;
  if (useModular) {
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [
      buildCase2Modular(
        signerAddress,
        inputAmount,
        feeAmount,
        oftSendData,
        nativeFeeWithBuffer,
      ),
    ]);
  } else {
    execCalldata = routerIface.encodeFunctionData('performExecution', monolithicArgs(
      buildCase2Monolithic(
        signerAddress,
        inputAmount,
        feeAmount,
        oftSendData,
        nativeFeeWithBuffer,
      ),
    ));
  }

  await ensureAllowanceForAllowanceHolder(
    signer,
    TOKENS.USDT0_POLYGON,
    inputAmount,
  );

  console.log(
    `AllowanceHolder.exec (txValue = ${ethers.formatEther(
      nativeFeeWithBuffer,
    )} ETH)...`,
  );
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.USDT0_POLYGON,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
    nativeFeeWithBuffer,
  );

  logTxnSummary(
    `Polygon USDT → Arbitrum USDT0 (OFT direct) — ${
      useModular ? 'Modular' : 'Monolithic'
    }`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
}

// ─── Case runners ─────────────────────────────────────────────────────────────

async function runCase1(
  signer: ethers.Wallet,
  signerAddress: string,
  routerIface: ethers.Interface,
): Promise<void> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(
    'CASE 1: Polygon AAVE → USDT0 (OpenOcean) → Arbitrum USDT0 (OFT bridge)',
  );
  console.log('═'.repeat(70));

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signerOnChain = signer.connect(provider);

  const { balance: walletBalance } = await getWalletErc20Balance(
    TOKENS.AAVE_POLYGON,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Case 1: signer ${signerAddress} has zero AAVE on Polygon. Fund ${TOKENS.AAVE_POLYGON}.`,
    );
  }

  const legAmount = (walletBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error('Case 1: AAVE balance too small to split into two halves.');
  }

  console.log(
    `Input token (AAVE): ${ethers.formatUnits(
      walletBalance,
      18,
    )} (full balance)`,
  );
  console.log(`Per leg:            ${ethers.formatUnits(legAmount, 18)}`);

  await executeCase1Leg({
    label: '1/2',
    useModular: false,
    signer: signerOnChain,
    signerAddress,
    provider,
    inputAmount: legAmount,
    routerIface,
  });

  console.log('\nSleeping 3s before modular leg...');
  await sleep(3000);

  await executeCase1Leg({
    label: '2/2',
    useModular: true,
    signer: signerOnChain,
    signerAddress,
    provider,
    inputAmount: legAmount,
    routerIface,
  });
}

async function runCase2(
  signer: ethers.Wallet,
  signerAddress: string,
  routerIface: ethers.Interface,
): Promise<void> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(
    'CASE 2: Polygon USDT0 → Arbitrum USDT0 (direct OFT bridge, no swap)',
  );
  console.log('═'.repeat(70));

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signerOnChain = signer.connect(provider);

  const { balance: walletBalance } = await getWalletErc20Balance(
    TOKENS.USDT0_POLYGON,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Case 2: signer ${signerAddress} has zero USDT0 on Polygon. Fund ${TOKENS.USDT0_POLYGON}.`,
    );
  }

  const legAmount = (walletBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error(
      'Case 2: USDT0 balance too small to split into two halves.',
    );
  }

  console.log(
    `Input token (USDT0): ${ethers.formatUnits(
      walletBalance,
      6,
    )} (full balance)`,
  );
  console.log(`Per leg:             ${ethers.formatUnits(legAmount, 6)}`);

  await executeCase2Leg({
    label: '1/2',
    useModular: false,
    signer: signerOnChain,
    signerAddress,
    provider,
    inputAmount: legAmount,
    routerIface,
  });

  console.log('\nSleeping 3s before modular leg...');
  await sleep(3000);

  await executeCase2Leg({
    label: '2/2',
    useModular: true,
    signer: signerOnChain,
    signerAddress,
    provider,
    inputAmount: legAmount,
    routerIface,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const signer = new ethers.Wallet(privateKey);
  const signerAddress = await signer.getAddress();
  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log(`Signer:  ${signerAddress}`);
  console.log(`Router:  ${ROUTER_POLYGON}`);

  const caseArg = process.argv[2]?.toLowerCase();

  if (caseArg === 'usdt0-direct') {
    await runCase2(signer, signerAddress, routerIface);
    console.log(
      '\nCase 2 complete — USDT0 arrives on Arbitrum once LZ delivers the message.',
    );
    return;
  }
  if (caseArg === 'aave-usdt0-oft') {
    await runCase1(signer, signerAddress, routerIface);
    console.log(
      '\nCase 1 complete — USDT0 arrives on Arbitrum once LZ delivers the message.',
    );
    return;
  }

  console.error(
    `Unknown case: ${caseArg}. Use: all | aave-usdt0-oft | usdt0-direct`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
