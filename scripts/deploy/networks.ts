import { CHAIN_IDS } from '../e2e/config';

export type ReceiverDeployNetwork = {
  name: string;
  chainId: number;
  rpcEnvKey: string;
  rpcFallback: string;
};

/**
 * Hardhat network names for deployed and deployable OpenRouter chains
 * (Tempo excluded). RPC env keys and fallbacks mirror hardhat.config.ts.
 */
export const RECEIVER_DEPLOY_NETWORKS: readonly ReceiverDeployNetwork[] = [
  { name: 'ethereum', chainId: CHAIN_IDS.ETHEREUM, rpcEnvKey: 'ETHEREUM_RPC', rpcFallback: 'https://eth.llamarpc.com' },
  { name: 'polygon', chainId: CHAIN_IDS.POLYGON, rpcEnvKey: 'POLYGON_RPC', rpcFallback: 'https://polygon.llamarpc.com' },
  { name: 'base', chainId: CHAIN_IDS.BASE, rpcEnvKey: 'BASE_RPC', rpcFallback: 'https://mainnet.base.org' },
  { name: 'optimism', chainId: CHAIN_IDS.OPTIMISM, rpcEnvKey: 'OPTIMISM_RPC', rpcFallback: 'https://mainnet.optimism.io' },
  { name: 'arbitrum', chainId: CHAIN_IDS.ARBITRUM, rpcEnvKey: 'ARBITRUM_RPC', rpcFallback: 'https://rpc.ankr.com/arbitrum' },
  { name: 'bsc', chainId: CHAIN_IDS.BNB, rpcEnvKey: 'BSC_RPC', rpcFallback: 'https://bsc-dataseed.binance.org/' },
  { name: 'worldchain', chainId: CHAIN_IDS.WORLDCHAIN, rpcEnvKey: 'WORLDCHAIN_RPC', rpcFallback: 'https://worldchain-mainnet.g.alchemy.com/public' },
  { name: 'sonic', chainId: CHAIN_IDS.SONIC, rpcEnvKey: 'SONIC_RPC', rpcFallback: 'https://rpc.ankr.com/sonic_mainnet' },
  { name: 'ink', chainId: CHAIN_IDS.INK, rpcEnvKey: 'INK_RPC', rpcFallback: 'https://rpc-gel.inkonchain.com' },
  { name: 'avalanche', chainId: CHAIN_IDS.AVALANCHE, rpcEnvKey: 'AVALANCHE_RPC', rpcFallback: 'https://rpc.ankr.com/avalanche' },
  { name: 'unichain', chainId: CHAIN_IDS.UNICHAIN, rpcEnvKey: 'UNICHAIN_RPC', rpcFallback: 'https://unichain-rpc.publicnode.com' },
  { name: 'berachain', chainId: CHAIN_IDS.BERACHAIN, rpcEnvKey: 'BERACHAIN_RPC', rpcFallback: 'https://berachain-rpc.publicnode.com' },
  { name: 'scroll', chainId: CHAIN_IDS.SCROLL, rpcEnvKey: 'SCROLL_RPC', rpcFallback: 'https://1rpc.io/scroll' },
  { name: 'hyperEvm', chainId: CHAIN_IDS.HYPEREVM, rpcEnvKey: 'HYPEREVM_RPC', rpcFallback: 'https://rpc.hyperliquid.xyz/evm' },
  { name: 'arc', chainId: CHAIN_IDS.ARC, rpcEnvKey: 'ARC_RPC', rpcFallback: '' },
  { name: 'plasma', chainId: CHAIN_IDS.PLASMA, rpcEnvKey: 'PLASMA_RPC', rpcFallback: 'https://rpc.plasma.to' },
  { name: 'monad', chainId: CHAIN_IDS.MONAD, rpcEnvKey: 'MONAD_RPC', rpcFallback: 'https://rpc.monad.xyz' },
  { name: 'linea', chainId: CHAIN_IDS.LINEA, rpcEnvKey: 'LINEA_RPC', rpcFallback: 'https://rpc.linea.build' },
  { name: 'mantle', chainId: CHAIN_IDS.MANTLE, rpcEnvKey: 'MANTLE_RPC', rpcFallback: 'https://rpc.mantle.xyz' },
  { name: 'gnosis', chainId: CHAIN_IDS.GNOSIS, rpcEnvKey: 'GNOSIS_RPC', rpcFallback: 'https://rpc.ankr.com/gnosis' },
  { name: 'katana', chainId: CHAIN_IDS.KATANA, rpcEnvKey: 'KATANA_RPC', rpcFallback: 'https://rpc.katana.network' },
  { name: 'mode', chainId: CHAIN_IDS.MODE, rpcEnvKey: 'MODE_RPC', rpcFallback: 'https://1rpc.io/mode' },
  { name: 'megaeth', chainId: CHAIN_IDS.MEGAETH, rpcEnvKey: 'MEGAETH_RPC', rpcFallback: 'https://rpc.megaeth.xyz' },
  { name: 'robinhood', chainId: CHAIN_IDS.ROBINHOOD, rpcEnvKey: 'ROBINHOOD_RPC', rpcFallback: '' },
  { name: 'plume', chainId: CHAIN_IDS.PLUME, rpcEnvKey: 'PLUME_RPC', rpcFallback: 'https://rpc.plume.org' },
  { name: 'blast', chainId: CHAIN_IDS.BLAST, rpcEnvKey: 'BLAST_RPC', rpcFallback: 'https://blastl2-mainnet.public.blastapi.io' },
  { name: 'soneium', chainId: CHAIN_IDS.SONEIUM, rpcEnvKey: 'SONEIUM_RPC', rpcFallback: 'https://soneium.drpc.org' },
  { name: 'sei', chainId: CHAIN_IDS.SEI, rpcEnvKey: 'SEI_RPC', rpcFallback: 'https://evm-rpc.sei-apis.com' },
  { name: 'citrea', chainId: CHAIN_IDS.CITREA, rpcEnvKey: 'CITREA_RPC', rpcFallback: 'https://rpc.mainnet.citrea.xyz' },
] as const;

/** bungee-backend uses `*_RPC_URL` naming; poc-openrouter uses `*_RPC`. */
const RPC_ENV_ALIASES: Partial<Record<string, readonly string[]>> = {
  ETHEREUM_RPC: ['ETHEREUM_RPC_URL'],
  OPTIMISM_RPC: ['OPTIMISM_RPC_URL'],
  BSC_RPC: ['BNB_RPC_URL'],
  GNOSIS_RPC: ['GNOSIS_RPC_URL'],
  POLYGON_RPC: ['POLYGON_RPC_URL'],
  ARBITRUM_RPC: ['ARBITRUM_RPC_URL', 'ARBITRUM_ONE_RPC_URL'],
  AVALANCHE_RPC: ['AVALANCHE_RPC_URL'],
  BASE_RPC: ['BASE_RPC_URL'],
  LINEA_RPC: ['LINEA_RPC_URL'],
  MANTLE_RPC: ['MANTLE_RPC_URL'],
  SCROLL_RPC: ['SCROLL_RPC_URL', 'SCROLL_RPC'],
  BLAST_RPC: ['BLAST_RPC_URL', 'BLAST_RPC'],
  INK_RPC: ['INK_RPC_URL'],
  UNICHAIN_RPC: ['UNICHAIN_RPC_URL'],
  SONIC_RPC: ['SONIC_RPC_URL'],
  BERACHAIN_RPC: ['BERACHAIN_RPC_URL'],
  SONEIUM_RPC: ['SONEIUM_RPC_URL'],
  MODE_RPC: ['MODE_RPC_URL'],
  WORLDCHAIN_RPC: ['WORLDCHAIN_RPC_URL'],
  PLUME_RPC: ['PLUME_RPC_URL'],
  KATANA_RPC: ['KATANA_RPC_URL'],
  SEI_RPC: ['SEI_RPC_URL'],
  HYPEREVM_RPC: ['HYPEREVM_RPC_URL'],
  ARC_RPC: ['ARC_RPC_URL'],
  PLASMA_RPC: ['PLASMA_RPC_URL'],
  MONAD_RPC: ['MONAD_RPC_URL'],
  MEGAETH_RPC: ['MEGAETH_RPC_URL'],
  ROBINHOOD_RPC: ['ROBINHOOD_RPC_URL'],
  CITREA_RPC: ['CITREA_RPC_URL'],
};

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function resolveRpcUrl(network: ReceiverDeployNetwork): string {
  const envKeys = [
    network.rpcEnvKey,
    ...(RPC_ENV_ALIASES[network.rpcEnvKey] ?? []),
  ];

  for (const envKey of envKeys) {
    const raw = process.env[envKey]?.trim();
    if (raw) {
      return stripEnvQuotes(raw);
    }
  }

  return network.rpcFallback;
}
