/**
 * State-prep helpers for reproducible on-chain gas-cost tests.
 *
 * Callers must pass the deployed open-router address from config (`routerAddressForChain`, etc.),
 * never Relay `depositTarget`, CCTP `tokenMessenger`, or other external calldata targets.
 *
 * Before each test leg these ensure:
 *   1. The router holds ≥ 20 wei of every token whose balance slot will be written.
 *
 * Router→spender ERC-20 approvals are NOT pre-seeded here. `BungeeOpenRouter`
 * sets max allowance inside `swap`, `bridge`, and `swapAndBridge` when needed.
 * Modular `performActions` legs may still include inline `approve` actions in the
 * same transaction when testing raw modular flows.
 *
 * Seeding balance slots to non-zero means subsequent SSTORE writes cost ~2 900 gas
 * (non-zero → non-zero) rather than ~20 000 gas (zero → non-zero), giving
 * consistent gas readings across repeated runs.
 */
import { ethers } from 'ethers';
import { getErc20Contract } from './erc20';

const SEED_WEI = 20n;

/**
 * Transfers {@link SEED_WEI} of `token` from `signer` to the deployed open router only
 * when that router already holds zero — never to Relay/deposit/spender contracts.
 */
export async function ensureRouterErc20Balance(
  signer: ethers.Wallet,
  token: string,
  openRouterAddress: string,
): Promise<void> {
  const openRouter = ethers.getAddress(openRouterAddress);
  const tokenResolved = ethers.getAddress(token);
  const tokenRo = getErc20Contract(tokenResolved, signer.provider!);
  const bal = BigInt(await tokenRo.balanceOf(openRouter));
  if (bal > 0n) {
    return;
  }

  console.log(
    `  [state-prep] open router ${openRouter} token ${tokenResolved} balance=0 — signer transfer ${SEED_WEI} wei to open router only`,
  );
  const tx = await getErc20Contract(tokenResolved, signer).transfer(openRouter, SEED_WEI);
  await tx.wait();
}

/**
 * Sends {@link SEED_WEI} of native currency from `signer` to the open router when its
 * balance is zero; skipped when already non-zero.
 */
export async function ensureRouterNativeBalance(
  signer: ethers.Wallet,
  openRouterAddress: string,
): Promise<void> {
  const openRouter = ethers.getAddress(openRouterAddress);
  const bal = await signer.provider!.getBalance(openRouter);
  if (bal > 0n) {
    return;
  }

  console.log(
    `  [state-prep] open router ${openRouter} native balance=0 — signer sending ${SEED_WEI} wei to open router only`,
  );
  const tx = await signer.sendTransaction({ to: openRouter, value: SEED_WEI });
  await tx.wait();
}

/**
 * No-op: router→spender approvals are handled by the contract on `swap` /
 * `bridge` / `swapAndBridge`. Kept so existing e2e scripts do not need rewrites.
 *
 * @deprecated Pre-approval via a separate `performActions` tx is intentionally disabled.
 */
export async function ensureRouterApproval(
  _signer: ethers.Wallet,
  _openRouterAddress: string,
  _token: string,
  _spender: string,
): Promise<void> {
  // Intentionally empty — see module header.
}
