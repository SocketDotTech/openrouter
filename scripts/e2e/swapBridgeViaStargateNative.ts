/**
 * Script 4 — Swap USDC Arbitrum → native ETH Arbitrum via OpenOcean,
 *            then bridge ETH Arbitrum → ETH Base via Stargate Native Pool
 *
 * Flow:
 *   1. Fetch the signer's full USDC balance on Arbitrum as input.
 *   2. Fetch an OpenOcean swap_quote for USDC → native ETH on Arbitrum.
 *   3. Call Stargate quoteSend to get the LayerZero nativeFee.
 *   4. Pre-compute amountLD = estimatedFinalAmount - nativeFee for the Stargate calldata.
 *   5. Build either a monolithic or modular execution payload:
 *      - Monolithic: pull USDC via AH → swap USDC→ETH → post-fee (ETH to signer) →
 *                    Stargate send (useFinalAmountAsValue=true, static amountLD)
 *      - Modular:    pull USDC → approve OO → swap → ETH fee transfer →
 *                    Stargate send via CALL_WITH_NATIVE with static amountLD/msg.value
 *   6. Ensure AllowanceHolder ERC20 allowance for USDC.
 *   7. Execute AllowanceHolder.exec, forwarding nativeFee as msg.value so the
 *      router has enough ETH to cover both the bridge amount and the LZ fee.
 *
 * Stargate Native Pool design notes:
 *   Stargate's send() requires msg.value = amountLD + nativeFee.  We pre-encode
 *   amountLD = estimatedFinalAmount - nativeFee in the calldata (static — no splice).
 *   The caller provides nativeFee as msg.value to AH.exec; this is forwarded to the
 *   router alongside the USDC.  After the swap and fee deduction, the router's ETH
 *   balance = actualFinalAmount + nativeFee, which is always >= amountLD + nativeFee
 *   as long as the actual swap output >= the OO minimum (guaranteed by slippage).
 *   Any excess ETH is refunded to the signer by Stargate via refundAddress.
 *
 * Usage:
 *   ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts
 *   USE_MODULAR=true ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaStargateNative.ts
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  ROUTER_ADDRESS,
  TOKENS,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  ALLOWANCE_HOLDER,
  NATIVE_TOKEN_ADDRESS,
  STARGATE_NATIVE_ARB,
  BASE_LZ_EID,
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

// ─── Stargate ABI ─────────────────────────────────────────────────────────────

/**
 * Minimal Stargate OFT/Native pool ABI fragments needed for quoting and bridging.
 * The SendParam struct and MessagingFee struct are encoded inline as tuples.
 */
const STARGATE_ABI = [
  // Quote the LayerZero fee for a given SendParam
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  // Query OFT limits and expected receive amounts (for informational logging)
  'function quoteOFT(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) external view returns (tuple(uint256 minAmountLD, uint256 maxAmountLD) oftLimit, tuple(int256 feeAmountLD, string description)[] oftFeeDetails, tuple(uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  // Execute the bridge transfer; msg.value = amountLD + nativeFee
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) messagingFee, address refundAddress) external payable',
];

// ─── OpenOcean swap quote ─────────────────────────────────────────────────────

interface OpenOceanSwapQuoteResponse {
  data: {
    to: string;
    data: string;
    value: string;
    estimatedGas: string;
    outAmount: string;
    minOutAmount: string;
  };
}

/**
 * Fetches a swap_quote from OpenOcean for USDC → native ETH on Arbitrum.
 * The router is used as both sender and account so the swap output lands in the router.
 *
 * @param routerAddress  Address that will execute the swap (receives ETH output)
 * @param inputAmount    Amount of USDC in base units (6 decimals)
 * @param slippageBps    Slippage tolerance in basis points (e.g. 100 = 1%)
 */
async function fetchOpenOceanSwapQuote(
  routerAddress: string,
  inputAmount: bigint,
  slippageBps: number = 100,
): Promise<{
  routerAddress: string;
  swapData: string;
  minAmountOut: bigint;
  estimatedOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.USDC_ARB,
    // OpenOcean uses the canonical ETH sentinel for native output
    outTokenAddress: NATIVE_TOKEN_ADDRESS,
    amount: ethers.formatUnits(inputAmount, 6), // USDC has 6 decimals
    slippage: (slippageBps / 100).toString(),
    // sender = account = router so the swap executes from and into the router
    sender: routerAddress,
    account: routerAddress,
    gasPrice: '1', // gwei; does not affect routing
  };
  if (OPEN_OCEAN_API_KEY) {
    params['apikey'] = OPEN_OCEAN_API_KEY;
  }

  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.ARBITRUM}/swap_quote`;
  const response = await axios.get<OpenOceanSwapQuoteResponse>(url, { params });
  const q = response.data.data;

  return {
    routerAddress: q.to,
    swapData: q.data,
    minAmountOut: BigInt(q.minOutAmount),
    estimatedOut: BigInt(q.outAmount),
  };
}

// ─── Stargate quote ───────────────────────────────────────────────────────────

/**
 * Builds the Stargate SendParam and fetches both quoteSend (nativeFee) and
 * quoteOFT (expected receive amount on Base) in parallel.
 *
 * @param provider         JSON-RPC provider connected to Arbitrum
 * @param recipientAddress Recipient address on Base (refundAddress for excess)
 * @param bridgeAmountLD   Tentative amountLD for the quote (wei)
 */
async function fetchStargateQuote(
  provider: ethers.JsonRpcProvider,
  recipientAddress: string,
  bridgeAmountLD: bigint,
): Promise<{
  nativeFee: bigint;
  amountReceivedLD: bigint;
}> {
  const stargate = new ethers.Contract(STARGATE_NATIVE_ARB, STARGATE_ABI, provider);

  // Stargate uses bytes32-padded address for `to`
  const recipientBytes32 = ethers.zeroPadValue(recipientAddress, 32);

  const sendParam = {
    dstEid: BASE_LZ_EID,
    to: recipientBytes32,
    amountLD: bridgeAmountLD,
    // minAmountLD for quoting: use 0 so the quote always succeeds
    minAmountLD: 0n,
    extraOptions: '0x', // Stargate native pools use empty extraOptions
    composeMsg: '0x',
    oftCmd: '0x',
  };

  const [messagingFee, oftQuote] = await Promise.all([
    stargate.quoteSend(sendParam, false), // payInLzToken=false → native fee
    stargate.quoteOFT(sendParam),
  ]);

  return {
    nativeFee: messagingFee.nativeFee as bigint,
    amountReceivedLD: (oftQuote.oftReceipt.amountReceivedLD as bigint),
  };
}

// ─── Stargate send() calldata ─────────────────────────────────────────────────

/**
 * Encodes the Stargate send() calldata.
 *
 * amountLD is the exact amount passed to Stargate.  Stargate's Native pool
 * requires msg.value = amountLD + nativeFee; the caller must forward the total.
 *
 * @param amountLD        Amount of ETH to bridge (wei); static — no splice needed
 * @param nativeFee       LayerZero messaging fee (wei)
 * @param recipientAddress Recipient on Base (also the refundAddress for excess ETH)
 */
function buildStargateCalldata(
  amountLD: bigint,
  nativeFee: bigint,
  recipientAddress: string,
): string {
  const stargateIface = new ethers.Interface(STARGATE_ABI);
  const recipientBytes32 = ethers.zeroPadValue(recipientAddress, 32);

  return stargateIface.encodeFunctionData('send', [
    {
      dstEid: BASE_LZ_EID,
      to: recipientBytes32,
      amountLD,
      minAmountLD: 0n, // accept any amount received on destination (e2e testing)
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    },
    {
      nativeFee,
      lzTokenFee: 0n,
    },
    recipientAddress, // refundAddress: excess ETH (if amountLD < msg.value - nativeFee) goes here
  ]);
}

// ─── Monolithic builder ───────────────────────────────────────────────────────

/**
 * Builds a MonolithicExecution struct for:
 *   pull USDC → swap USDC→ETH (OO) → post-fee ETH to signer → Stargate send
 *
 * Bridge design:
 *   - amountLD is pre-encoded in stargateData as (minAmountOut - feeAmount - nativeFeeWithBuffer).
 *   - useFinalAmountAsValue=true forwards the actual post-fee ETH (finalAmount) as msg.value.
 *   - Because finalAmount >= minAmountOut - feeAmount = amountLD + nativeFeeWithBuffer >= amountLD + nativeFee,
 *     the Stargate msg.value check always passes regardless of swap slippage.
 *   - Any excess ETH (finalAmount - amountLD - nativeFee) is refunded by Stargate to refundAddress.
 *
 * @param signerAddress   Signer/recipient address
 * @param inputAmount     USDC amount in base units
 * @param feeAmount       Post-swap fee in wei (ETH)
 * @param minAmountOut    Minimum ETH from swap (wei); swap reverts if output < this
 * @param ooRouterAddress OpenOcean router address returned by the quote
 * @param swapData        OpenOcean swap calldata
 * @param stargateData    Pre-built Stargate send() calldata
 */
function buildMonolithicExecution(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouterAddress: string,
  swapData: string,
  stargateData: string,
): MonolithicExecution {
  return {
    input: {
      user: signerAddress,
      inputToken: TOKENS.USDC_ARB,
      inputAmount,
    },
    preFee: NO_FEE,
    swap: {
      target: ooRouterAddress,
      approvalSpender: ooRouterAddress,
      outputToken: NATIVE_TOKEN_ADDRESS, // ETH out
      value: 0n,
      minOutput: minAmountOut,
      data: swapData,
    },
    postFee: {
      receiver: signerAddress,
      amount: feeAmount,
    },
    bridge: {
      target: STARGATE_NATIVE_ARB,
      approvalSpender: ZERO_ADDRESS, // native ETH — no ERC20 approval needed
      value: 0n,
      data: stargateData,
      // amountLD is pre-encoded in stargateData; no runtime splice needed
      amountPositions: [],
      // Router forwards actualFinalAmount as msg.value to Stargate.
      // Caller ensures nativeFee is included in AH.exec msg.value so that
      // router's ETH balance = actualFinalAmount + nativeFee at bridge time.
      useFinalAmountAsValue: true,
    },
  };
}

// ─── Modular builder ──────────────────────────────────────────────────────────

/**
 * Builds the Action array for modular execution:
 *   [0] AH.transferFrom USDC (pull from user)
 *   [1] USDC.approve(ooRouter, inputAmount)
 *   [2] Call OO router to swap USDC → ETH
 *   [3] Send feeAmount ETH to signer via CALL_WITH_NATIVE
 *   [4] Stargate send() via CALL_WITH_NATIVE
 *
 * amountLD in the calldata and msg.value are pre-encoded and do not need splicing.
 *
 * @param signerAddress   Signer/recipient address
 * @param routerAddress   Router contract address (receives ETH from swap)
 * @param inputAmount     USDC input amount
 * @param feeAmount       Post-swap fee in wei (ETH)
 * @param ooRouterAddress OpenOcean router address
 * @param swapData        OpenOcean swap calldata
 * @param stargateData    Pre-built Stargate send() calldata
 */
function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  bridgeValue: bigint,
  ooRouterAddress: string,
  swapData: string,
  stargateData: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.USDC_ARB,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.USDC_ARB, encodeApprove(ooRouterAddress, inputAmount));
  exec.call(ooRouterAddress, swapData);
  exec.nativeCall(signerAddress, '0x', feeAmount);
  exec.nativeCall(STARGATE_NATIVE_ARB, stargateData, bridgeValue);
  return exec.toActions();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const useModular = false;
  const provider = new ethers.JsonRpcProvider(RPC.ARBITRUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  // ── 1. Read full USDC balance ───────────────────────────────────────────────
  const inputToken = TOKENS.USDC_ARB;
  const { balance: inputAmount, decimals: inputDecimals } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (inputAmount === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero USDC balance on Arbitrum. ` +
        'Fund the wallet with USDC on Arbitrum first.',
    );
  }

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ADDRESS}`);
  console.log(`Input token:   ${inputToken} (USDC Arbitrum)`);
  console.log(`Input:         ${ethers.formatUnits(inputAmount, inputDecimals)} USDC (full wallet balance)`);
  console.log(`Mode:          ${useModular ? 'MODULAR' : 'MONOLITHIC'}`);
  console.log('');

  // ── 2. Fetch OpenOcean swap quote ──────────────────────────────────────────
  console.log('Fetching OpenOcean swap quote (USDC → native ETH, Arbitrum)...');
  const {
    routerAddress: ooRouterAddress,
    swapData,
    minAmountOut,
    estimatedOut,
  } = await fetchOpenOceanSwapQuote(ROUTER_ADDRESS, inputAmount);

  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  const estimatedFinalAmount = estimatedOut - feeAmount;

  console.log(`OO Router:            ${ooRouterAddress}`);
  console.log(`Est. ETH out:         ${ethers.formatEther(estimatedOut)} ETH`);
  console.log(`Post-swap fee:        ${ethers.formatEther(feeAmount)} ETH (${FEE_BPS} bps)`);
  console.log(`Est. final amount:    ${ethers.formatEther(estimatedFinalAmount)} ETH`);
  console.log(`Min ETH out (OO):     ${ethers.formatEther(minAmountOut)} ETH`);
  console.log('');

  // ── 3. Fetch Stargate quote (nativeFee + expected receive amount) ───────────
  console.log('Fetching Stargate quoteSend (ETH Arbitrum → ETH Base)...');
  const { nativeFee, amountReceivedLD } = await fetchStargateQuote(
    provider,
    signerAddress, // recipient on Base
    estimatedFinalAmount, // tentative amount for quoting
  );

  // Add 5% buffer to nativeFee to guard against LZ fee fluctuations between
  // quote time and tx inclusion (mirrors the EVM_NATIVE_FEE_BUFFER_PERCENT pattern
  // in oft.service.ts).
  const nativeFeeWithBuffer = (nativeFee * 105n) / 100n;

  // amountLD to encode in the send() calldata.
  //
  // Stargate requires msg.value >= amountLD + nativeFee.  With
  // useFinalAmountAsValue=true, msg.value = finalAmount = actualSwapOut - feeAmount.
  //
  // To guarantee this holds even under maximum OO slippage we base amountLD on
  // minAmountOut (OO's slippage floor) rather than estimatedOut:
  //
  //   amountLD = minAmountOut - feeAmount - nativeFeeWithBuffer
  //
  // Because feeAmount is a fixed pre-encoded value and feeAmount <= estimatedOut,
  // we know actualSwapOut >= minAmountOut, so:
  //   finalAmount = actualSwapOut - feeAmount >= minAmountOut - feeAmount
  //              = amountLD + nativeFeeWithBuffer >= amountLD + nativeFee  ✓
  //
  // Any excess ETH (finalAmount - amountLD - nativeFee) is refunded to the signer
  // by Stargate via refundAddress.
  //
  // Using estimatedFinalAmount instead here will fail when slippage causes
  // finalAmount < estimatedFinalAmount (Stargate_InvalidAmount 0x3442dd95).
  const minFinalAmount = minAmountOut - feeAmount;
  const amountLD = minFinalAmount - nativeFeeWithBuffer;
  if (amountLD <= 0n) {
    throw new Error(
      `minAmountOut (${ethers.formatEther(minAmountOut)}) is too small to cover ` +
        `feeAmount (${ethers.formatEther(feeAmount)}) + nativeFee (${ethers.formatEther(nativeFeeWithBuffer)}). ` +
        'Increase your USDC balance.',
    );
  }

  console.log(`Stargate nativeFee:   ${ethers.formatEther(nativeFee)} ETH`);
  console.log(`nativeFee (+5% buf):  ${ethers.formatEther(nativeFeeWithBuffer)} ETH`);
  console.log(`amountLD (encoded):   ${ethers.formatEther(amountLD)} ETH  ← based on minAmountOut; excess refunded on-chain`);
  console.log(`Est. received Base:   ${ethers.formatEther(amountReceivedLD)} ETH`);
  console.log('');

  // ── 4. Build Stargate send() calldata ──────────────────────────────────────
  const stargateData = buildStargateCalldata(amountLD, nativeFeeWithBuffer, signerAddress);

  // ── 5. Build router execution calldata ─────────────────────────────────────
  const routerIface = new ethers.Interface(ROUTER_ABI);
  let execCalldata: string;

  if (useModular) {
    const actions = buildModularActions(
      signerAddress,
      ROUTER_ADDRESS,
      inputAmount,
      feeAmount,
      amountLD + nativeFeeWithBuffer,
      ooRouterAddress,
      swapData,
      stargateData,
    );
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [actions]);
    console.log('Using performModularExecution (modular)');
  } else {
    const exec = buildMonolithicExecution(
      signerAddress,
      inputAmount,
      feeAmount,
      minAmountOut,
      ooRouterAddress,
      swapData,
      stargateData,
    );
    execCalldata = routerIface.encodeFunctionData('performExecution', [exec]);
    console.log('Using performExecution (monolithic)');
  }

  // ── 6. Ensure AllowanceHolder ERC20 approval ───────────────────────────────
  // USDC must be approved to AllowanceHolder before the exec call.
  // Native ETH (the bridge token) does not require ERC20 approval.
  await ensureAllowanceForAllowanceHolder(signer, inputToken, inputAmount);

  // ── 7. Execute via AllowanceHolder.exec ────────────────────────────────────
  // msg.value = nativeFeeWithBuffer (forwarded to the router alongside USDC pull).
  // The router needs this ETH in its balance so that after the swap:
  //   router.balance = actualFinalAmount + nativeFeeWithBuffer
  //   Stargate action msg.value = prequoted amountLD + nativeFeeWithBuffer
  console.log(
    `Sending AllowanceHolder.exec with msg.value = ${ethers.formatEther(nativeFeeWithBuffer)} ETH (LZ fee)...`,
  );
  const receipt = await execViaAH(
    signer,
    ROUTER_ADDRESS,      // operator — the contract allowed to pull USDC via AH.transferFrom
    TOKENS.USDC_ARB,     // token AH is granting ephemeral allowance for
    inputAmount,         // amount of USDC allowed
    ROUTER_ADDRESS,      // target — the router to call with execCalldata
    execCalldata,        // encoded performExecution / performModularExecution call
    nativeFeeWithBuffer, // msg.value forwarded through AH to cover the LZ nativeFee
  );

  console.log('');
  console.log(`Transaction hash: ${receipt.hash}`);
  console.log(`Gas used:         ${receipt.gasUsed?.toString() ?? 'unknown'}`);
  console.log('');
  console.log('Swap and bridge submitted successfully.');
  console.log(`  Swapped:  USDC Arbitrum → ETH Arbitrum (~${ethers.formatEther(estimatedOut)} ETH)`);
  console.log(`  Fee:      ~${ethers.formatEther(feeAmount)} ETH to ${signerAddress}`);
  console.log(`  Bridging: ~${ethers.formatEther(amountLD)} ETH → ETH Base via Stargate`);
  console.log(`  Recipient on Base: ${signerAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
