/**
 * Stargate e2e test script — three independent cases, each running a
 * monolithic leg followed (after a 3-second pause) by a modular leg.
 *
 * Case 1  Arbitrum USDC  →  OO swap → native ETH  →  Stargate Native ETH Pool  →  Base ETH
 * Case 2  Polygon  USDC  →  (no swap)              →  Stargate USDC Pool        →  Base USDC
 * Case 3  Base     USDC  →  OO swap → native ETH  →  Stargate Native ETH Pool  →  Arb  ETH
 * Case 4  Arbitrum ETH   →  OO swap → USDC Arb    →  Stargate USDC Pool        →  Base USDC
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
 *   4 / arb-eth-base-usdc     Arbitrum ETH → OO → USDC → Stargate USDC pool → Base USDC
 *                             msg.value = inputETH + nativeFee (native input + LZ fee)
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-usdc-base-eth
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-eth-base-usdc direct
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-eth-base-usdc allowance-holder
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
 */
import axios from 'axios';
import { ethers, parseEther } from 'ethers';
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
  ALLOWANCE_HOLDER,
  NATIVE_TOKEN_ADDRESS,
  STARGATE_NATIVE_ARB,
  STARGATE_NATIVE_BASE,
  STARGATE_USDC_POLYGON,
  STARGATE_USDC_ARB,
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
  /** true when inputToken is native (ETH/POL); exec mode must be set explicitly (`direct` | `allowance-holder`) */
  isNativeInput: boolean;
  ooSwap: OoSwapConfig | null; // null → skip OO swap, bridge input token directly
  stargatePool: string;
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
    stargatePool: STARGATE_NATIVE_ARB,
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
    stargatePool: STARGATE_USDC_POLYGON,
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
    stargatePool: STARGATE_NATIVE_BASE,
    isNativePool: true,
    destLzEid: ARBITRUM_LZ_EID,
  },
  {
    // msg.value = inputETH (swapped via OO) + nativeFeeWithBuffer (LZ fee).
    // After the OO swap the router holds USDC + nativeFeeWithBuffer ETH, which it
    // uses to pay the Stargate USDC pool's LZ fee.
    name: 'Arbitrum ETH → USDC (OO) → Base USDC (Stargate USDC Pool)',
    sourceChainId: CHAIN_IDS.ARBITRUM,
    rpc: RPC.ARBITRUM,
    inputToken: NATIVE_TOKEN_ADDRESS,
    inputDecimals: 18,
    isNativeInput: true,
    ooSwap: {
      inToken: NATIVE_TOKEN_ADDRESS,
      outToken: TOKENS.USDC_ARB,
      inDecimals: 18,
      chainId: CHAIN_IDS.ARBITRUM,
      gasPrice: '1',
    },
    stargatePool: STARGATE_USDC_ARB,
    isNativePool: false,
    destLzEid: BASE_LZ_EID,
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
  'arb-eth-base-usdc': 3,
  'arb-native-usdc-base': 3,
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
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-eth-base-usdc\n' +
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
        '  ts-node scripts/e2e/swapBridgeViaStargateNative.ts arb-eth-base-usdc direct',
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
): Promise<{ ooRouter: string; swapData: string; estimatedOut: bigint; minAmountOut: bigint }> {
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
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
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
 */
async function fetchStargateQuote(
  pool: string,
  provider: ethers.JsonRpcProvider,
  destLzEid: number,
  recipient: string,
  bridgeAmountLD: bigint,
): Promise<{ nativeFee: bigint; amountReceivedLD: bigint }> {
  const contract = new ethers.Contract(pool, STARGATE_ABI, provider);
  const to32 = ethers.zeroPadValue(recipient, 32);
  const sendParam = {
    dstEid: destLzEid,
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
 */
function buildStargateCalldata(
  destLzEid: number,
  nativeFee: bigint,
  recipient: string,
  amountLD: bigint,
): string {
  return STARGATE_IFACE.encodeFunctionData('send', [
    {
      dstEid: destLzEid,
      to: ethers.zeroPadValue(recipient, 32),
      amountLD,
      minAmountLD: 0n,
      extraOptions: '0x',
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
      target: cfg.stargatePool,
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
      target: cfg.stargatePool,
      approvalSpender: cfg.stargatePool, // router must approve USDC to pool
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
  exec.nativeCall(cfg.stargatePool, stargateData, bridgeValue);

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
  exec.call(cfg.inputToken, encodeApprove(cfg.stargatePool, ethers.MaxUint256));
  const usdcBalance = exec.staticCall(cfg.inputToken, encodeBalanceOf(routerAddress));
  exec
    .nativeCall(cfg.stargatePool, stargateData, nativeFeeWithBuffer)
    .splicePayloadWord(BigInt(STARGATE_AMOUNT_LD_OFFSET), usdcBalance.returnWord());

  return exec.toActions();
}

/**
 * ETH reserved from native balance for gas + LZ fee when inputToken is native.
 * The balance read in runCase subtracts this before using the remainder as inputAmount,
 * so the signer always has headroom to pay tx gas on top of (inputAmount + nativeFeeWithBuffer).
 */
const NATIVE_INPUT_GAS_RESERVE = parseEther("0.001");

// ─── Monolithic/modular builders for case 4 ───────────────────────────────────

/**
 * Monolithic for case 4 (native ETH input → OO swap to USDC → Stargate USDC pool → Base USDC):
 *   - inputToken = NATIVE_TOKEN_ADDRESS; swap.approvalSpender = 0 (no ERC20 approve needed)
 *   - swap.value = inputAmount: forwards that ETH to OO which returns USDC to the router
 *   - postFee: router sends feeAmount USDC to signer
 *   - bridge.approvalSpender = stargatePool: router approves remaining USDC to Stargate
 *   - bridge.value = nativeFeeWithBuffer: only LZ fee in native (not the USDC bridge amount)
 *   - amountPositions=[196n]: router splices post-fee USDC finalAmount into stargateData.amountLD
 *
 * msg.value = inputAmount + nativeFeeWithBuffer:
 *   OO consumes inputAmount ETH → router holds USDC + nativeFeeWithBuffer ETH for the LZ fee.
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
): MonolithicExecution {
  return {
    input: { user: signer, inputToken: NATIVE_TOKEN_ADDRESS, inputAmount },
    preFee: NO_FEE,
    swap: {
      target: ooRouter,
      approvalSpender: ZERO_ADDRESS, // no ERC20 approve for native ETH input
      outputToken: cfg.ooSwap!.outToken, // USDC_ARB
      value: inputAmount,              // forward inputAmount ETH to OO
      minOutput: minAmountOut,
      data: swapData,
      returnDataWordOffset: 0n,
    },
    postFee: { receiver: signer, amount: feeAmount }, // fee in USDC
    bridge: {
      target: cfg.stargatePool,
      approvalSpender: cfg.stargatePool, // router approves USDC to Stargate pool
      value: nativeFeeWithBuffer,        // LZ fee only; not the USDC bridge amount
      data: stargateData,
      amountPositions: [BigInt(STARGATE_AMOUNT_LD_OFFSET)], // splice USDC amountLD at runtime
      useFinalAmountAsValue: false,
    },
  };
}

/**
 * Modular for case 4 (native ETH input → OO swap to USDC → Stargate USDC pool → Base USDC):
 *   [0] nativeCall(ooRouter, swapData, inputAmount) — send inputAmount ETH to OO, get USDC
 *   [1] USDC.transfer(signer, feeAmount)            — fee out to signer
 *   [2] USDC.approve(stargatePool, MaxUint256)
 *   [3] STATICCALL USDC.balanceOf(router)           → stored for splice into [4]
 *   [4] nativeCall(stargatePool, stargateData, nativeFeeWithBuffer)
 *       .splicePayloadWord(STARGATE_AMOUNT_LD_OFFSET) ← patches amountLD from [3]
 *
 * No AH.transferFrom step — input ETH is already in the router via msg.value (direct
 * router tx or AH.exec both forward the same `txValue` to the router).
 * msg.value = inputAmount + nativeFeeWithBuffer (see `executeLeg` / `dispatchRouterTransaction`).
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
): ModularAction[] {
  const exec = new ModularActionsBuilder();
  const usdcToken = cfg.ooSwap!.outToken; // USDC_ARB

  exec.nativeCall(ooRouter, swapData, inputAmount); // ETH → USDC, USDC lands in router
  exec.call(usdcToken, encodeTransfer(signer, feeAmount));
  exec.call(usdcToken, encodeApprove(cfg.stargatePool, ethers.MaxUint256));
  const usdcBalance = exec.staticCall(usdcToken, encodeBalanceOf(routerAddress));
  exec
    .nativeCall(cfg.stargatePool, stargateData, nativeFeeWithBuffer)
    .splicePayloadWord(BigInt(STARGATE_AMOUNT_LD_OFFSET), usdcBalance.returnWord());

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

  let feeAmount: bigint;
  let minAmountOut = 0n;
  let estimatedBridgeAmount: bigint;
  let ooRouter = '';
  let swapData = '';

  if (cfg.ooSwap !== null) {
    const swapOutIsNative = cfg.ooSwap.outToken.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
    const swapOutLabel = swapOutIsNative ? 'ETH' : 'USDC';
    const fmtSwapOut = (v: bigint) =>
      swapOutIsNative ? ethers.formatEther(v) : ethers.formatUnits(v, 6);
    console.log(`Fetching OpenOcean quote (${cfg.ooSwap.inToken} → ${swapOutLabel})...`);
    const q = await fetchOoQuote(cfg.ooSwap, routerAddress, inputAmount);
    ooRouter = q.ooRouter;
    swapData = q.swapData;
    feeAmount = bpsOf(q.estimatedOut, FEE_BPS);
    estimatedBridgeAmount = q.estimatedOut - feeAmount;
    minAmountOut = q.minAmountOut;

    console.log(`  OO router:         ${ooRouter}`);
    console.log(`  Est. out:          ${fmtSwapOut(q.estimatedOut)} ${swapOutLabel}`);
    console.log(`  Fee:               ${fmtSwapOut(feeAmount)} ${swapOutLabel} (${FEE_BPS} bps)`);
    console.log(`  Min out:           ${fmtSwapOut(minAmountOut)} ${swapOutLabel}`);
  } else {
    // Case 2: no OO swap — bridge entire balance minus fee
    feeAmount = bpsOf(inputAmount, FEE_BPS);
    estimatedBridgeAmount = inputAmount - feeAmount;
    console.log(`  Fee:               ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`);
  }

  // Fetch Stargate quote for nativeFee and expected receive amount
  console.log(`Fetching Stargate quoteSend (pool ${cfg.stargatePool})...`);
  const { nativeFee, amountReceivedLD } = await fetchStargateQuote(
    cfg.stargatePool,
    provider,
    cfg.destLzEid,
    signerAddress,
    estimatedBridgeAmount,
  );
  const nativeFeeWithBuffer = (nativeFee * 105n) / 100n;

  const nativeSymbol = cfg.sourceChainId === CHAIN_IDS.POLYGON ? 'POL' : 'ETH';
  console.log(`  nativeFee:         ${ethers.formatEther(nativeFee)} ${nativeSymbol}`);
  console.log(`  nativeFee +5%buf:  ${ethers.formatEther(nativeFeeWithBuffer)} ${nativeSymbol}`);
  console.log(`  Est. received:     ${ethers.formatUnits(amountReceivedLD, cfg.isNativePool ? 18 : 6)}`);

  // Build Stargate calldata
  let amountLD: bigint;
  if (cfg.isNativePool) {
    // Use minAmountOut as the basis so that msg.value (= actualFinalAmount) >= amountLD + nativeFeeWithBuffer
    // is always satisfied: since actual >= min is guaranteed by OO slippage,
    // actual - fee >= min - fee = amountLD + nativeFeeWithBuffer >= amountLD + nativeFee ✓
    amountLD = minAmountOut - feeAmount - nativeFeeWithBuffer;
    if (amountLD <= 0n) {
      throw new Error(`${cfg.name}: minAmountOut too small to cover fee + nativeFee.`);
    }
  } else {
    amountLD = 0n; // placeholder — spliced by amountPositions or spliceWord at runtime
  }
  const stargateData = buildStargateCalldata(cfg.destLzEid, nativeFeeWithBuffer, signerAddress, amountLD);

  // Build execution calldata
  let execCalldata: string;
  if (useModular) {
    let actions: ModularAction[];
    if (cfg.isNativePool) {
      actions = buildNativePoolModularActions(
        signerAddress, routerAddress, cfg, inputAmount, feeAmount, nativeFeeWithBuffer,
        minAmountOut, ooRouter, swapData, stargateData,
      );
    } else if (cfg.isNativeInput) {
      actions = buildNativeInErc20BridgeModularActions(
        signerAddress, routerAddress, cfg, inputAmount, feeAmount, nativeFeeWithBuffer,
        ooRouter, swapData, stargateData,
      );
    } else {
      actions = buildErc20PoolModularActions(
        signerAddress, routerAddress, cfg, inputAmount, feeAmount, nativeFeeWithBuffer, stargateData,
      );
    }
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [actions]);
  } else {
    let mono: MonolithicExecution;
    if (cfg.isNativePool) {
      mono = buildNativePoolMonolithic(
        signerAddress, cfg, inputAmount, feeAmount, minAmountOut,
        ooRouter, swapData, stargateData,
      );
    } else if (cfg.isNativeInput) {
      mono = buildNativeInErc20BridgeMonolithic(
        signerAddress, cfg, inputAmount, feeAmount, minAmountOut,
        ooRouter, swapData, stargateData, nativeFeeWithBuffer,
      );
    } else {
      mono = buildErc20PoolMonolithic(
        signerAddress, cfg, inputAmount, feeAmount, stargateData, nativeFeeWithBuffer,
      );
    }
    execCalldata = routerIface.encodeFunctionData('performExecution', [mono]);
  }

  // txValue:
  //   Native input:  inputAmount (forwarded to OO) + nativeFeeWithBuffer (LZ fee)
  //   ERC20 input:   nativeFeeWithBuffer only (LZ fee)
  const txValue = cfg.isNativeInput ? inputAmount + nativeFeeWithBuffer : nativeFeeWithBuffer;

  const receipt = await dispatchRouterTransaction(
    routerExec,
    cfg,
    signer,
    routerAddress,
    execCalldata,
    inputAmount,
    txValue,
    nativeSymbol,
  );

  logTxnSummary(
    `${cfg.name} — ${useModular ? 'Modular' : 'Monolithic'}`,
    cfg.sourceChainId,
    receipt,
  );
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
      throw new Error(
        `${cfg.name}: native balance ${ethers.formatEther(raw)} ETH is below gas reserve of ${ethers.formatEther(NATIVE_INPUT_GAS_RESERVE)} ETH.`,
      );
    }
    // Reserve NATIVE_INPUT_GAS_RESERVE for tx gas + LZ nativeFee buffer; use the rest as input.
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
  // const legAmount = walletBalance;
  if (legAmount === 0n) {
    throw new Error(`${cfg.name}: balance too small to split into two halves.`);
  }

  console.log(`Input token balance: ${ethers.formatUnits(walletBalance, decimals)} (${cfg.inputToken})`);
  console.log(`Per leg:             ${ethers.formatUnits(legAmount, decimals)}`);

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
