/**
 * State-prep helpers for reproducible on-chain gas-cost tests.
 *
 * Callers must pass the deployed open-router address from config (`routerAddressForChain`, etc.),
 * never Relay `depositTarget`, CCTP `tokenMessenger`, or other external calldata targets.
 *
 * Before each test leg these ensure:
 *   1. The router holds ≥ 20 wei of every token whose balance slot will be written.
 *   2. The router has a non-zero ERC-20 allowance for every external spender it will call.
 *
 * Seeding slots to non-zero means subsequent SSTORE writes cost ~2 900 gas
 * (non-zero → non-zero) rather than ~20 000 gas (zero → non-zero), giving
 * consistent gas readings across repeated runs.
 */
import { ethers } from 'ethers';
import { getErc20Contract, encodeApprove } from './erc20';
import { execViaAH } from './allowanceHolder';
import { ROUTER_ABI } from './routerAbi';
import { ZERO_BYTES32 } from './contractTypes';

const SEED_WEI = 20n;

function packCallAction(target: string): bigint {
  return BigInt(target) << 16n; // CallType.CALL=0, storeResult=false
}

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
 * Issues `token.approve(spender, MaxUint256)` FROM the router (via
 * `performModularExecution`) when the current router→spender allowance is zero.
 *
 * Guarantees the allowance slot is non-zero before the test txn so that the
 * approval write inside the test costs ~2 900 gas (non-zero → non-zero).
 */
export async function ensureRouterApproval(
  signer: ethers.Wallet,
  openRouterAddress: string,
  token: string,
  spender: string,
): Promise<void> {
  const openRouter = ethers.getAddress(openRouterAddress);
  const tokenResolved = ethers.getAddress(token);
  const spenderResolved = ethers.getAddress(spender);
  const tokenRo = getErc20Contract(tokenResolved, signer.provider!);
  const allowance = BigInt(await tokenRo.allowance(openRouter, spenderResolved));
  if (allowance > 0n) {
    return;
  }

  console.log(
    `  [state-prep] open router ${openRouter} token ${tokenResolved} allowance for ${spenderResolved}=0 — pre-approving MaxUint256 via open router`,
  );
  const routerIface = new ethers.Interface(ROUTER_ABI);
  const actions = [
    {
      actionInfo: packCallAction(tokenResolved),
      data: encodeApprove(spenderResolved, ethers.MaxUint256),
      splices: [],
    },
  ];
  const calldata = routerIface.encodeFunctionData('performModularExecution', [
    ZERO_BYTES32,
    actions,
  ]);
  // Route through AllowanceHolder so _msgSender() resolves correctly inside the router.
  // amount=0 because we are not pulling user tokens — we only need AH to forward the call.
  await execViaAH(signer, openRouter, tokenResolved, 0n, openRouter, calldata);
}
