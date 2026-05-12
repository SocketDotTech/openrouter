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
import { ethers, Signer } from 'ethers';
import { ALLOWANCE_HOLDER } from '../config';

/**
 * Minimal ABI fragment for AllowanceHolder — only the exec function we call.
 * Full ABI reference: https://docs.0x.org/docs/core-concepts/contracts#allowanceholder-recommended
 */
export const ALLOWANCE_HOLDER_ABI = [
  'function exec(address operator, address token, uint160 amount, address target, bytes calldata data) external payable returns (bytes memory result)',
] as const;

/**
 * Returns an ethers Contract instance for AllowanceHolder connected to the
 * given signer.
 */
export function getAllowanceHolderContract(signer: Signer): ethers.Contract {
  return new ethers.Contract(ALLOWANCE_HOLDER, ALLOWANCE_HOLDER_ABI, signer);
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
