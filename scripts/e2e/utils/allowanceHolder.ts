/**
 * AllowanceHolder helpers.
 *
 * The AH.exec() flow in a single transaction:
 *   1. User calls AllowanceHolder.exec(operator, token, amount, target, data, { value })
 *   2. AH grants transient allowance: operator may pull `amount` of `token` from msg.sender
 *   3. AH calls target(data) forwarding msg.value
 *   4. Inside target: AllowanceHolder.transferFrom(token, msg.sender_original, recipient, amount)
 *      pulls the tokens using the transient allowance (cleared after the call)
 *
 * The router's _pullFromUser uses the same AH.transferFrom to move tokens in.
 */
import { ethers, MaxUint256, Signer } from 'ethers';
import { ALLOWANCE_HOLDER } from '../config';
import { getErc20Contract } from './erc20';

/**
 * Minimal ABI fragment for AllowanceHolder — only the exec function we call.
 *
 * IMPORTANT: the amount parameter MUST be uint256 (not uint160). AllowanceHolder
 * is entirely implemented in its fallback() function, which dispatches by comparing
 * the incoming 4-byte selector against IAllowanceHolder.exec.selector. That selector
 * is keccak256("exec(address,address,uint256,address,bytes)")[0:4] = 0x2213bc0b.
 * Using uint160 would produce a different selector and the call would revert.
 *
 * Full ABI reference: https://docs.0x.org/docs/core-concepts/contracts#allowanceholder-recommended
 */
export const ALLOWANCE_HOLDER_ABI = [
  'function exec(address operator, address token, uint256 amount, address target, bytes calldata data) external payable returns (bytes memory result)',
] as const;

/**
 * Returns an ethers Contract instance for AllowanceHolder connected to the
 * given signer.
 */
export function getAllowanceHolderContract(signer: Signer): ethers.Contract {
  return new ethers.Contract(ALLOWANCE_HOLDER, ALLOWANCE_HOLDER_ABI, signer);
}

/**
 * Reads `token.allowance(owner, AllowanceHolder)` and, if it is below
 * `requiredAmount`, submits `approve(AllowanceHolder, MaxUint256)`.
 *
 * AH.exec pulls FROM the user's wallet via ephemeral allowance keyed by operator;
 * the user must have a persistent ERC20 approval to AH first.
 */
export async function ensureAllowanceForAllowanceHolder(
  signer: Signer,
  token: string,
  requiredAmount: bigint,
): Promise<void> {
  const owner = await signer.getAddress();
  const erc20 = getErc20Contract(token, signer);
  const allowanceRaw = await erc20.allowance(owner, ALLOWANCE_HOLDER);
  const allowance =
    typeof allowanceRaw === 'bigint' ? allowanceRaw : BigInt(allowanceRaw.toString());

  if (allowance >= requiredAmount) {
    console.log(
      `AllowanceHolder allowance OK (${allowance.toString()} >= ${requiredAmount.toString()})`,
    );
    return;
  }

  console.log(
    `Approving AllowanceHolder: allowance ${allowance.toString()} < required ${requiredAmount.toString()}, sending approve...`,
  );
  const tx = await erc20.approve(ALLOWANCE_HOLDER, MaxUint256);
  console.log(`approve tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`ERC20 approve to AllowanceHolder failed: ${tx.hash}`);
  }
  console.log('AllowanceHolder approval confirmed');
}

/**
 * Builds and sends an AllowanceHolder.exec() transaction.
 *
 * @param signer       - The EOA signing and paying for the tx (= the "user")
 * @param operator     - The contract that will pull funds (our router)
 * @param token        - ERC-20 token to grant ephemeral allowance for
 * @param amount       - Exact amount the operator is allowed to pull
 * @param target       - Contract to call after granting the allowance (our router)
 * @param callData     - Encoded function call on `target`
 * @param txValue      - Optional ETH to forward with the call (for native-token flows)
 */
export async function execViaAH(
  signer: Signer,
  operator: string,
  token: string,
  amount: bigint,
  target: string,
  callData: string,
  txValue?: bigint,
): Promise<ethers.TransactionReceipt> {
  const ah = getAllowanceHolderContract(signer);

  const tx = await ah.exec(operator, token, amount, target, callData, {
    value: txValue ?? 0n,
  });

  console.log(`AllowanceHolder.exec tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction failed: ${tx.hash}`);
  }
  console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
  return receipt;
}
