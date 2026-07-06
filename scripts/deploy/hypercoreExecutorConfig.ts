/**
 * HyperEVM-chain config for HypercoreDepositExecutor deployment.
 */
import { CHAIN_IDS } from '../e2e/config';

export type HypercoreExecutorChainConfig = {
  chainId: number;
  coreDepositWallet: string;
  depositToken: string;
};

export const HYPERCORE_EXECUTOR_CHAIN_CONFIG: Record<
  number,
  HypercoreExecutorChainConfig
> = {
  [CHAIN_IDS.HYPEREVM]: {
    chainId: CHAIN_IDS.HYPEREVM,
    coreDepositWallet: '0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24',
    depositToken: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  },
};
