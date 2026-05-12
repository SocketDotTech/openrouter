/**
 * Script 3 — Swap AAVE→ETH on Ethereum, then bridge ETH to Arbitrum via
 *             the Arbitrum native inbox (depositEth)
 *
 * Flow:
 *   1. Fetch an OpenOcean swap quote for AAVE→ETH on Ethereum mainnet.
 *   2. Estimate the Arbitrum retryable submission fee using @arbitrum/sdk so we
 *      know the minimum ETH required to bridge. A conservative fallback of
 *      0.001 ETH is used if estimation fails.
 *   3. Build a post-swap fee to signer in ETH.
 *   4. Build either monolithic or modular execution payload.
 *      - Monolithic: swap AAVE→ETH (balance delta on NATIVE), take ETH fee,
 *        call Arbitrum inbox with useFinalAmountAsValue=true so finalAmount
 *        becomes msg.value on the depositEth call.
 *      - Modular: pull → approve(oo) → swap(oo) → send ETH fee via CALL_WITH_NATIVE →
 *        depositEth via CALL_WITH_NATIVE.
 *   5. Call AllowanceHolder.exec with msg.value=0 (AAVE is the input token, not ETH).
 *
 * Uses the signer’s full AAVE balance on Ethereum mainnet as swap input.
 *
 * Usage:
 *   ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaArbitrumNative.ts
 *   USE_MODULAR=true ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaArbitrumNative.ts
 *
 * Notes:
 *   - The router must retain enough ETH after the swap to cover both the fee
 *     and the Arbitrum retryable submission cost. The script warns if the
 *     estimated ETH output is insufficient.
 *   - The Arbitrum Delayed Inbox address is 0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f
 *     on Ethereum mainnet. depositEth() accepts ETH as msg.value and credits
 *     the sender's L2 address on Arbitrum.
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  ROUTER_ADDRESS,
  TOKENS,
  ARBITRUM_INBOX,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  ALLOWANCE_HOLDER,
  NATIVE_TOKEN_ADDRESS,
} from './config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from './utils/allowanceHolder';
import { encodeApprove, getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import type { ModularAction } from './utils/modularActionsBuilder/index';
import {
  MonolithicExecution,
  NO_FEE,
  ZERO_ADDRESS,
} from './utils/contractTypes';

// ─── Arbitrum retryable fee estimation ───────────────────────────────────────

/**
 * Estimates the minimum ETH required for the Arbitrum inbox submission fee.
 * Uses @arbitrum/sdk's ParentToChildMessageGasEstimator if available.
 * Falls back to a conservative hardcoded estimate (0.001 ETH) so the script
 * can run without a live Arbitrum RPC for fee estimation.
 *
 * For a depositEth(), the inbox contract only needs the submission fee; there
 * is no retryable gas limit to estimate (it's a direct ETH credit on L2).
 */
async function estimateArbitrumBridgeFee(
  ethereumProvider: ethers.Provider,
): Promise<bigint> {
  try {
    // @arbitrum/sdk types vary between versions; dynamic import avoids hard-dep issues.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ParentToChildMessageGasEstimator } = require('@arbitrum/sdk');
    const estimator = new ParentToChildMessageGasEstimator(ethereumProvider);
    // Estimate submission fee for a minimal retryable (0 calldata, 250k gas limit).
    const l2GasPrice =
      (await (
        await new ethers.JsonRpcProvider(RPC.ARBITRUM).getFeeData()
      ).gasPrice) ?? 0n;
    const submissionFee = await estimator.estimateSubmissionFee(
      ethereumProvider,
      0n, // l1BaseFee (fetched internally)
      0n, // callDataLength
    );
    // Add buffer: submission fee + retryable execution cost headroom
    const executionCost = 250000n * (l2GasPrice + (l2GasPrice * 20n) / 100n); // gasPrice * 1.2
    const totalFee = BigInt(submissionFee.toString()) + executionCost;
    console.log(
      `Estimated Arbitrum bridge fee: ${ethers.formatEther(totalFee)} ETH`,
    );
    return totalFee;
  } catch (err) {
    // Fallback: 0.001 ETH is a safe overestimate for L1→L2 ETH deposits in 2024-2026.
    const fallback = ethers.parseEther('0.001');
    console.warn(
      `Could not estimate Arbitrum fee via SDK (${
        (err as Error).message
      }), using fallback: ${ethers.formatEther(fallback)} ETH`,
    );
    return fallback;
  }
}

// ─── OpenOcean swap quote ─────────────────────────────────────────────────────

interface OpenOceanSwapQuoteResponse {
  data: {
    to: string;
    data: string;
    value: string;
    outAmount: string;
    minOutAmount: string;
  };
}

/**
 * Fetches an OpenOcean swap quote for AAVE→ETH on Ethereum mainnet.
 * The native ETH output address used by OpenOcean is 0xEeee...EEe.
 */
async function fetchOpenOceanSwapQuote(
  routerAddress: string,
  inputAmount: bigint,
  slippageBps: number = 100,
): Promise<{
  ooRouterAddress: string;
  swapData: string;
  minAmountOut: bigint;
  estimatedOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.AAVE_ETH,
    outTokenAddress: NATIVE_TOKEN_ADDRESS, // ETH output
    amount: ethers.formatUnits(inputAmount, 18),
    slippage: (slippageBps / 100).toString(),
    sender: routerAddress,
    account: routerAddress,
    gasPrice: '20',
  };
  if (OPEN_OCEAN_API_KEY) {
    params['apikey'] = OPEN_OCEAN_API_KEY;
  }

  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.ETHEREUM}/swap_quote`;
  const response = await axios.get<OpenOceanSwapQuoteResponse>(url, { params });
  const q = response.data.data;

  return {
    ooRouterAddress: q.to,
    swapData: q.data,
    minAmountOut: BigInt(q.minOutAmount),
    estimatedOut: BigInt(q.outAmount),
  };
}

// ─── Arbitrum inbox calldata ──────────────────────────────────────────────────

/**
 * Builds the calldata for Arbitrum inbox depositEth().
 * The ETH amount is entirely determined by msg.value — there is no amount
 * parameter in the calldata itself.
 */
function buildDepositEthCalldata(): string {
  const iface = new ethers.Interface([
    'function depositEth() external payable returns (uint256)',
  ]);
  return iface.encodeFunctionData('depositEth', []);
}

// ─── Monolithic builder ───────────────────────────────────────────────────────

/**
 * Builds a MonolithicExecution that:
 *   - Pulls inputAmount AAVE from user
 *   - Swaps AAVE → ETH via OpenOcean (balance delta on NATIVE_TOKEN_ADDRESS)
 *   - Takes feeAmount ETH as post-swap fee sent to signer
 *   - Calls Arbitrum inbox depositEth() with finalAmount as msg.value
 *     (via useFinalAmountAsValue=true — no amount to splice in calldata)
 */
function buildMonolithicExecution(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouterAddress: string,
  swapData: string,
): MonolithicExecution {
  return {
    input: {
      user: signerAddress,
      inputToken: TOKENS.AAVE_ETH,
      inputAmount,
    },
    preFee: NO_FEE,
    swap: {
      target: ooRouterAddress,
      approvalSpender: ooRouterAddress,
      outputToken: NATIVE_TOKEN_ADDRESS,
      value: 0n,
      minOutput: minAmountOut,
      data: swapData,
    },
    postFee: {
      receiver: signerAddress,
      amount: feeAmount,
    },
    bridge: {
      target: ARBITRUM_INBOX,
      approvalSpender: ZERO_ADDRESS, // no ERC-20 approval needed for native
      value: 0n, // ignored when useFinalAmountAsValue=true
      data: buildDepositEthCalldata(),
      amountPositions: [], // ETH goes as msg.value, not in calldata
      useFinalAmountAsValue: true, // forward finalAmount as msg.value to inbox
    },
  };
}

// ─── Modular builder ──────────────────────────────────────────────────────────

/**
 * Builds an Action array:
 *   [0] Pull AAVE via AH.transferFrom
 *   [1] Approve OpenOcean router for inputAmount
 *   [2] Call OpenOcean to swap AAVE → ETH (lands in router as ETH)
 *   [3] Send ETH fee to signer via CALL_WITH_NATIVE
 *   [4] Call Arbitrum inbox depositEth() via CALL_WITH_NATIVE
 */
function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  bridgeValue: bigint,
  ooRouterAddress: string,
  swapData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.AAVE_ETH,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.AAVE_ETH, encodeApprove(ooRouterAddress, inputAmount));
  exec.call(ooRouterAddress, swapData);
  exec.nativeCall(signerAddress, '0x', feeAmount);
  exec.nativeCall(ARBITRUM_INBOX, buildDepositEthCalldata(), bridgeValue);
  return exec.toActions();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.ETHEREUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.AAVE_ETH;
  const { balance: inputAmount, decimals: inputDecimals } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (inputAmount === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero balance of ${inputToken}. Fund the wallet with AAVE on Ethereum first.`,
    );
  }
  const useModular = true;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ADDRESS}`);
  console.log(`Input token:   ${inputToken}`);
  console.log(
    `Input:         ${ethers.formatUnits(inputAmount, inputDecimals)} (full wallet balance)`,
  );
  console.log(`Mode:          ${useModular ? 'MODULAR' : 'MONOLITHIC'}`);
  console.log('');

  // Fetch OpenOcean quote (AAVE → ETH on Ethereum)
  console.log('Fetching OpenOcean swap quote (AAVE→ETH Ethereum)...');
  const { ooRouterAddress, swapData, minAmountOut, estimatedOut } =
    await fetchOpenOceanSwapQuote(ROUTER_ADDRESS, inputAmount);

  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`OO Router:       ${ooRouterAddress}`);
  console.log(`Est. ETH out:    ${ethers.formatEther(estimatedOut)} ETH`);
  console.log(
    `Post-swap fee:   ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`,
  );
  console.log(`Min ETH out:     ${ethers.formatEther(minAmountOut)} ETH`);

  // Estimate Arbitrum bridge fee
  const arbFee = await estimateArbitrumBridgeFee(provider);
  const minEthRequired = feeAmount + arbFee;
  if (estimatedOut < minEthRequired) {
    console.warn(
      `Warning: estimated ETH output (${ethers.formatEther(
        estimatedOut,
      )}) may be insufficient ` +
        `to cover fee + bridge cost (${ethers.formatEther(
          minEthRequired,
        )}). Increase AAVE balance on Ethereum so the quoted swap output rises.`,
    );
  }
  console.log('');

  const routerIface = new ethers.Interface(ROUTER_ABI);
  let execCalldata: string;

  if (useModular) {
    const actions = buildModularActions(
      signerAddress,
      ROUTER_ADDRESS,
      inputAmount,
      feeAmount,
      minAmountOut > feeAmount ? minAmountOut - feeAmount : 0n,
      ooRouterAddress,
      swapData,
    );
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [
      actions,
    ]);
    console.log('Using performModularExecution');
  } else {
    const exec = buildMonolithicExecution(
      signerAddress,
      inputAmount,
      feeAmount,
      minAmountOut,
      ooRouterAddress,
      swapData,
    );
    execCalldata = routerIface.encodeFunctionData('performExecution', [exec]);
    console.log('Using performExecution (monolithic)');
  }

  // AH.exec is called with AAVE as the token grant — ETH is handled internally
  // by the swap. msg.value=0 since the input token is ERC-20.
  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);
  console.log('Sending AllowanceHolder.exec transaction...');
  const receipt = await execViaAH(
    signer,
    ROUTER_ADDRESS,
    TOKENS.AAVE_ETH,
    inputAmount,
    ROUTER_ADDRESS,
    execCalldata,
    0n, // no ETH needed from caller; ETH comes from the swap output
  );

  console.log(`\nSuccess! Gas used: ${receipt.gasUsed.toString()}`);
  console.log(
    `ETH will arrive on Arbitrum at ${signerAddress} (via inbox deposit).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
