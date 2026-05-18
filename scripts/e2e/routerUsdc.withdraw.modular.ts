/**
 * Polygon: sweep USDC from `BungeeOpenRouterV2Unchecked` to the tx sender using
 * `performModularExecution` only — no AllowanceHolder, no pull step.
 *
 * Actions:
 *   [0] STATICCALL USDC.balanceOf(router) — stored returndata (32-byte uint256)
 *   [1] CALL USDC.transfer(caller, 0) — amount word spliced from [0], so net effect
 *       is transferring the router's entire USDC balance to `msg.sender` of this tx.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ts-node scripts/e2e/polygon/routerUsdc.withdraw.modular.ts
 *
 * Requires the router contract to actually hold Polygon USDC
 * ({@link TOKENS.USDC_POLYGON_CIRCLE}).
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import { CHAIN_IDS, routerAddressForChain, TOKENS, RPC } from './config';
import {
  encodeBalanceOf,
  encodeTransfer,
  getWalletErc20Balance,
} from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ModularActionsBuilder } from './utils/modularActionsBuilder/index';
import { ZERO_BYTES32 } from './utils/contractTypes';
import { logTxnSummary } from './utils/txnLogSummary';

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY env var required');
  }

  const chainId = CHAIN_IDS.POLYGON;
  const rpcUrl = process.env.POLYGON_RPC ?? process.env.RPC_URL ?? RPC.POLYGON;
  const routerAddress = routerAddressForChain(chainId);
  const usdc = TOKENS.USDC_POLYGON_CIRCLE;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const { balance: routerBalance } = await getWalletErc20Balance(
    usdc,
    routerAddress,
    provider,
  );
  if (routerBalance === 0n) {
    throw new Error(`Router ${routerAddress} holds zero USDC on Polygon`);
  }

  console.log(`Signer:           ${signerAddress}`);
  console.log(`Router:           ${routerAddress}`);
  console.log(`Router USDC bal: ${ethers.formatUnits(routerBalance, 6)}`);

  const exec = new ModularActionsBuilder();
  const routerBal = exec.staticCall(usdc, encodeBalanceOf(routerAddress));

  exec
    .call(usdc, encodeTransfer(signerAddress, 0n))
    .spliceArg(1, routerBal.ref().returnWord(0));

  const routerIface = new ethers.Interface(ROUTER_ABI);
  const calldata = routerIface.encodeFunctionData('performModularExecution', [
    ZERO_BYTES32,
    exec.toActions(),
  ]);

  console.log(
    'Sending performModularExecution (balanceOf → transfer with spliced amount)...',
  );
  const tx = await signer.sendTransaction({
    to: routerAddress,
    data: calldata,
  });
  console.log(`Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();

  if (receipt == null || receipt.status !== 1) {
    throw new Error('Transaction failed or missing receipt');
  }

  logTxnSummary(
    'Polygon — withdraw router USDC to caller via performModularExecution',
    chainId,
    receipt,
  );

  const { balance: signerAfter } = await getWalletErc20Balance(
    usdc,
    signerAddress,
    provider,
  );
  console.log(`Signer USDC after: ${ethers.formatUnits(signerAfter, 6)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
