/**
 * Arbitrum bridge e2e script — AAVE (Ethereum) → ETH (OO swap) → Arbitrum ETH (depositEth)
 *
 * Flow:
 *   1. Fetch an OpenOcean swap quote for AAVE → ETH on Ethereum mainnet (router is sender).
 *   2. Estimate the Arbitrum retryable submission fee so we know the minimum ETH required
 *      to bridge.  A conservative fallback of 0.001 ETH is used if estimation fails.
 *   3. Split the signer's AAVE balance in half and run two legs back-to-back:
 *        Leg 1  MONOLITHIC  — single `performExecution` call
 *        Leg 2  MODULAR     — `performModularExecution` call (3-second pause before)
 *
 * Monolithic mechanics:
 *   - Pull inputAmount AAVE via AH.exec grant, approve OO router, swap AAVE → ETH.
 *   - Post-swap fee (FEE_BPS) in ETH sent to signer.
 *   - BRIDGE_VALUE_FLAG set: router forwards actualFinalETH as msg.value to inbox.
 *   - No ETH splice needed (depositEth takes no calldata amount param).
 *
 * Modular mechanics:
 *   [0] AH.transferFrom AAVE → router (uses ephemeral AH grant)
 *   [1] AAVE.approve(ooRouter, inputAmount)
 *   [2] OO swap AAVE → ETH (lands in router)
 *   [3] nativeCall(signer, '0x', feeAmount)   — ETH fee out
 *   [4] nativeCall(inbox, depositEth(), bridgeValue)
 *
 * Input is always AAVE (ERC-20) so `direct` router txs are rejected — the router's
 * `_pullFromUser` requires the ephemeral allowance set by AllowanceHolder.exec.
 *
 * Exec mode (argv[1] or ARB_ROUTER_EXEC env):
 *   allowance-holder  (default) — wrap via AllowanceHolder.exec
 *   direct            — rejected for ERC-20 input with a clear error
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaArbitrumNative.ts
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaArbitrumNative.ts allowance-holder
 *   ARB_ROUTER_EXEC=allowance-holder PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaArbitrumNative.ts
 *
 * Router on Ethereum mainnet: set `ROUTER_CHAIN_1` env or legacy `ROUTER_ADDRESS`.
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  ARBITRUM_INBOX,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
  ALLOWANCE_HOLDER,
  NATIVE_TOKEN_ADDRESS,
} from './config';
import {
  execViaAH,
  execDirect,
  ensureAllowanceForAllowanceHolder,
} from './utils/allowanceHolder';
import { encodeApprove, getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import type { ModularAction } from './utils/modularActionsBuilder/index';
import {
  BRIDGE_VALUE_FLAG,
  MonolithicExecutionCall,
  NO_FEE,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  monolithicArgs,
} from './utils/contractTypes';
import { sleep } from './utils/sleep';
import { logTxnSummary } from './utils/txnLogSummary';
import {
  ensureRouterErc20Balance,
  ensureRouterNativeBalance,
  ensureRouterApproval,
} from './utils/reproducibility';

// ─── Exec-mode selection ──────────────────────────────────────────────────────

/** How the signer reaches the router. */
type RouterExecRoute = 'direct' | 'allowance-holder';

const EXEC_ALIASES: Record<string, RouterExecRoute> = {
  direct: 'direct',
  dr: 'direct',
  router: 'direct',
  'allowance-holder': 'allowance-holder',
  ah: 'allowance-holder',
  exec: 'allowance-holder',
};

/**
 * Resolves exec route from `argv[1]` (overrides) or `ARB_ROUTER_EXEC` env.
 * Defaults to `allowance-holder` since AAVE is ERC-20.
 * `direct` is rejected with a clear error because `_pullFromUser` requires AH.
 */
function resolveRouterExecRoute(): RouterExecRoute {
  const rawArg = typeof process.argv[2] === 'string' ? process.argv[2].trim().toLowerCase() : '';
  const rawEnv = (process.env.ARB_ROUTER_EXEC ?? '').trim().toLowerCase();
  const raw = rawArg || rawEnv;

  if (raw) {
    const route = EXEC_ALIASES[raw];
    if (!route) {
      console.error(
        `Unknown exec mode "${raw}". Use argv[1] or ARB_ROUTER_EXEC: allowance-holder | direct (aliases ah, exec, dr, router).`,
      );
      process.exit(1);
    }
    if (route === 'direct') {
      console.error(
        'ERC-20 input (AAVE) cannot use direct router txs: `_pullFromUser` invokes AllowanceHolder.transferFrom, ' +
          'which requires the ephemeral allowance set by AH.exec. Use allowance-holder (default).',
      );
      process.exit(1);
    }
    return route;
  }

  return 'allowance-holder';
}

// ─── Arbitrum bridge fee estimation ──────────────────────────────────────────

/**
 * Estimates the minimum ETH required for the Arbitrum inbox submission fee.
 * Falls back to 0.001 ETH if the SDK is unavailable or estimation fails.
 */
async function estimateArbitrumBridgeFee(ethereumProvider: ethers.Provider): Promise<bigint> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ParentToChildMessageGasEstimator } = require('@arbitrum/sdk');
    const estimator = new ParentToChildMessageGasEstimator(ethereumProvider);
    const l2GasPrice = (await new ethers.JsonRpcProvider(RPC.ARBITRUM).getFeeData()).gasPrice ?? 0n;
    const submissionFee = await estimator.estimateSubmissionFee(ethereumProvider, 0n, 0n);
    const executionCost = 250000n * (l2GasPrice + (l2GasPrice * 20n) / 100n);
    const totalFee = BigInt(submissionFee.toString()) + executionCost;
    console.log(`  Estimated Arbitrum bridge fee: ${ethers.formatEther(totalFee)} ETH`);
    return totalFee;
  } catch (err) {
    const fallback = ethers.parseEther('0.001');
    console.warn(
      `  Arbitrum fee estimation failed (${(err as Error).message}), using fallback: ${ethers.formatEther(fallback)} ETH`,
    );
    return fallback;
  }
}

// ─── OpenOcean quote ──────────────────────────────────────────────────────────

interface OoSwapQuoteResponse {
  data: {
    to: string;
    data: string;
    value?: string;
    outAmount: string;
    minOutAmount: string;
  };
}

/**
 * Fetches an OpenOcean swap_quote for AAVE → ETH on Ethereum mainnet.
 * Router address is used as sender and account so ETH output lands in the router.
 */
async function fetchOoQuote(
  routerAddress: string,
  inputAmount: bigint,
): Promise<{
  ooRouter: string;
  swapData: string;
  estimatedOut: bigint;
  minAmountOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.AAVE_ETH,
    outTokenAddress: NATIVE_TOKEN_ADDRESS,
    amount: ethers.formatUnits(inputAmount, 18),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: routerAddress,
    account: routerAddress,
    gasPrice: '20',
  };
  if (OPEN_OCEAN_API_KEY) {
    params.apikey = OPEN_OCEAN_API_KEY;
  }
  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.ETHEREUM}/swap_quote`;
  const response = await axios.get<OoSwapQuoteResponse>(url, { params });
  const q = response.data.data;
  return {
    ooRouter: q.to,
    swapData: q.data,
    estimatedOut: BigInt(q.outAmount),
    minAmountOut: BigInt(q.minOutAmount),
  };
}

// ─── Calldata helpers ─────────────────────────────────────────────────────────

/** Encodes Arbitrum inbox `depositEth()` — ETH amount is entirely in msg.value. */
function buildDepositEthCalldata(): string {
  return new ethers.Interface([
    'function depositEth() external payable returns (uint256)',
  ]).encodeFunctionData('depositEth', []);
}

// ─── Monolithic builder ───────────────────────────────────────────────────────

/**
 * AAVE → OO → ETH → Arbitrum inbox (monolithic):
 *   - input: AAVE pulled via AH
 *   - swap: AAVE → native ETH, BRIDGE_VALUE_FLAG forwards actualFinalETH
 *   - bridge: depositEth() — no amount in calldata, all ETH passed as msg.value
 */
function buildMonolithic(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouter: string,
  swapData: string,
): MonolithicExecutionCall {
  return {
    exec: {
      input: { user: signerAddress, inputToken: TOKENS.AAVE_ETH, inputAmount },
      preFee: NO_FEE,
      swap: {
        target: ooRouter,
        approvalSpender: ooRouter,
        outputToken: NATIVE_TOKEN_ADDRESS,
        value: 0n,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      postFee: { receiver: signerAddress, amount: feeAmount },
      bridge: {
        target: ARBITRUM_INBOX,
        approvalSpender: ZERO_ADDRESS,
        value: 0n,              // ignored when BRIDGE_VALUE_FLAG is set
      },
      flags: BRIDGE_VALUE_FLAG,
    },
    swapCallData: swapData,
    bridgeCallData: buildDepositEthCalldata(),
  };
}

// ─── Modular builder ──────────────────────────────────────────────────────────

/**
 * AAVE → OO → ETH → Arbitrum inbox (modular):
 *   [0] AH.transferFrom(AAVE, signer, router, inputAmount)
 *   [1] AAVE.approve(ooRouter, inputAmount)
 *   [2] call(ooRouter, swapData)          — AAVE → ETH, ETH lands in router
 *   [3] nativeCall(signer, '0x', feeAmount)
 *   [4] nativeCall(inbox, depositEthData, bridgeValue)
 */
function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  bridgeValue: bigint,
  ooRouter: string,
  swapData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const exec = new ModularActionsBuilder();

  exec.call(
    ALLOWANCE_HOLDER,
    ahIface.encodeFunctionData('transferFrom', [TOKENS.AAVE_ETH, signerAddress, routerAddress, inputAmount]),
  );
  exec.call(TOKENS.AAVE_ETH, encodeApprove(ooRouter, inputAmount));
  exec.call(ooRouter, swapData);
  exec.nativeCall(signerAddress, '0x', feeAmount);
  exec.nativeCall(ARBITRUM_INBOX, buildDepositEthCalldata(), bridgeValue);

  return exec.toActions();
}

// ─── Execution leg ────────────────────────────────────────────────────────────

/**
 * Runs one monolithic or modular leg: fetches OO quote + arb fee, builds calldata,
 * dispatches via AllowanceHolder.exec (msg.value=0 since input is AAVE).
 */
async function executeLeg(
  legLabel: string,
  useModular: boolean,
  routerAddress: string,
  signer: ethers.Wallet,
  signerAddress: string,
  provider: ethers.JsonRpcProvider,
  inputAmount: bigint,
  routerExec: RouterExecRoute,
  routerIface: ethers.Interface,
): Promise<void> {
  console.log(`\n── ${legLabel} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);

  console.log('Fetching OpenOcean quote (AAVE → ETH)...');
  const { ooRouter, swapData, estimatedOut, minAmountOut } = await fetchOoQuote(
    routerAddress,
    inputAmount,
  );
  const feeAmount = bpsOf(estimatedOut, FEE_BPS);

  console.log(`  OO router:       ${ooRouter}`);
  console.log(`  Est. ETH out:    ${ethers.formatEther(estimatedOut)} ETH`);
  console.log(`  Fee:             ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`);
  console.log(`  Min ETH out:     ${ethers.formatEther(minAmountOut)} ETH`);

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_ETH, routerAddress);
  await ensureRouterNativeBalance(signer, routerAddress);
  await ensureRouterApproval(signer, routerAddress, TOKENS.AAVE_ETH, ooRouter);

  const arbFee = await estimateArbitrumBridgeFee(provider);
  const minEthRequired = feeAmount + arbFee;
  if (estimatedOut < minEthRequired) {
    console.warn(
      `  Warning: est. ETH out (${ethers.formatEther(estimatedOut)}) may be insufficient ` +
        `to cover fee + bridge cost (${ethers.formatEther(minEthRequired)}).`,
    );
  }

  // bridgeValue = everything left after the fee; use minAmountOut-based floor so
  // the modular nativeCall carries at least as much ETH as the inbox requires.
  const bridgeValue = minAmountOut > feeAmount ? minAmountOut - feeAmount : 0n;
  console.log(`  Bridge value:    ${ethers.formatEther(bridgeValue)} ETH (floor for nativeCall)`);

  let execCalldata: string;
  if (useModular) {
    const actions = buildModularActions(
      signerAddress,
      routerAddress,
      inputAmount,
      feeAmount,
      bridgeValue,
      ooRouter,
      swapData,
    );
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [ZERO_BYTES32, actions]);
  } else {
    const mono = buildMonolithic(signerAddress, inputAmount, feeAmount, minAmountOut, ooRouter, swapData);
    execCalldata = routerIface.encodeFunctionData('performExecution', monolithicArgs(mono));
  }

  // Input is AAVE (ERC-20) — msg.value is always 0; ETH comes from the swap output.
  const txValue = 0n;

  let receipt: ethers.TransactionReceipt;
  if (routerExec === 'direct') {
    // Guarded at startup — should never reach here for ERC-20 input.
    console.log(`[exec=direct] value=0 ETH`);
    receipt = await execDirect(signer, routerAddress, execCalldata, txValue);
  } else {
    await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_ETH, inputAmount);
    console.log(`[exec=allowance-holder] value=0 ETH`);
    receipt = await execViaAH(
      signer,
      routerAddress,
      TOKENS.AAVE_ETH,
      inputAmount,
      routerAddress,
      execCalldata,
      txValue,
    );
  }

  logTxnSummary(
    `AAVE → ETH → Arbitrum — ${useModular ? 'Modular' : 'Monolithic'}`,
    CHAIN_IDS.ETHEREUM,
    receipt,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const routerExec = resolveRouterExecRoute();
  const routerAddress = routerAddressForChain(CHAIN_IDS.ETHEREUM);

  const provider = new ethers.JsonRpcProvider(RPC.ETHEREUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: fullBalance, decimals } = await getWalletErc20Balance(
    TOKENS.AAVE_ETH,
    signerAddress,
    provider,
  );
  if (fullBalance === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero AAVE on Ethereum. Fund the wallet first.`,
    );
  }

  const legAmount = (fullBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error('AAVE balance too small to split into two legs.');
  }

  const routerIface = new ethers.Interface(ROUTER_ABI);

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${routerAddress}`);
  console.log(`Input token:   ${TOKENS.AAVE_ETH} (AAVE Ethereum)`);
  console.log(`Balance:       ${ethers.formatUnits(fullBalance, decimals)} AAVE`);
  console.log(`Per leg (½):   ${ethers.formatUnits(legAmount, decimals)} AAVE`);
  console.log(`Exec route:    ${routerExec}`);

  await executeLeg('1/2', false, routerAddress, signer, signerAddress, provider, legAmount, routerExec, routerIface);

  console.log('\nSleeping 3s before modular leg...');
  await sleep(3000);

  await executeLeg('2/2', true, routerAddress, signer, signerAddress, provider, legAmount, routerExec, routerIface);

  console.log('\n✓ Arbitrum bridge case completed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
