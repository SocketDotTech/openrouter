/**
 * Script 2 — Swap AAVE→USDC on Arbitrum, then bridge USDC to Base via CCTP v2
 *
 * Flow:
 *   1. Fetch an OpenOcean swap quote for AAVE→USDC on Arbitrum.
 *   2. Build CCTP v2 depositForBurn calldata with a zero amount placeholder
 *      at byte offset 4 (the first parameter).
 *   3. Build either a monolithic or modular execution payload.
 *      - Monolithic: swap inside the router using pre/post balance delta,
 *        take a post-swap fee in USDC, splice finalAmount into depositForBurn,
 *        approve TOKEN_MESSENGER, call TOKEN_MESSENGER.
 *      - Modular: discrete actions — pull → approve(oo) → swap(oo) → transfer fee →
 *        approve(cctp) → staticcall balanceOf → call depositForBurn (splice balance→amount).
 *   4. Call AllowanceHolder.exec → router.performExecution / performModularExecution.
 *
 * Uses the signer’s full AAVE balance on Arbitrum as swap input (fund the wallet and approve AH as needed).
 *
 * Usage:
 *   ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaCctp.ts
 *   USE_MODULAR=true ROUTER_ADDRESS=0x... PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaCctp.ts
 *
 * CCTP v2 fast path:
 *   minFinalityThreshold=1000 (1000 confirmations, ~instant finality on supported chains)
 *   maxFee set to a small value; pass 0 for the standard (slower) path.
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  ROUTER_ADDRESS,
  TOKENS,
  CCTP_CONFIG,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  ALLOWANCE_HOLDER,
} from './config';
import { execViaAH } from './utils/allowanceHolder';
import { encodeApprove, encodeTransfer, encodeBalanceOf, getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import {
  MonolithicExecution,
  Action,
  CallType,
  NO_FEE,
  ZERO_ADDRESS,
} from './utils/contractTypes';

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
 * Fetches a swap quote from OpenOcean for AAVE→USDC on Arbitrum.
 * The router address is used as both sender and account so OpenOcean
 * routes the swap through the router itself.
 *
 * @param routerAddress  Address that will execute the swap (needs approval)
 * @param inputAmount    Amount of AAVE in wei
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
    inTokenAddress: TOKENS.AAVE_ARB,
    outTokenAddress: TOKENS.USDC_ARB,
    amount: ethers.formatUnits(inputAmount, 18), // OO expects human-readable amount
    slippage: (slippageBps / 100).toString(),
    sender: routerAddress,
    account: routerAddress,
    gasPrice: '1', // gwei; doesn't affect routing
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

// ─── CCTP depositForBurn calldata ─────────────────────────────────────────────

/**
 * Builds CCTP v2 depositForBurn calldata.
 * `amount` is set to 0 as a placeholder; it will be spliced in at runtime
 * (offset 4 in the calldata, i.e. amountPositions=[4] in MonolithicExecution).
 *
 * For the modular path a STATICCALL balanceOf + splice is used instead.
 *
 * Fast path: minFinalityThreshold=1000, maxFee=small value
 * Standard path: minFinalityThreshold=2000, maxFee=0
 */
function buildDepositForBurnCalldata(
  recipientAddress: string,
  burnToken: string,
  destinationCctpDomain: number,
  fastPath: boolean = true,
): string {
  const iface = new ethers.Interface([
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
  ]);

  // Pad the recipient address to bytes32
  const mintRecipient = ethers.zeroPadValue(recipientAddress, 32);

  // maxFee: small fee for fast path (e.g. 1 USDC = 1_000_000 units), 0 for standard
  const maxFee = fastPath ? 1_000_000n : 0n;
  const minFinalityThreshold = fastPath ? 1000 : 2000;

  return iface.encodeFunctionData('depositForBurn', [
    0n, // amount placeholder — spliced at runtime
    destinationCctpDomain,
    mintRecipient,
    burnToken,
    ethers.ZeroHash, // destinationCaller = anyone can complete
    maxFee,
    minFinalityThreshold,
  ]);
}

// ─── Monolithic builder ───────────────────────────────────────────────────────

/**
 * Builds a MonolithicExecution that:
 *   - Pulls inputAmount AAVE from user
 *   - No pre-swap fee
 *   - Swaps AAVE → USDC via OpenOcean (balance delta)
 *   - Takes feeAmount USDC as post-swap fee to signer
 *   - Splices finalAmount into depositForBurn at offset 4
 *   - Approves TOKEN_MESSENGER and calls depositForBurn
 */
function buildMonolithicExecution(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouterAddress: string,
  swapData: string,
  depositForBurnData: string,
  tokenMessenger: string,
): MonolithicExecution {
  return {
    input: {
      user: signerAddress,
      inputToken: TOKENS.AAVE_ARB,
      inputAmount,
    },
    preFee: NO_FEE,
    swap: {
      target: ooRouterAddress,
      approvalSpender: ooRouterAddress,
      outputToken: TOKENS.USDC_ARB,
      value: 0n,
      minOutput: minAmountOut,
      data: swapData,
    },
    postFee: {
      receiver: signerAddress,
      amount: feeAmount,
    },
    bridge: {
      target: tokenMessenger,
      approvalSpender: tokenMessenger,
      value: 0n,
      data: depositForBurnData,
      // amount is the first ABI param → at byte offset 4 (after 4-byte selector)
      amountPositions: [4n],
      useFinalAmountAsValue: false,
    },
  };
}

// ─── Modular builder ──────────────────────────────────────────────────────────

/**
 * Builds an Action array:
 *   [0] Pull AAVE via AH.transferFrom
 *   [1] Approve OpenOcean router for inputAmount
 *   [2] Call OpenOcean router to swap AAVE → USDC
 *   [3] Transfer feeAmount USDC to signer
 *   [4] Approve TOKEN_MESSENGER for MaxUint256 (covers any USDC balance)
 *   [5] STATICCALL USDC.balanceOf(router)     → prevReturn = 32-byte balance
 *   [6] Call TOKEN_MESSENGER.depositForBurn   → splice prevReturn[0..32] → data[4..36]
 */
function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  ooRouterAddress: string,
  swapData: string,
  depositForBurnData: string,
  tokenMessenger: string,
): Action[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.AAVE_ARB,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  return [
    // 0: pull AAVE from user via AH
    {
      callType: CallType.CALL,
      target: ALLOWANCE_HOLDER,
      value: 0n,
      data: ahTransferFromData,
      splices: [],
    },
    // 1: approve OpenOcean to spend AAVE
    {
      callType: CallType.CALL,
      target: TOKENS.AAVE_ARB,
      value: 0n,
      data: encodeApprove(ooRouterAddress, inputAmount),
      splices: [],
    },
    // 2: swap AAVE → USDC via OpenOcean
    {
      callType: CallType.CALL,
      target: ooRouterAddress,
      value: 0n,
      data: swapData,
      splices: [],
    },
    // 3: send post-swap fee in USDC to signer
    {
      callType: CallType.CALL,
      target: TOKENS.USDC_ARB,
      value: 0n,
      data: encodeTransfer(signerAddress, feeAmount),
      splices: [],
    },
    // 4: approve TOKEN_MESSENGER for unlimited USDC (router holds exact balance)
    {
      callType: CallType.CALL,
      target: TOKENS.USDC_ARB,
      value: 0n,
      data: encodeApprove(tokenMessenger, ethers.MaxUint256),
      splices: [],
    },
    // 5: staticcall USDC.balanceOf(router) → prevReturn = ABI-encoded uint256 balance
    {
      callType: CallType.STATICCALL,
      target: TOKENS.USDC_ARB,
      value: 0n,
      data: encodeBalanceOf(routerAddress),
      splices: [],
    },
    // 6: depositForBurn — splice the 32-byte balance from prevReturn into the
    //    amount field at dstOffset=4 (first param, after the 4-byte selector)
    {
      callType: CallType.CALL,
      target: tokenMessenger,
      value: 0n,
      data: depositForBurnData,
      splices: [
        {
          srcOffset: 0n, // read from start of prevReturn (the ABI uint256)
          dstOffset: 4n, // write into depositForBurn calldata after selector
          length: 32n, // uint256 = 32 bytes
        },
      ],
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.ARBITRUM);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.AAVE_ARB;
  const { balance: inputAmount, decimals: inputDecimals } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (inputAmount === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero balance of ${inputToken}. Fund the wallet with AAVE on Arbitrum first.`,
    );
  }
  const arbCctp = CCTP_CONFIG[CHAIN_IDS.ARBITRUM];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];
  const useModular = true;

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_ADDRESS}`);
  console.log(`Input token:   ${inputToken}`);
  console.log(
    `Input:         ${ethers.formatUnits(inputAmount, inputDecimals)} (full wallet balance)`,
  );
  console.log(`Mode:          ${useModular ? 'MODULAR' : 'MONOLITHIC'}`);
  console.log('');

  // Fetch OpenOcean quote
  console.log('Fetching OpenOcean swap quote (AAVE→USDC Arbitrum)...');
  const {
    routerAddress: ooRouterAddress,
    swapData,
    minAmountOut,
    estimatedOut,
  } = await fetchOpenOceanSwapQuote(ROUTER_ADDRESS, inputAmount);

  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`OO Router:       ${ooRouterAddress}`);
  console.log(`Est. USDC out:   ${ethers.formatUnits(estimatedOut, 6)} USDC`);
  console.log(
    `Post-swap fee:   ${ethers.formatUnits(feeAmount, 6)} USDC (${FEE_BPS} bps)`,
  );
  console.log(`Min USDC out:    ${ethers.formatUnits(minAmountOut, 6)} USDC`);
  console.log('');

  // Build CCTP depositForBurn calldata (amount=0 placeholder, will be spliced)
  const depositForBurnData = buildDepositForBurnCalldata(
    signerAddress, // recipient on Base
    arbCctp.usdcAddress, // token being burned
    baseCctp.cctpDomain, // destination domain = Base
    true, // fast path
  );

  const routerIface = new ethers.Interface(ROUTER_ABI);
  let execCalldata: string;

  if (useModular) {
    const actions = buildModularActions(
      signerAddress,
      ROUTER_ADDRESS,
      inputAmount,
      feeAmount,
      ooRouterAddress,
      swapData,
      depositForBurnData,
      arbCctp.tokenMessenger,
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
      depositForBurnData,
      arbCctp.tokenMessenger,
    );
    execCalldata = routerIface.encodeFunctionData('performExecution', [exec]);
    console.log('Using performExecution (monolithic)');
  }

  console.log('Sending AllowanceHolder.exec transaction...');
  const receipt = await execViaAH(
    signer,
    ROUTER_ADDRESS,
    TOKENS.AAVE_ARB,
    inputAmount,
    ROUTER_ADDRESS,
    execCalldata,
  );

  console.log(`\nSuccess! Gas used: ${receipt.gasUsed.toString()}`);
  console.log(
    `USDC will arrive on Base at ${signerAddress} after CCTP attestation.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
