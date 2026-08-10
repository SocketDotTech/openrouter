/**
 * Ethereal-chain config for EtherealExecutor deployment.
 * Ethereal is a single-chain (appchain) deployment target — USDe is its native gas token,
 * so `depositToken` uses the native sentinel address.
 */
import { CHAIN_IDS } from '../e2e/config';

/// @dev native sentinel — matches CurrencyLib.NATIVE_TOKEN_ADDRESS in src/common/lib/CurrencyLib.sol
export const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export type EtherealExecutorChainConfig = {
  chainId: number;
  exchangeGateway: string;
  depositToken: string;
};

export const ETHEREAL_EXECUTOR_CHAIN_CONFIG: Record<number, EtherealExecutorChainConfig> = {
  [CHAIN_IDS.ETHEREAL]: {
    chainId: CHAIN_IDS.ETHEREAL,
    exchangeGateway: '0xB3cDC82035C495c484C9fF11eD5f3Ff6d342e3cc',
    depositToken: NATIVE_TOKEN_ADDRESS,
  },
};
