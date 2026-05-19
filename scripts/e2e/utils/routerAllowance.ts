/**
 * Router ERC-20 allowance helpers for e2e scripts.
 *
 * `OpenRouter` only calls `approve` when `approvalSpender != 0` and
 * `requiredAmount > allowance(router, spender)`. Scripts mirror that: check on-chain
 * allowance first, omit modular approve actions when sufficient, and pass
 * `ZERO_ADDRESS` as `approvalSpender` on `swap` / `bridge` / `swapAndBridge` when not needed.
 */
import { ethers } from 'ethers';

import { NATIVE_TOKEN_ADDRESS } from '../config';
import { ZERO_ADDRESS } from './contractTypes';
import { encodeApprove, getErc20Contract } from './erc20';

export interface ModularActionsExec {
  call(target: string, data: string): unknown;
}

/**
 * Reads `token.allowance(router, spender)`.
 */
export async function readRouterAllowance(
  provider: ethers.Provider,
  routerAddress: string,
  tokenAddress: string,
  spenderAddress: string,
): Promise<bigint> {
  const router = ethers.getAddress(routerAddress);
  const token = ethers.getAddress(tokenAddress);
  const spender = ethers.getAddress(spenderAddress);
  const erc20 = getErc20Contract(token, provider);
  const allowanceRaw = await erc20.allowance(router, spender);
  return typeof allowanceRaw === 'bigint' ? allowanceRaw : BigInt(allowanceRaw.toString());
}

/**
 * Matches contract logic: approval is skipped when `allowance >= requiredAmount`.
 */
export function routerAllowanceSufficient(allowance: bigint, requiredAmount: bigint): boolean {
  return allowance >= requiredAmount;
}

function isNativeToken(tokenAddress: string): boolean {
  return ethers.getAddress(tokenAddress) === ethers.getAddress(NATIVE_TOKEN_ADDRESS);
}

function isZeroSpender(spenderAddress: string): boolean {
  return ethers.getAddress(spenderAddress) === ethers.getAddress(ZERO_ADDRESS);
}

/**
 * Returns `spender` for `SwapData` / `BridgeData` when the router must approve, else `ZERO_ADDRESS`.
 */
export async function resolveApprovalSpender(
  provider: ethers.Provider,
  routerAddress: string,
  tokenAddress: string,
  spenderAddress: string,
  requiredAmount: bigint,
): Promise<string> {
  if (isNativeToken(tokenAddress) || isZeroSpender(spenderAddress)) {
    return ZERO_ADDRESS;
  }

  const allowance = await readRouterAllowance(provider, routerAddress, tokenAddress, spenderAddress);
  if (routerAllowanceSufficient(allowance, requiredAmount)) {
    console.log(
      `  [allowance] sufficient: token=${tokenAddress} spender=${spenderAddress} allowance=${allowance} required=${requiredAmount} → approvalSpender=0`,
    );
    return ZERO_ADDRESS;
  }

  console.log(
    `  [allowance] insufficient: token=${tokenAddress} spender=${spenderAddress} allowance=${allowance} required=${requiredAmount} → approvalSpender set`,
  );
  return ethers.getAddress(spenderAddress);
}

/**
 * Appends a modular `approve` action only when router allowance is below `requiredAmount`.
 *
 * @returns true when an approve action was added.
 */
export async function modularApproveIfNeeded(
  exec: ModularActionsExec,
  provider: ethers.Provider,
  routerAddress: string,
  tokenAddress: string,
  spenderAddress: string,
  requiredAmount: bigint,
  approveAmount: bigint = ethers.MaxUint256,
): Promise<boolean> {
  if (isNativeToken(tokenAddress) || isZeroSpender(spenderAddress)) {
    return false;
  }

  const allowance = await readRouterAllowance(provider, routerAddress, tokenAddress, spenderAddress);
  if (routerAllowanceSufficient(allowance, requiredAmount)) {
    console.log(
      `  [allowance] skipping modular approve: token=${tokenAddress} spender=${spenderAddress} allowance=${allowance} required=${requiredAmount}`,
    );
    return false;
  }

  console.log(
    `  [allowance] modular approve: token=${tokenAddress} spender=${spenderAddress} amount=${approveAmount}`,
  );
  exec.call(tokenAddress, encodeApprove(spenderAddress, approveAmount));
  return true;
}
