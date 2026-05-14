/**
 * Stargate e2e test script — three independent cases, each running a
 * monolithic leg followed (after a 3-second pause) by a modular leg.
 *
 * Case 1  Arbitrum USDC  →  OO swap → native ETH  →  Stargate Native ETH Pool  →  Base ETH
 * Case 2  Polygon  USDC  →  (no swap)              →  Stargate USDC Pool        →  Base USDC
 * Case 3  Base     USDC  →  OO swap → native ETH  →  Stargate Native ETH Pool  →  Arb  ETH
 * Case 4  Polygon POL    →  OO swap → Polygon USDT0  →  USDT0 OFT Adapter       →  Arbitrum USDT0
 *
 * Native-pool mechanics (cases 1 & 3):
 *   send() requires msg.value >= amountLD + nativeFee (StargatePoolNative._assertMessagingFee).
 *   Monolithic: useFinalAmountAsValue=true (router forwards actualFinalAmount as msg.value).
 *               amountLD = minAmountOut - fee - nativeFeeWithBuffer; positions=[].
 *               Since actual >= min (OO slippage), msg.value >= amountLD + nativeFeeWithBuffer ✓
 *   Modular:    amountLD = minAmountOut - fee - nativeFeeWithBuffer (same).
 *               nativeCall Stargate with value = amountLD + nativeFeeWithBuffer = minAmountOut - fee.
 *
 * ERC20-pool mechanics (case 2):
 *   send() uses ERC20 transferFrom for USDC; msg.value = nativeFee only.
 *   Monolithic: useFinalAmountAsValue=false, amountPositions=[196n], bridge.value=nativeFeeWithBuffer.
 *   Modular:    staticCall USDC.balanceOf(router) → spliceWord(196n) into Stargate calldata.
 *               nativeCall Stargate with value = nativeFeeWithBuffer.
 *
 * Case selection (required) — same idea as `bridgeViaRelay.ts` / `swapBridgeViaCctp.ts`:
 *   Pass a scenario as the first CLI arg, or set `STARGATE_E2E_CASE` when your runner
 *   cannot pass argv.
 *
 *   1 / arb-usdc-base-eth     Arbitrum USDC → OO → native ETH → Stargate native → Base ETH
 *   2 / polygon-usdc-base     Polygon USDC → Stargate USDC pool → Base USDC (no swap)
 *   3 / base-usdc-arb-eth     Base USDC → OO → native ETH → Stargate native → Arbitrum ETH
 *   4 / polygon-pol-usdt0-arb     Polygon POL → OO → Polygon USDT0 → LZ OFT Adapter → Arb USDT0
 *                                   msg.value = inputPOL used in OO swap + LZ nativeFee (POL)
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-usdc-base-eth
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts polygon-pol-usdt0-arb direct
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts polygon-pol-usdt0-arb allowance-holder
 *   STARGATE_E2E_CASE=4 STARGATE_ROUTER_EXEC=direct PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts
 *
 * Router execution (`argv[3]` overrides `STARGATE_ROUTER_EXEC`):
 *
 * | Mode                | Behaviour |
 * |---------------------|-----------|
 * | `direct`            | Signer sends tx directly to router with `{ value }` |
 * | `allowance-holder`  | `AllowanceHolder.exec` wraps router (`msg.value` + ERC-2771 user suffix) |
 *
 * **Native-token input (case 4):** choose explicitly — either pass `direct` or `allowance-holder` as argv[3],
 * or set `STARGATE_ROUTER_EXEC`. There is no default; ambiguous runs exit with usage.
 *
 * **ERC20 input (cases 1–3):** defaults to `allowance-holder`; `direct` is rejected (AH pull required).
 *
 * Router per source chain: `ROUTER_BY_CHAIN_ID` / `routerAddressForChain(chainId)` in config.ts (`ROUTER_CHAIN_<id>` overrides).
 *
 * Bridge note: Case 4 uses LayerZero **`send`** on {@link USDT0_OFT_ADAPTER_POLYGON}, not Stargate.
 * ABI matches Stargate pool `send`; `lzExtraOptions` uses TYPE_3 executor gas (same as `swapBridgeViaOft.ts`).
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
  ALLOWANCE_HOLDER,
  NATIVE_TOKEN_ADDRESS,
  STARGATE_NATIVE_ARB,
  STARGATE_NATIVE_BASE,
  STARGATE_USDC_POLYGON,
  USDT0_OFT_ADAPTER_POLYGON,
  BASE_LZ_EID,
  ARBITRUM_LZ_EID,
  STARGATE_AMOUNT_LD_OFFSET,
} from './config';
import { execViaAH, execDirect, ensureAllowanceForAllowanceHolder } from './utils/allowanceHolder';
import {
  encodeApprove,
  encodeTransfer,
  encodeBalanceOf,
  getWalletErc20Balance,
} from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import type { ModularAction } from './utils/modularActionsBuilder/index';
import { MonolithicExecution, NO_FEE, NO_SWAP, ZERO_ADDRESS } from './utils/contractTypes';
import { sleep } from './utils/sleep';
import { logTxnSummary } from './utils/txnLogSummary';

/**
 * LZ extra options for Polygon USDT0 OFT Adapter `send()` (executor gas).
 * Mirrors `swapBridgeViaOft.ts`.
 */
const LZ_EXTRA_OPTIONS_POLYGON_USDT0 = Options.newOptions().addExecutorLzReceiveOption(65000, 0).toHex();

// ─── Case configuration ───────────────────────────────────────────────────────

/**
 * Describes a Stargate test case.  `ooSwap` being null means case 2 (no swap — input
 * token goes directly to Stargate).  `isNativePool` drives the bridge mechanics.
 */
interface OoSwapConfig {
  inToken: string;
  outToken: string;
  inDecimals: number;
  chainId: number;
  gasPrice: string;
}

interface CaseConfig {
  name: string;
  sourceChainId: number;
  rpc: string;
  inputToken: string;
  inputDecimals: number;
  /** true when inputToken is native (POL/ETH/BNB); exec mode must be set explicitly (`direct` | `allowance-holder`) */
  isNativeInput: boolean;
  ooSwap: OoSwapConfig | null; // null → skip OO swap, bridge input token directly
  /** Contract that receives LZ `send` calldata — Stargate pool or LZ OFT adapter (same ABI shape). */
  bridgeContract: string;
  /** `extraOptions` in SendParam (`0x` for Stargate pools; encoded TYPE_3 for USDT0 OFT on Polygon). */
  lzExtraOptions: string;
  isNativePool: boolean;
  destLzEid: number;
}

const CASES: CaseConfig[] = [
  {
    name: 'Arbitrum USDC → ETH (OO) → Base ETH (Stargate Native Pool)',
    sourceChainId: CHAIN_IDS.ARBITRUM,
    rpc: RPC.ARBITRUM,
    inputToken: TOKENS.USDC_ARB,
    inputDecimals: 6,
    isNativeInput: false,
    ooSwap: {
      inToken: TOKENS.USDC_ARB,
      outToken: NATIVE_TOKEN_ADDRESS,
      inDecimals: 6,
      chainId: CHAIN_IDS.ARBITRUM,
      gasPrice: '1',
    },
    bridgeContract: STARGATE_NATIVE_ARB,
    lzExtraOptions: '0x',
    isNativePool: true,
    destLzEid: BASE_LZ_EID,
  },
  {
    name: 'Polygon USDC → Base USDC (Stargate USDC Pool, no swap)',
    sourceChainId: CHAIN_IDS.POLYGON,
    rpc: RPC.POLYGON,
    inputToken: TOKENS.USDC_POLYGON_CIRCLE,
    inputDecimals: 6,
    isNativeInput: false,
    ooSwap: null, // skip OO swap — bridge USDC directly
    bridgeContract: STARGATE_USDC_POLYGON,
    lzExtraOptions: '0x',
    isNativePool: false,
    destLzEid: BASE_LZ_EID,
  },
  {
    name: 'Base USDC → ETH (OO) → Arbitrum ETH (Stargate Native Pool)',
    sourceChainId: CHAIN_IDS.BASE,
    rpc: RPC.BASE,
    inputToken: TOKENS.USDC_BASE,
    inputDecimals: 6,
    isNativeInput: false,
    ooSwap: {
      inToken: TOKENS.USDC_BASE,
      outToken: NATIVE_TOKEN_ADDRESS,
      inDecimals: 6,
      chainId: CHAIN_IDS.BASE,
      gasPrice: '1',
    },
    bridgeContract: STARGATE_NATIVE_BASE,
    lzExtraOptions: '0x',
    isNativePool: true,
    destLzEid: ARBITRUM_LZ_EID,
  },
  {
    // Polygon native POL → USDT0 via OpenOcean → Arbitrum USDT0 via USDT0 OFT Adapter on Polygon (LayerZero `send`).
    name: 'Polygon POL → USDT0 (OO) → Arbitrum USDT0 (LZ OFT Adapter)',
    sourceChainId: CHAIN_IDS.POLYGON,
    rpc: RPC.POLYGON,
    inputToken: NATIVE_TOKEN_ADDRESS,
    inputDecimals: 18,
    isNativeInput: true,
    ooSwap: {
      inToken: NATIVE_TOKEN_ADDRESS,
      outToken: TOKENS.USDT0_POLYGON,
      inDecimals: 18,
      chainId: CHAIN_IDS.POLYGON,
      gasPrice: '1',
    },
    bridgeContract: USDT0_OFT_ADAPTER_POLYGON,
    lzExtraOptions: LZ_EXTRA_OPTIONS_POLYGON_USDT0,
    isNativePool: false,
    destLzEid: ARBITRUM_LZ_EID,
  },
];

/** Slug aliases (and `1`/`2`/`3`/`4`) → index in `CASES`. */
const STARGATE_SCENARIO_ALIASES: Record<string, number> = {
  '1': 0,
  'arb-usdc-base-eth': 0,
  'arb-native-base': 0,
  'arbitrum-usdc-base-eth': 0,

  '2': 1,
  'polygon-usdc-base': 1,
  'usdc-polygon-base': 1,

  '3': 2,
  'base-usdc-arb-eth': 2,
  'base-native-arb': 2,

  '4': 3,
  'polygon-pol-usdt0-arb': 3,
  'polygon-pol-arb-usdt0': 3,
  'pol-native-usdt0-arb': 3,
};

/**
 * Resolves scenario from CLI (`process.argv[2]`) or `STARGATE_E2E_CASE`, then
 * returns the matching `CaseConfig`. Fails fast with a usage message if unset/unknown.
 */
function resolveScenarioConfig(): CaseConfig {
  const raw = (process.argv[2] ?? process.env.STARGATE_E2E_CASE ?? '').trim().toLowerCase();
  if (!raw) {
    console.error(
      'Missing scenario. Pass argv[2] or set STARGATE_E2E_CASE. Examples:\n' +
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-usdc-base-eth\n' +
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts polygon-usdc-base\n' +
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts base-usdc-arb-eth\n' +
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts polygon-pol-usdt0-arb\n' +
        'Or use numeric slugs 1 | 2 | 3 | 4.',
    );
    process.exit(1);
  }
  const idx = STARGATE_SCENARIO_ALIASES[raw];
  if (idx === undefined || !CASES[idx]) {
    console.error(`Unknown Stargate e2e scenario "${raw}". Valid: ${Object.keys(STARGATE_SCENARIO_ALIASES).sort().join(', ')}`);
    process.exit(1);
  }
  return CASES[idx];
}

/** How the signer reaches the router: direct `eth_sendTransaction`, or wrapped `AllowanceHolder.exec`. */
type RouterExecRoute = 'direct' | 'allowance-holder';

/** argv[3] / `STARGATE_ROUTER_EXEC` tokens → canonical route. */
const ROUTER_EXEC_ALIASES: Record<string, RouterExecRoute> = {
  direct: 'direct',
  dr: 'direct',
  router: 'direct',

  'allowance-holder': 'allowance-holder',
  ah: 'allowance-holder',
  exec: 'allowance-holder',
};

/**
 * Resolves execution transport: **`argv[3]` overrides `STARGATE_ROUTER_EXEC`** when non-empty after trim.
 *
 * - **Native-token input (`isNativeInput`):** caller **must** set `direct` or `allowance-holder` explicitly
 *   — no silent default — so AH vs signer→router stays a deliberate choice.
 * - **ERC20 input:** defaults to `allowance-holder`; `direct` is rejected (`AllowanceHolder.transferFrom` pull).
 */
function resolveRouterExecRoute(cfg: CaseConfig): RouterExecRoute {
  const rawArg = typeof process.argv[3] === 'string' ? process.argv[3].trim().toLowerCase() : '';
  const rawEnv = (process.env.STARGATE_ROUTER_EXEC ?? '').trim().toLowerCase();
  const raw = rawArg || rawEnv;

  const resolveExplicit = (): RouterExecRoute | null => {
    if (!raw) {
      return null;
    }
    const route = ROUTER_EXEC_ALIASES[raw];
    if (!route) {
      console.error(
        `Unknown router exec "${raw}". Use argv[3] or STARGATE_ROUTER_EXEC: direct | allowance-holder (aliases dr, router, ah, exec).`,
      );
      process.exit(1);
    }
    return route;
  };

  const route = resolveExplicit();
  if (route !== null) {
    if (!cfg.isNativeInput && route === 'direct') {
      console.error(
        'ERC20 input cases cannot use direct router txs: `_pullFromUser` invokes AllowanceHolder.transferFrom, which needs the ephemeral allowance set by AH.exec.',
      );
      process.exit(1);
    }
    return route;
  }

  if (cfg.isNativeInput) {
    console.error(
      [
        'Native-token input scenarios require an explicit router exec mode (no default).',
        '',
        '  argv[3]                       STARGATE_ROUTER_EXEC',
        '  -----------------------------  ------------------------------',
        '  direct                         direct',
        '  allowance-holder   (aliases: ah, exec)',
        '',
        'Examples:',
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts polygon-pol-usdt0-arb direct',
        '  STARGATE_ROUTER_EXEC=allowance-holder ts-node scripts/e2e/swapBridgeViaStargateNative.ts 4',
      ].join('\n'),
    );
    process.exit(1);
  }

  return 'allowance-holder';
}

// ─── Shared Stargate ABI ──────────────────────────────────────────────────────

/** Minimal Stargate pool ABI fragments — identical for native and ERC20 pools. */
const STARGATE_ABI = [
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];

const STARGATE_IFACE = new ethers.Interface(STARGATE_ABI);

// ─── OpenOcean quote ──────────────────────────────────────────────────────────

interface OoQuoteResponse {
  data: {
    to: string;
    data: string;
    /** wei to forward with OO call for native-token sells (omit or "0" for ERC20 sells) */
    value?: string;
    outAmount: string;
    minOutAmount: string;
  };
}

/**
 * Fetches an OpenOcean swap_quote.
 * `amount` is in the input token's native units (raw bigint).
 */
async function fetchOoQuote(
  cfg: OoSwapConfig,
  routerAddress: string,
  amount: bigint,
  slippageBps: number = 100,
): Promise<{
  ooRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
  /** OO-recommended wei for swap calldata (`value` field); prefer over raw `amount` when &gt; 0 */
  nativeSwapWei: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: cfg.inToken,
    outTokenAddress: cfg.outToken,
    amount: ethers.formatUnits(amount, cfg.inDecimals),
    slippage: (slippageBps / 100).toString(),
    sender: routerAddress,
    account: routerAddress,
    gasPrice: cfg.gasPrice,
  };
  if (OPEN_OCEAN_API_KEY) {
    params.apikey = OPEN_OCEAN_API_KEY;
  }
  const url = `https://open-api.openocean.finance/v3/${cfg.chainId}/swap_quote`;
  const response = await axios.get<OoQuoteResponse>(url, { params });
  const q = response.data.data;
  const nativeSwapWeiRaw = q.value !== undefined && q.value !== '' ? BigInt(q.value) : 0n;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
    nativeSwapWei: nativeSwapWeiRaw,
  };
}

// ─── Stargate quote ───────────────────────────────────────────────────────────

/**
 * Fetches the LZ nativeFee and expected receive amount from Stargate.
 *
 * @param pool             Pool contract address on the source chain
 * @param provider         Provider for the source chain
 * @param destLzEid        LayerZero destination EID
 * @param recipient        Recipient on destination (also refundAddress)
 * @param bridgeAmountLD   Tentative bridge amount for the quote
 * @param extraOptions      `SendParam.extraOptions` — `'0x'` for Stargate pools; LZ TYPE_3 for USDT0 OFT adapter
 */
async function fetchStargateQuote(
  pool: string,
  provider: ethers.JsonRpcProvider,
  destLzEid: number,
  recipient: string,
  bridgeAmountLD: bigint,
  extraOptions: string,
): Promise<{ nativeFee: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(pool, STARGATE_ABI, provider);
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = {
    dstEid: destLzEid,
    to: to32,
    amountLD: bridgeAmountLD,
    minAmountLD: 0n,
    extraOptions,
    composeMsg: '0x',
    oftCmd: '0x',
  };
  const [fee, oft] = await Promise.all([
    contract.quoteSend(sendParam, false),
    contract.quoteOFT(sendParam),
  ]);
  return {
    nativeFee: fee.nativeFee as bigint,
    amountReceivedLD: oft.oftReceipt.amountReceivedLD as bigint,
  };
}

// ─── Stargate calldata builder ────────────────────────────────────────────────

/**
 * Encodes Stargate send() calldata.
 *
 * For native pools:  pass a pre-computed amountLD; no splice required.
 * For ERC20 pools:   pass amountLD=0 as a placeholder; caller splices the
 *                    real amount at STARGATE_AMOUNT_LD_OFFSET (196 bytes).
 *
 * @param destLzEid    Destination LZ endpoint ID
 * @param nativeFee    LZ fee in source-chain native token (with buffer)
 * @param recipient    Recipient address on destination chain
 * @param amountLD     Explicit amountLD (for native pools); 0n for ERC20 pools
 * @param extraOptions `SendParam.extraOptions`
 */
function buildStargateCalldata(
  destLzEid: number,
  nativeFee: bigint,
  recipient: string,
  amountLD: bigint,
  extraOptions: string,
): string {
  return STARGATE_IFACE.encodeFunctionData('send', [
    {
      dstEid: destLzEid,
      to: ethers.zeroPadValue(recipient, 32),
      amountLD,
      minAmountLD: 0n,
      extraOptions,
      composeMsg: '0x',
      oftCmd: '0x',
    },
    { nativeFee, lzTokenFee: 0n },
    recipient, // refundAddress
  ]);
}

// ─── Monolithic builders ──────────────────────────────────────────────────────

/**
 * Monolithic for native-pool cases (cases 1 & 3):
 *   - OO swap input token → native ETH
 *   - useFinalAmountAsValue=true: router forwards actualFinalETH as msg.value to Stargate
 *   - amountLD = minAmountOut - fee - nativeFeeWithBuffer; pre-encoded; no splice needed (positions=[])
 *   - StargatePoolNative checks msg.value >= amountLD + nativeFee; satisfied since actual >= min
 */
function buildNativePoolMonolithic(
  signer: string,
  cfg: CaseConfig,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouter: string,
  swapData: string,
  stargateData: string,
): MonolithicExecution {
  return {
    input: { user: signer, inputToken: cfg.inputToken, inputAmount },
    preFee: NO_FEE,
    swap: {
      target: ooRouter,
      approvalSpender: ooRouter,
      outputToken: NATIVE_TOKEN_ADDRESS,
      value: 0n,
      minOutput: minAmountOut,
      data: swapData,
      returnDataWordOffset: 0n,
    },
    postFee: { receiver: signer, amount: feeAmount },
    bridge: {
      target: cfg.bridgeContract,
      approvalSpender: ZERO_ADDRESS, // no ERC20 approval for native ETH
      value: 0n,                     // ignored when useFinalAmountAsValue=true
      data: stargateData,
      amountPositions: [],            // amountLD is pre-encoded
      useFinalAmountAsValue: true,    // forward actualFinalETH as msg.value
    },
  };
}

/**
 * Monolithic for ERC20-pool case (case 2):
 *   - No OO swap (NO_SWAP) — input USDC goes directly to bridge
 *   - useFinalAmountAsValue=false: USDC transferred via ERC20 approval
 *   - amountPositions=[196n]: router splices finalAmount into amountLD at runtime
 *   - bridge.value=nativeFeeWithBuffer: forwarded as msg.value for the LZ fee
 */
function buildErc20PoolMonolithic(
  signer: string,
  cfg: CaseConfig,
  inputAmount: bigint,
  feeAmount: bigint,
  stargateData: string,
  nativeFeeWithBuffer: bigint,
): MonolithicExecution {
  return {
    input: { user: signer, inputToken: cfg.inputToken, inputAmount },
    preFee: NO_FEE,
    swap: NO_SWAP, // skip swap — finalToken = inputToken, finalAmount = inputAmount - preFee
    postFee: { receiver: signer, amount: feeAmount },
    bridge: {
      target: cfg.bridgeContract,
      approvalSpender: cfg.bridgeContract, // router must approve USDC to pool
      value: nativeFeeWithBuffer,         // POL/native forwarded as LZ fee msg.value
      data: stargateData,
      amountPositions: [BigInt(STARGATE_AMOUNT_LD_OFFSET)], // splice at byte 196
      useFinalAmountAsValue: false,
    },
  };
}

// ─── Modular builders ─────────────────────────────────────────────────────────

/**
 * Modular for native-pool cases (cases 1 & 3):
 *   [0] AH.transferFrom input token
 *   [1] approve(ooRouter, inputAmount)
 *   [2] OO swap → native ETH lands in router
 *   [3] nativeCall: send fee ETH to signer
 *   [4] nativeCall: Stargate send() with value = amountLD + nativeFeeWithBuffer = minAmountOut - fee
 *
 * amountLD (from stargateData) = minAmountOut - fee - nativeFeeWithBuffer.
 * StargatePoolNative check: msg.value >= amountLD + nativeFee;
 * bridgeValue = amountLD + nativeFeeWithBuffer >= amountLD + nativeFee ✓
 * Any ETH surplus over minAmountOut stays in the router as unspent value.
 */
function buildNativePoolModularActions(
  signer: string,
  routerAddress: string,
  cfg: CaseConfig,
  inputAmount: bigint,
  feeAmount: bigint,
  nativeFeeWithBuffer: bigint,
  minAmountOut: bigint,
  ooRouter: string,
  swapData: string,
  stargateData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();

  exec.call(
    ALLOWANCE_HOLDER,
    ahIface.encodeFunctionData('transferFrom', [cfg.inputToken, signer, routerAddress, inputAmount]),
  );
  exec.call(cfg.inputToken, encodeApprove(ooRouter, inputAmount));
  exec.call(ooRouter, swapData); // USDC → native ETH lands in router
  exec.nativeCall(signer, '0x', feeAmount); // post-swap fee in ETH
  // Bridge: value = amountLD + nativeFeeWithBuffer = minAmountOut - feeAmount
  const bridgeValue = minAmountOut - feeAmount;
  exec.nativeCall(cfg.bridgeContract, stargateData, bridgeValue);

  return exec.toActions();
}

/**
 * Modular for ERC20-pool case (case 2):
 *   [0] AH.transferFrom USDC
 *   [1] USDC.transfer(signer, fee)
 *   [2] USDC.approve(stargatePool, MaxUint256)
 *   [3] STATICCALL USDC.balanceOf(router) — return value spliced into [4]
 *   [4] nativeCall: Stargate send() with nativeFeeWithBuffer POL;
 *       splicePayloadWord(STARGATE_AMOUNT_LD_OFFSET): CALL_WITH_NATIVE data is
 *       [32-byte native value prefix][ethers send calldata]; amountLD stays at +196
 *       within the payload slice (matches OpenOceanStargateNativeOpenRouterPoC.t.sol).
 */
function buildErc20PoolModularActions(
  signer: string,
  routerAddress: string,
  cfg: CaseConfig,
  inputAmount: bigint,
  feeAmount: bigint,
  nativeFeeWithBuffer: bigint,
  stargateData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();

  exec.call(
    ALLOWANCE_HOLDER,
    ahIface.encodeFunctionData('transferFrom', [cfg.inputToken, signer, routerAddress, inputAmount]),
  );
  exec.call(cfg.inputToken, encodeTransfer(signer, feeAmount)); // USDC fee to signer
  exec.call(cfg.inputToken, encodeApprove(cfg.bridgeContract, ethers.MaxUint256));
  const usdcBalance = exec.staticCall(cfg.inputToken, encodeBalanceOf(routerAddress));
  exec
    .nativeCall(cfg.bridgeContract, stargateData, nativeFeeWithBuffer)
    .splicePayloadWord(BigInt(STARGATE_AMOUNT_LD_OFFSET), usdcBalance.returnWord());

  return exec.toActions();
}

/**
 * Fallback gas reserve used in `runCase` when splitting the balance into leg amounts.
 * The actual safety budget used in `executeLeg` is derived dynamically from the
 * provider's current `maxFeePerGas` (see `NATIVE_INPUT_GAS_LIMIT_ESTIMATE`).
 */
const NATIVE_INPUT_GAS_RESERVE = parseEther('0.01');

/**
 * Estimated gas units for a native-input leg (generous upper bound covering the
 * modular path with OO multi-hop swap + LZ OFT send on Polygon).
 * Actual usage is ~1M–1.1M; using 2M × maxFeePerGas gives a comfortable ceiling.
 */
const NATIVE_INPUT_GAS_LIMIT_ESTIMATE = 2_000_000n;

// ─── Monolithic/modular builders for case 4 ───────────────────────────────────

/**
 * Monolithic for case 4 (native gas token input → OO swap to bridged ERC-20 → LZ `send` on adapter/pool):
 *   - inputToken = NATIVE_TOKEN_ADDRESS; swap.approvalSpender = 0 (no ERC20 approve needed)
 *   - swap.value = `ooSwapNativeWei` (OpenOcean `value` field when present; else quoted input wei)
 *   - postFee: router sends feeAmount of OO output token (e.g. USDT0) to signer
 *   - bridge: ERC-20 pool mechanics — splice post-fee balance into amountLD at offset 196
 *
 * msg.value ≈ ooSwapNativeWei + nativeFeeWithBuffer (signer attaches full `txValue`; OO consumes POL/ETH swap leg).
 */
function buildNativeInErc20BridgeMonolithic(
  signer: string,
  cfg: CaseConfig,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouter: string,
  swapData: string,
  stargateData: string,
  nativeFeeWithBuffer: bigint,
  ooSwapNativeWei: bigint,
): MonolithicExecution {
  const rawOoWei = ooSwapNativeWei > 0n ? ooSwapNativeWei : inputAmount;
  const polOrEthToOo = rawOoWei <= inputAmount ? rawOoWei : inputAmount;
  return {
    input: { user: signer, inputToken: NATIVE_TOKEN_ADDRESS, inputAmount },
    preFee: NO_FEE,
    swap: {
      target: ooRouter,
      approvalSpender: ZERO_ADDRESS, // no ERC20 approve for native ETH input
      outputToken: cfg.ooSwap!.outToken,
      value: polOrEthToOo,
      minOutput: minAmountOut,
      data: swapData,
      returnDataWordOffset: 0n,
    },
    postFee: { receiver: signer, amount: feeAmount }, // fee in OO output token (USDC/USDT0)
    bridge: {
      target: cfg.bridgeContract,
      approvalSpender: cfg.bridgeContract, // router approves bridge contract to pull ERC20
      value: nativeFeeWithBuffer,        // LZ fee in native gas token only
      data: stargateData,
      amountPositions: [BigInt(STARGATE_AMOUNT_LD_OFFSET)], // splice amountLD at runtime
      useFinalAmountAsValue: false,
    },
  };
}

/**
 * Modular for case 4 (native gas token in → OO → ERC-20 out → LZ `send`):
 *   [0] nativeCall(ooRouter, swapData, ooSwapWei) — OO `value` when present else leg `inputAmount`
 *   … same ERC-20 fee / approve / splice as monolithic ERC20-pool bridge path.
 *
 * Input native is forwarded on the enclosing tx (`txValue`); no AH.transferFrom pull.
 */
function buildNativeInErc20BridgeModularActions(
  signer: string,
  routerAddress: string,
  cfg: CaseConfig,
  inputAmount: bigint,
  feeAmount: bigint,
  nativeFeeWithBuffer: bigint,
  ooRouter: string,
  swapData: string,
  stargateData: string,
  ooSwapNativeWei: bigint,
): ModularAction[] {
  const exec = new ModularActionsBuilder();
  const outTokenAddr = cfg.ooSwap!.outToken;
  const rawOoWei = ooSwapNativeWei > 0n ? ooSwapNativeWei : inputAmount;
  const polOrEthToOo = rawOoWei <= inputAmount ? rawOoWei : inputAmount;

  exec.nativeCall(ooRouter, swapData, polOrEthToOo);
  exec.call(outTokenAddr, encodeTransfer(signer, feeAmount));
  exec.call(outTokenAddr, encodeApprove(cfg.bridgeContract, ethers.MaxUint256));
  const tokenBal = exec.staticCall(outTokenAddr, encodeBalanceOf(routerAddress));
  exec
    .nativeCall(cfg.bridgeContract, stargateData, nativeFeeWithBuffer)
    .splicePayloadWord(BigInt(STARGATE_AMOUNT_LD_OFFSET), tokenBal.returnWord());

  return exec.toActions();
}

// ─── Execution leg ────────────────────────────────────────────────────────────

/**
 * Dispatches tx to router either as a signer→router `{ value }` call or wrapped in
 * `AllowanceHolder.exec` (ERC-2771 suffix so `_msgSender()` resolves inside router).
 *
 * ERC20 `_pullFromUser` requires ephemeral AH allowance ⇒ `allowance-holder` only for non-native inputs.
 */
async function dispatchRouterTransaction(
  route: RouterExecRoute,
  cfg: CaseConfig,
  signer: ethers.Signer,
  routerAddress: string,
  execCalldata: string,
  inputAmount: bigint,
  txValue: bigint,
  nativeSymbol: string,
): Promise<ethers.TransactionReceipt> {
  if (route === 'direct') {
    console.log(`[exec=direct] ${ethers.formatEther(txValue)} ${nativeSymbol}`);
    return execDirect(signer, routerAddress, execCalldata, txValue);
  }
  // allowance-holder — persistent ERC20→AH approval except for pure native pulls
  if (!cfg.isNativeInput) {
    await ensureAllowanceForAllowanceHolder(signer, cfg.inputToken, inputAmount);
  }
  console.log(`[exec=allowance-holder] ${ethers.formatEther(txValue)} ${nativeSymbol}`);
  return execViaAH(
    signer,
    routerAddress,
    cfg.inputToken,
    inputAmount,
    routerAddress,
    execCalldata,
    txValue,
  );
}

/**
 * Runs one monolithic or modular leg for a case.
 * Fetches quotes, builds calldata, and executes via {@link dispatchRouterTransaction}.
 */
async function executeLeg(
  legLabel: string,
  useModular: boolean,
  cfg: CaseConfig,
  routerAddress: string,
  signer: ethers.Wallet,
  signerAddress: string,
  provider: ethers.JsonRpcProvider,
  inputAmount: bigint,
  routerIface: ethers.Interface,
  routerExec: RouterExecRoute,
): Promise<void> {
  console.log(`\n── ${legLabel} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);

  const nativeSymbol = cfg.sourceChainId === CHAIN_IDS.POLYGON ? 'POL' : 'ETH';

  let inputAmountWei = inputAmount;

  let feeAmount = 0n;
  let minAmountOut = 0n;
  let estimatedBridgeAmount = 0n;
  let ooRouter = '';
  let swapData = '';
  let ooSwapNativeWei = 0n;
  let nativeFeeWithBuffer = 0n;
  let amountReceivedLD = 0n;
  /** Last raw quote fee (logged before buffer). */
  let nativeFeeQuoted = 0n;

  /**
   * Dynamic gas reserve for native-input cases: current maxFeePerGas × generous gas limit estimate.
   * Fetched once before the loop so we don't hammer the RPC on each cap iteration.
   * Falls back to a hardcoded minimum if fee data is unavailable.
   */
  let gasReserve = NATIVE_INPUT_GAS_RESERVE;
  if (cfg.isNativeInput) {
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 500_000_000n;
    gasReserve = maxFeePerGas * NATIVE_INPUT_GAS_LIMIT_ESTIMATE;
    console.log(
      `  Gas reserve (${NATIVE_INPUT_GAS_LIMIT_ESTIMATE / 1_000_000n}M gas × ${ethers.formatUnits(maxFeePerGas, 'gwei')} Gwei): ` +
        `${ethers.formatEther(gasReserve)} ${nativeSymbol}`,
    );
  }

  const MAX_NATIVE_INPUT_CAP_ITER = 6;

  let iter = 0;
  for (;;) {
    iter++;
    if (iter > MAX_NATIVE_INPUT_CAP_ITER) {
      throw new Error(
        `${cfg.name}: native swap budgeting hit ${MAX_NATIVE_INPUT_CAP_ITER} re-quote iterations; top up native balance or widen gas reserve.`,
      );
    }

    if (cfg.ooSwap !== null) {
      const swapOutIsNative = cfg.ooSwap.outToken.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
      const swapOutIsUsdt0 = cfg.ooSwap.outToken.toLowerCase() === TOKENS.USDT0_POLYGON.toLowerCase();
      const swapOutLabel = swapOutIsNative
        ? cfg.sourceChainId === CHAIN_IDS.POLYGON
          ? 'POL'
          : 'ETH'
        : swapOutIsUsdt0
          ? 'USDT0'
          : 'USDC';
      const swapOutDecimals = swapOutIsNative ? 18 : 6;
      const fmtSwapOut = (v: bigint) =>
        swapOutIsNative ? ethers.formatEther(v) : ethers.formatUnits(v, swapOutDecimals);

      console.log(`Fetching OpenOcean quote (${cfg.ooSwap.inToken} → ${swapOutLabel})...`);
      const q = await fetchOoQuote(cfg.ooSwap, routerAddress, inputAmountWei);
      ooRouter = q.ooRouter;
      swapData = q.swapData;
      ooSwapNativeWei = q.nativeSwapWei;
      feeAmount = bpsOf(q.estimatedOut, FEE_BPS);
      estimatedBridgeAmount = q.estimatedOut - feeAmount;
      minAmountOut = q.minAmountOut;

      console.log(`  OO router:         ${ooRouter}`);
      console.log(`  Est. out:          ${fmtSwapOut(q.estimatedOut)} ${swapOutLabel}`);
      console.log(`  Fee:               ${fmtSwapOut(feeAmount)} ${swapOutLabel} (${FEE_BPS} bps)`);
      console.log(`  Min out:           ${fmtSwapOut(minAmountOut)} ${swapOutLabel}`);
      if (ooSwapNativeWei > 0n) {
        console.log(`  OO swap value wei: ${ooSwapNativeWei.toString()} (attached to OO call)`);
      }
    } else {
      // Case 2: no OO swap — bridge entire balance minus fee
      feeAmount = bpsOf(inputAmountWei, FEE_BPS);
      estimatedBridgeAmount = inputAmountWei - feeAmount;
      console.log(`  Fee:               ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`);
    }

    console.log(`Fetching bridge quoteSend (${cfg.bridgeContract}, extraOpts ${cfg.lzExtraOptions.slice(0, 18)}...) ...`);
    const lzQuote = await fetchStargateQuote(
      cfg.bridgeContract,
      provider,
      cfg.destLzEid,
      signerAddress,
      estimatedBridgeAmount,
      cfg.lzExtraOptions,
    );
    nativeFeeQuoted = lzQuote.nativeFee;
    nativeFeeWithBuffer = (lzQuote.nativeFee * 105n) / 100n;
    amountReceivedLD = lzQuote.amountReceivedLD;

    console.log(`  nativeFee:         ${ethers.formatEther(nativeFeeQuoted)} ${nativeSymbol}`);
    console.log(`  nativeFee +5%buf:  ${ethers.formatEther(nativeFeeWithBuffer)} ${nativeSymbol}`);
    console.log(`  Est. received:     ${ethers.formatUnits(amountReceivedLD, cfg.isNativePool ? 18 : 6)}`);

    if (!cfg.isNativeInput) {
      break;
    }

    const balNow = await provider.getBalance(signerAddress);
    // maxAffordableSwapIn = balance we can put into the swap leg so that
    //   txValue (= inputAmountWei + nativeFeeWithBuffer) + gas cost ≤ balance
    const maxAffordableSwapIn = balNow - nativeFeeWithBuffer - gasReserve;
    if (maxAffordableSwapIn <= 0n) {
      throw new Error(
        `${cfg.name}: signer native balance (${ethers.formatEther(balNow)} ${nativeSymbol}) cannot cover lz fee ` +
          `(${ethers.formatEther(nativeFeeWithBuffer)} ${nativeSymbol}) plus gas reserve ` +
          `(${ethers.formatEther(gasReserve)} ${nativeSymbol}).`,
      );
    }
    if (inputAmountWei <= maxAffordableSwapIn) {
      break;
    }

    console.warn(
      `[${legLabel}] capping ${nativeSymbol} swap input: planned ${ethers.formatEther(inputAmountWei)} ` +
        `exceeds max affordable ${ethers.formatEther(maxAffordableSwapIn)} (balance − lz fee − gas reserve). Re-quoting.`,
    );
    inputAmountWei = maxAffordableSwapIn;
  }

  let amountLD: bigint;
  if (cfg.isNativePool) {
    amountLD = minAmountOut - feeAmount - nativeFeeWithBuffer;
    if (amountLD <= 0n) {
      throw new Error(`${cfg.name}: minAmountOut too small to cover fee + nativeFee.`);
    }
  } else {
    amountLD = 0n;
  }

  const stargateData = buildStargateCalldata(cfg.destLzEid, nativeFeeWithBuffer, signerAddress, amountLD, cfg.lzExtraOptions);

  let execCalldata: string;
  if (useModular) {
    let actions: ModularAction[];
    if (cfg.isNativePool) {
      actions = buildNativePoolModularActions(
        signerAddress, routerAddress, cfg, inputAmountWei, feeAmount, nativeFeeWithBuffer,
        minAmountOut, ooRouter, swapData, stargateData,
      );
    } else if (cfg.isNativeInput) {
      actions = buildNativeInErc20BridgeModularActions(
        signerAddress, routerAddress, cfg, inputAmountWei, feeAmount, nativeFeeWithBuffer,
        ooRouter, swapData, stargateData, ooSwapNativeWei,
      );
    } else {
      actions = buildErc20PoolModularActions(
        signerAddress, routerAddress, cfg, inputAmountWei, feeAmount, nativeFeeWithBuffer, stargateData,
      );
    }
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [actions]);
  } else {
    let mono: MonolithicExecution;
    if (cfg.isNativePool) {
      mono = buildNativePoolMonolithic(
        signerAddress, cfg, inputAmountWei, feeAmount, minAmountOut,
        ooRouter, swapData, stargateData,
      );
    } else if (cfg.isNativeInput) {
      mono = buildNativeInErc20BridgeMonolithic(
        signerAddress, cfg, inputAmountWei, feeAmount, minAmountOut,
        ooRouter, swapData, stargateData, nativeFeeWithBuffer, ooSwapNativeWei,
      );
    } else {
      mono = buildErc20PoolMonolithic(
        signerAddress, cfg, inputAmountWei, feeAmount, stargateData, nativeFeeWithBuffer,
      );
    }
    execCalldata = routerIface.encodeFunctionData('performExecution', [mono]);
  }

  const txValue = cfg.isNativeInput ? inputAmountWei + nativeFeeWithBuffer : nativeFeeWithBuffer;

  const receipt = await dispatchRouterTransaction(
    routerExec,
    cfg,
    signer,
    routerAddress,
    execCalldata,
    inputAmountWei,
    txValue,
    nativeSymbol,
  );

  logTxnSummary(`${cfg.name} — ${useModular ? 'Modular' : 'Monolithic'}`, cfg.sourceChainId, receipt);
}

// ─── Run one case (monolithic + sleep + modular) ──────────────────────────────

async function runCase(
  cfg: CaseConfig,
  signer: ethers.Wallet,
  signerAddress: string,
  routerIface: ethers.Interface,
  routerExec: RouterExecRoute,
): Promise<void> {
  const routerAddress = routerAddressForChain(cfg.sourceChainId);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`CASE: ${cfg.name}`);
  console.log('═'.repeat(70));
  console.log(`Router (chain ${cfg.sourceChainId}): ${routerAddress}`);
  console.log(`Router exec route:                   ${routerExec}`);

  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const signerOnChain = signer.connect(provider);

  let walletBalance: bigint;
  let decimals: number;
  if (cfg.isNativeInput) {
    const raw = await provider.getBalance(signerAddress);
    if (raw <= NATIVE_INPUT_GAS_RESERVE) {
      const sym = cfg.sourceChainId === CHAIN_IDS.POLYGON ? 'POL' : 'ETH';
      throw new Error(
        `${cfg.name}: native balance ${ethers.formatEther(raw)} ${sym} is below reserve of ${ethers.formatEther(NATIVE_INPUT_GAS_RESERVE)} ${sym}.`,
      );
    }
    // Reserve wei for signer gas; lz fee itself is deducted inside executeLeg (`txValue = swap + fee`).
    walletBalance = raw - NATIVE_INPUT_GAS_RESERVE;
    decimals = 18;
  } else {
    ({ balance: walletBalance, decimals } = await getWalletErc20Balance(
      cfg.inputToken,
      signerAddress,
      provider,
    ));
  }
  if (walletBalance === 0n) {
    throw new Error(
      `${cfg.name}: signer ${signerAddress} has zero usable balance of ${cfg.inputToken} on chain ${cfg.sourceChainId}.`,
    );
  }

  const legAmount = walletBalance / 2n;
  if (legAmount === 0n) {
    throw new Error(`${cfg.name}: balance too small to split into two halves.`);
  }

  console.log(`Input token balance: ${ethers.formatUnits(walletBalance, decimals)} (${cfg.inputToken})`);
  console.log(`Per leg (½):       ${ethers.formatUnits(legAmount, decimals)}`);

  await executeLeg('1/2', false, cfg, routerAddress, signerOnChain, signerAddress, provider, legAmount, routerIface, routerExec);

  console.log('\nSleeping 3s before modular leg...');
  await sleep(3000);

  await executeLeg('2/2', true, cfg, routerAddress, signerOnChain, signerAddress, provider, legAmount, routerIface, routerExec);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const cfg = resolveScenarioConfig();
  const routerExec = resolveRouterExecRoute(cfg);

  // Use any provider to create the wallet; the case reconnects via `runCase`.
  const signer = new ethers.Wallet(privateKey);
  const signerAddress = await signer.getAddress();
  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log(`Signer:   ${signerAddress}`);
  console.log(`Router:   ${routerAddressForChain(cfg.sourceChainId)} (chain ${cfg.sourceChainId})`);
  console.log(`Scenario: ${process.argv[2] ?? process.env.STARGATE_E2E_CASE ?? '(resolved)'}`);
  console.log(`Exec:     ${routerExec} (argv[3] overrides STARGATE_ROUTER_EXEC; required for native input)`);

  await runCase(cfg, signer, signerAddress, routerIface, routerExec);

  console.log('\n✓ Stargate case completed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
