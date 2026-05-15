/**
 * Script 2 — Swap AAVE→USDC on Polygon, then bridge USDC to Base via CCTP v2
 *
 * OpenOcean must output Circle’s **native** Polygon USDC (`USDC_POLYGON_CIRCLE`).
 * Bridged USDC (`0x2791…`, USDC.e) is rejected by TokenMessenger (“Burn token not supported”).
 *
 * Each run uses half of the initial AAVE snapshot: monolithic then modular.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaCctp.ts
 *   Polygon native USDC → Base USDC via CCTP only (no OpenOcean swap):
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/swapBridgeViaCctp.ts usdc-polygon-base
 *
 * Router on Polygon: {@link ROUTER_BY_CHAIN_ID} / `routerAddressForChain(137)`.
 */
import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  CHAIN_IDS,
  routerAddressForChain,
  TOKENS,
  CCTP_CONFIG,
  FEE_BPS,
  bpsOf,
  RPC,
  OPEN_OCEAN_API_KEY,
  OO_SLIPPAGE_PERCENT,
  ALLOWANCE_HOLDER,
} from './config';
import { execViaAH, ensureAllowanceForAllowanceHolder } from './utils/allowanceHolder';
import { encodeApprove, encodeTransfer, encodeBalanceOf, getWalletErc20Balance } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import type { ModularAction } from './utils/modularActionsBuilder/index';
import {
  MonolithicExecutionCall,
  NO_FEE,
  NO_SWAP,
  ZERO_BYTES32,
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

async function fetchOpenOceanSwapQuote(
  routerAddress: string,
  inputAmount: bigint,
): Promise<{
  routerAddress: string;
  swapData: string;
  minAmountOut: bigint;
  estimatedOut: bigint;
}> {
  const params: Record<string, string> = {
    inTokenAddress: TOKENS.AAVE_POLYGON,
    outTokenAddress: TOKENS.USDC_POLYGON_CIRCLE,
    amount: ethers.formatUnits(inputAmount, 18),
    slippage: OO_SLIPPAGE_PERCENT,
    sender: routerAddress,
    account: routerAddress,
    gasPrice: '1',
  };
  if (OPEN_OCEAN_API_KEY) {
    params.apikey = OPEN_OCEAN_API_KEY;
  }

  const url = `https://open-api.openocean.finance/v3/${CHAIN_IDS.POLYGON}/swap_quote`;
  const response = await axios.get<OpenOceanSwapQuoteResponse>(url, { params });
  const q = response.data.data;

  return {
    routerAddress: q.to,
    swapData: q.data,
    minAmountOut: BigInt(q.minOutAmount),
    estimatedOut: BigInt(q.outAmount),
  };
}

function buildDepositForBurnCalldata(
  recipientAddress: string,
  burnToken: string,
  destinationCctpDomain: number,
  fastPath: boolean = true,
): string {
  const iface = new ethers.Interface([
    'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
  ]);

  const mintRecipient = ethers.zeroPadValue(recipientAddress, 32);
  const maxFee = fastPath ? 1_000_000n : 0n;
  const minFinalityThreshold = fastPath ? 1000 : 2000;

  return iface.encodeFunctionData('depositForBurn', [
    0n,
    destinationCctpDomain,
    mintRecipient,
    burnToken,
    ethers.ZeroHash,
    maxFee,
    minFinalityThreshold,
  ]);
}

function buildMonolithicExecution(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  minAmountOut: bigint,
  ooRouterAddress: string,
  swapData: string,
  depositForBurnData: string,
  tokenMessenger: string,
): MonolithicExecutionCall {
  return {
    exec: {
      input: {
        user: signerAddress,
        inputToken: TOKENS.AAVE_POLYGON,
        inputAmount,
      },
      preFee: NO_FEE,
      swap: {
        target: ooRouterAddress,
        approvalSpender: ooRouterAddress,
        outputToken: TOKENS.USDC_POLYGON_CIRCLE,
        value: 0n,
        minOutput: minAmountOut,
        returnDataWordOffset: 0n,
      },
      postFee: {
        receiver: signerAddress,
        amount: feeAmount,
      },
      bridge: {
        target: tokenMessenger,
        approvalSpender: tokenMessenger,
        value: 0n,
      },
      flags: bridgeAmountPositionFlag(4n),
    },
    swapCallData: swapData,
    bridgeCallData: depositForBurnData,
  };
}

function buildModularActions(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  ooRouterAddress: string,
  swapData: string,
  depositForBurnData: string,
  tokenMessenger: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.AAVE_POLYGON,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.AAVE_POLYGON, encodeApprove(ooRouterAddress, inputAmount));
  exec.call(ooRouterAddress, swapData);
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeApprove(tokenMessenger, ethers.MaxUint256));
  const balance = exec.staticCall(TOKENS.USDC_POLYGON_CIRCLE, encodeBalanceOf(routerAddress));
  exec.call(tokenMessenger, depositForBurnData).spliceArg(0, balance.returnWord());
  return exec.toActions();
}

function buildMonolithicExecutionUsdcPolygonToBaseCctp(
  signerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  depositForBurnData: string,
  tokenMessenger: string,
): MonolithicExecutionCall {
  return {
    exec: {
      input: {
        user: signerAddress,
        inputToken: TOKENS.USDC_POLYGON_CIRCLE,
        inputAmount,
      },
      preFee: {
        receiver: signerAddress,
        amount: feeAmount,
      },
      swap: NO_SWAP,
      postFee: NO_FEE,
      bridge: {
        target: tokenMessenger,
        approvalSpender: tokenMessenger,
        value: 0n,
      },
      flags: bridgeAmountPositionFlag(4n),
    },
    swapCallData: '0x',
    bridgeCallData: depositForBurnData,
  };
}

function buildModularActionsUsdcPolygonToBaseCctp(
  signerAddress: string,
  routerAddress: string,
  inputAmount: bigint,
  feeAmount: bigint,
  depositForBurnData: string,
  tokenMessenger: string,
): ModularAction[] {
  const ahIface = new ethers.Interface([
    'function transferFrom(address token, address owner, address recipient, uint256 amount)',
  ]);
  const ahTransferFromData = ahIface.encodeFunctionData('transferFrom', [
    TOKENS.USDC_POLYGON_CIRCLE,
    signerAddress,
    routerAddress,
    inputAmount,
  ]);

  const exec = new ModularActionsBuilder();
  exec.call(ALLOWANCE_HOLDER, ahTransferFromData);
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeTransfer(signerAddress, feeAmount));
  exec.call(TOKENS.USDC_POLYGON_CIRCLE, encodeApprove(tokenMessenger, ethers.MaxUint256));
  const balance = exec.staticCall(TOKENS.USDC_POLYGON_CIRCLE, encodeBalanceOf(routerAddress));
  exec.call(tokenMessenger, depositForBurnData).spliceArg(0, balance.returnWord());
  return exec.toActions();
}

async function executeLegUsdcPolygonToBaseCctp(args: {
  label: string;
  useModular: boolean;
  signer: ethers.Wallet;
  signerAddress: string;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const { label, useModular, signer, signerAddress, inputAmount, routerIface } = args;

  console.log(`\n── ${label} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);

  const feeAmount = bpsOf(inputAmount, FEE_BPS);
  console.log(`Input USDC:      ${ethers.formatUnits(inputAmount, 6)}`);
  console.log(`Pre-bridge fee:  ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`);
  console.log(`Net to bridge:   ${ethers.formatUnits(inputAmount - feeAmount, 6)}`);

  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];
  console.log(`CCTP burn token: ${polyCctp.usdcAddress}`);
  const depositForBurnData = buildDepositForBurnCalldata(
    signerAddress,
    polyCctp.usdcAddress,
    baseCctp.cctpDomain,
    true,
  );

  await ensureRouterErc20Balance(signer, TOKENS.USDC_POLYGON_CIRCLE, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, polyCctp.tokenMessenger);

  let execCalldata: string;
  if (useModular) {
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [
      ZERO_BYTES32,
      buildModularActionsUsdcPolygonToBaseCctp(
        signerAddress,
        ROUTER_POLYGON,
        inputAmount,
        feeAmount,
        depositForBurnData,
        polyCctp.tokenMessenger,
      ),
    ]);
  } else {
    execCalldata = routerIface.encodeFunctionData('performExecution', monolithicArgs(
      buildMonolithicExecutionUsdcPolygonToBaseCctp(
        signerAddress,
        inputAmount,
        feeAmount,
        depositForBurnData,
        polyCctp.tokenMessenger,
      ),
    ));
  }

  await ensureAllowanceForAllowanceHolder(
    signer,
    TOKENS.USDC_POLYGON_CIRCLE,
    inputAmount,
  );
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.USDC_POLYGON_CIRCLE,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
  );

  const modeLabel = useModular ? 'Modular' : 'Monolithic';
  logTxnSummary(
    `Polygon USDC → Base USDC — CCTP — ${modeLabel}`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
}

async function executeLeg(args: {
  label: string;
  useModular: boolean;
  signer: ethers.Wallet;
  signerAddress: string;
  inputAmount: bigint;
  routerIface: ethers.Interface;
}): Promise<void> {
  const { label, useModular, signer, signerAddress, inputAmount, routerIface } = args;

  console.log(`\n── ${label} (${useModular ? 'MODULAR' : 'MONOLITHIC'}) ──`);

  console.log('Fetching OpenOcean swap quote (Polygon AAVE → Circle native USDC)...');
  const {
    routerAddress: ooRouterAddress,
    swapData,
    minAmountOut,
    estimatedOut,
  } = await fetchOpenOceanSwapQuote(ROUTER_POLYGON, inputAmount);

  const feeAmount = bpsOf(estimatedOut, FEE_BPS);
  console.log(`OO Router:       ${ooRouterAddress}`);
  console.log(`Est. USDC out:   ${ethers.formatUnits(estimatedOut, 6)}`);
  console.log(`Post-swap fee:   ${ethers.formatUnits(feeAmount, 6)} (${FEE_BPS} bps)`);
  console.log(`Min USDC out:    ${ethers.formatUnits(minAmountOut, 6)}`);

  const polyCctp = CCTP_CONFIG[CHAIN_IDS.POLYGON];
  const baseCctp = CCTP_CONFIG[CHAIN_IDS.BASE];
  console.log(`CCTP burn token: ${polyCctp.usdcAddress} (must match swap output)`);
  const depositForBurnData = buildDepositForBurnCalldata(
    signerAddress,
    polyCctp.usdcAddress,
    baseCctp.cctpDomain,
    true,
  );

  await ensureRouterErc20Balance(signer, TOKENS.AAVE_POLYGON, ROUTER_POLYGON);
  await ensureRouterErc20Balance(signer, TOKENS.USDC_POLYGON_CIRCLE, ROUTER_POLYGON);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.AAVE_POLYGON, ooRouterAddress);
  await ensureRouterApproval(signer, ROUTER_POLYGON, TOKENS.USDC_POLYGON_CIRCLE, polyCctp.tokenMessenger);

  let execCalldata: string;
  if (useModular) {
    execCalldata = routerIface.encodeFunctionData('performModularExecution', [
      ZERO_BYTES32,
      buildModularActions(
        signerAddress,
        ROUTER_POLYGON,
        inputAmount,
        feeAmount,
        ooRouterAddress,
        swapData,
        depositForBurnData,
        polyCctp.tokenMessenger,
      ),
    ]);
  } else {
    execCalldata = routerIface.encodeFunctionData('performExecution', monolithicArgs(
      buildMonolithicExecution(
        signerAddress,
        inputAmount,
        feeAmount,
        minAmountOut,
        ooRouterAddress,
        swapData,
        depositForBurnData,
        polyCctp.tokenMessenger,
      ),
    ));
  }

  await ensureAllowanceForAllowanceHolder(signer, TOKENS.AAVE_POLYGON, inputAmount);
  const receipt = await execViaAH(
    signer,
    ROUTER_POLYGON,
    TOKENS.AAVE_POLYGON,
    inputAmount,
    ROUTER_POLYGON,
    execCalldata,
  );

  const modeLabel = useModular ? 'Modular' : 'Monolithic';
  logTxnSummary(
    `Polygon AAVE → Base USDC — OpenOcean + CCTP — ${modeLabel}`,
    CHAIN_IDS.POLYGON,
    receipt,
  );
}

async function mainUsdcPolygonToBaseCctp() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.USDC_POLYGON_CIRCLE;
  const { balance: walletBalance } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero Circle native USDC on Polygon. Fund ${inputToken} on Polygon PoS.`,
    );
  }

  const legAmount = (walletBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error(
      `Balance ${walletBalance} too small for two nonzero 50% legs.`,
    );
  }

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Polygon USDC:  ${ethers.formatUnits(walletBalance, 6)} (full)`);
  console.log(`Per leg input: ${ethers.formatUnits(legAmount, 6)} (50%)`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  await executeLegUsdcPolygonToBaseCctp({
    label: '1/2 Monolithic',
    useModular: false,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log('Sleeping ~3s before modular execution...');
  await sleep(3000);

  await executeLegUsdcPolygonToBaseCctp({
    label: '2/2 Modular',
    useModular: true,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log(
    `\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`,
  );
}

async function main() {
  const cctpE2eCase = process.argv[2]?.toLowerCase();
  if (cctpE2eCase === 'usdc-polygon-base' || cctpE2eCase === 'usdc') {
    await mainUsdcPolygonToBaseCctp();
    return;
  }

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const provider = new ethers.JsonRpcProvider(RPC.POLYGON);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const inputToken = TOKENS.AAVE_POLYGON;
  const { balance: walletBalance } = await getWalletErc20Balance(
    inputToken,
    signerAddress,
    provider,
  );
  if (walletBalance === 0n) {
    throw new Error(
      `Signer ${signerAddress} has zero Polygon AAVE. Fund ${inputToken} on Polygon PoS.`,
    );
  }

  const legAmount = (walletBalance - 20n) / 2n;
  if (legAmount === 0n) {
    throw new Error(
      `Balance ${walletBalance} too small for two nonzero 50% legs.`,
    );
  }

  console.log(`Signer:        ${signerAddress}`);
  console.log(`Router:        ${ROUTER_POLYGON}`);
  console.log(`Polygon AAVE:  ${ethers.formatUnits(walletBalance, 18)} (full)`);
  console.log(`Per leg input: ${ethers.formatUnits(legAmount, 18)} (50%)`);

  const routerIface = new ethers.Interface(ROUTER_ABI);

  await executeLeg({
    label: '1/2 Monolithic',
    useModular: false,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log('Sleeping ~3s before modular execution...');
  await sleep(3000);

  await executeLeg({
    label: '2/2 Modular',
    useModular: true,
    signer,
    signerAddress,
    inputAmount: legAmount,
    routerIface,
  });

  console.log(
    `\nUSDC mints on Base at ${signerAddress} once CCTP attestation completes.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
