/**
 * Script — Call ERC-20 approve(spender, amount) through the router using
 *          `performActions(Action[])`.
 *
 * DISABLED by default: `OpenRouter` now sets max allowance inside
 * `swap`, `bridge`, and `swapAndBridge`. Use those entrypoints instead of a
 * standalone approval tx. Set `E2E_ENABLE_MODULAR_PRE_APPROVE=1` only if you
 * need this legacy helper for manual modular debugging.
 *
 * Usage:
 *   TOKEN=0x... SPENDER=0x... AMOUNT=1000000 PRIVATE_KEY=0x... \
 *     ts-node scripts/e2e/approveViaModular.ts
 *
 *   Optional:
 *     CHAIN_ID=137       (default: 137, Polygon)
 *     AMOUNT=max         (uses MaxUint256)
 *
 * actionInfo packing (from the contract):
 *   bits  0-7  : callType  (0 = CALL)
 *   bits  8-15 : storeResult flag (0 = don't store)
 *   bits 16+   : target address (uint160)
 */
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

import { CHAIN_IDS, routerAddressForChain, RPC, TOKENS } from './config';
import { encodeApprove } from './utils/erc20';
import { ROUTER_ABI } from './utils/routerAbi';
import { ZERO_BYTES32 } from './utils/contractTypes';

// ─── actionInfo helpers ───────────────────────────────────────────────────────

const CallType = { CALL: 0n, STATICCALL: 1n, CALL_WITH_NATIVE: 2n } as const;

function packActionInfo(
  target: string,
  callType = CallType.CALL,
  storeResult = false,
): bigint {
  return (BigInt(target) << 16n) | (storeResult ? 0x100n : 0n) | callType;
}

// ─── build + send ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  if (process.env.E2E_ENABLE_MODULAR_PRE_APPROVE !== '1') {
    console.log(
      'approveViaModular is disabled (router pre-approves in swap/bridge/swapAndBridge).',
    );
    console.log('Set E2E_ENABLE_MODULAR_PRE_APPROVE=1 to run this script.');
    return;
  }

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY env var required');

  const token = TOKENS.USDC_POLYGON_CIRCLE;
  if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) {
    throw new Error(
      'TOKEN env var required (checksummed or lowercase ERC-20 address)',
    );
  }

  const spender = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d'; // cctp tokenmessengerv2
  if (!spender || !/^0x[a-fA-F0-9]{40}$/.test(spender)) {
    throw new Error(
      'SPENDER env var required (checksummed or lowercase address)',
    );
  }

  const amount = ethers.MaxUint256;

  const chainId = CHAIN_IDS.POLYGON;
  const rpcUrl: string =
    process.env.RPC_URL ??
    (chainId === CHAIN_IDS.POLYGON
      ? RPC.POLYGON
      : chainId === CHAIN_IDS.ARBITRUM
      ? RPC.ARBITRUM
      : chainId === CHAIN_IDS.BASE
      ? RPC.BASE
      : chainId === CHAIN_IDS.ETHEREUM
      ? RPC.ETHEREUM
      : (() => {
          throw new Error(`No default RPC for chain ${chainId}; set RPC_URL`);
        })());

  const routerAddress = routerAddressForChain(chainId);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();

  const routerIface = new ethers.Interface(ROUTER_ABI);

  const approveCalldata = encodeApprove(spender, amount);

  // Single action: CALL token.approve(spender, amount) from the router.
  const actions = [
    {
      actionInfo: packActionInfo(token),
      data: approveCalldata,
      splices: [],
    },
  ];

  const calldata = routerIface.encodeFunctionData('performActions', [
    ZERO_BYTES32,
    actions,
  ]);

  console.log(`Signer:   ${signerAddress}`);
  console.log(`Chain:    ${chainId}`);
  console.log(`Router:   ${routerAddress}`);
  console.log(`Token:    ${token}`);
  console.log(`Spender:  ${spender}`);
  console.log(
    `Amount:   ${
      amount === ethers.MaxUint256 ? 'MaxUint256' : amount.toString()
    }`,
  );
  console.log('Sending performActions → token.approve...');

  const tx = await signer.sendTransaction({
    to: routerAddress,
    data: calldata,
  });
  console.log(`Tx hash:  ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(
    `Status:   ${receipt?.status === 1 ? 'success' : 'reverted'} (block ${
      receipt?.blockNumber
    })`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  await run();
}
