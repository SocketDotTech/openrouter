/**
 * ERC-20 calldata encoding helpers used when building modular Action arrays.
 * These produce raw encoded bytes rather than making any actual calls, so they
 * work for both building action.data fields and for direct contract calls.
 */
import { ethers } from 'ethers';

const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address recipient, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]);

/**
 * Encodes ERC-20 approve(spender, amount) calldata.
 */
export function encodeApprove(spender: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Encodes ERC-20 transfer(recipient, amount) calldata.
 */
export function encodeTransfer(recipient: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData('transfer', [recipient, amount]);
}

/**
 * Encodes ERC-20 balanceOf(account) calldata for use in a STATICCALL action.
 * The return value is a 32-byte ABI-encoded uint256 — can be spliced directly
 * into a subsequent action's calldata.
 */
export function encodeBalanceOf(account: string): string {
  return ERC20_IFACE.encodeFunctionData('balanceOf', [account]);
}

/**
 * Returns an ethers Contract instance for a standard ERC-20 token (read-only).
 * Pass a provider or signer as the second argument.
 */
export function getErc20Contract(tokenAddress: string, providerOrSigner: ethers.Provider | ethers.Signer): ethers.Contract {
  return new ethers.Contract(
    tokenAddress,
    [
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function allowance(address owner, address spender) external view returns (uint256)',
      'function balanceOf(address account) external view returns (uint256)',
      'function decimals() external view returns (uint8)',
    ],
    providerOrSigner,
  );
}

/**
 * Reads an ERC-20 balance and decimals for `owner`, similar to bungee-sandbox
 * `getTokenBalance` patterns (fund the signer, then swap/bridge whole balance).
 */
export async function getWalletErc20Balance(
  tokenAddress: string,
  owner: string,
  provider: ethers.Provider,
): Promise<{ balance: bigint; decimals: number }> {
  const token = getErc20Contract(tokenAddress, provider);
  const [balanceRaw, decimalsRaw] = await Promise.all([
    token.balanceOf(owner),
    token.decimals(),
  ]);
  const balance = typeof balanceRaw === 'bigint' ? balanceRaw : BigInt(balanceRaw.toString());

  return { balance, decimals: Number(decimalsRaw) };
}

/**
 * Convenience: approve a spender with a real provider transaction.
 */
export async function approveErc20(
  tokenAddress: string,
  spender: string,
  amount: bigint,
  signer: ethers.Signer,
): Promise<void> {
  const token = getErc20Contract(tokenAddress, signer);
  const tx = await token.approve(spender, amount);
  await tx.wait();
  console.log(`Approved ${spender} for ${amount} of ${tokenAddress}`);
}
