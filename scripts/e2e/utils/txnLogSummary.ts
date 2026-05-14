import type { TransactionReceipt } from 'ethers';

import { BLOCK_EXPLORER_TX_PREFIX } from '../config';

export function explorerTxUrl(chainId: number, txHash: string): string {
  const prefix = BLOCK_EXPLORER_TX_PREFIX[chainId];

  if (!prefix) {
    return txHash;
  }

  return `${prefix}${txHash}`;
}

export function logTxnSummary(
  headline: string,
  chainId: number,
  receipt: TransactionReceipt,
): void {
  console.log('');
  console.log(headline);
  console.log(explorerTxUrl(chainId, receipt.hash));
  console.log(`Gas: ${receipt.gasUsed.toLocaleString('en-US')}`);
}
