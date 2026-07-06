/**
 * Shared configuration: addresses, chain IDs, token info, and CCTP config
 * used across all e2e scripts.
 */
import * as dotenv from 'dotenv';
dotenv.config();

// ─── Chain IDs ───────────────────────────────────────────────────────────────

export const CHAIN_IDS = {
  ETHEREUM: 1,
  OPTIMISM: 10,
  BNB: 56,
  GNOSIS: 100,
  /** Polygon PoS mainnet — used by e2e scripts as the source chain. */
  POLYGON: 137,
  UNICHAIN: 130,
  SONIC: 146,
  /** Monad mainnet. */
  MONAD: 143,
  WORLDCHAIN: 480,
  MANTLE: 5000,
  BASE: 8453,
  /** HyperEVM (Hyperliquid). */
  HYPEREVM: 999,
  /** Arc mainnet. */
  ARC: 5042,
  /** Tempo mainnet — AllowanceHolder only; OpenRouter not deployed (deposit-only chain). */
  TEMPO: 4217,
  /** MegaETH mainnet — Relay USDM → Base USDC e2e. */
  MEGAETH: 4326,
  ARBITRUM: 42161,
  LINEA: 59144,
  INK: 57073,
  AVALANCHE: 43114,
  SCROLL: 534352,
  MODE: 34443,
  /** Soneium mainnet — Relay bridged USDC → Base USDC e2e. */
  SONEIUM: 1868,
  PLASMA: 9745,
  /** Blast mainnet — Relay USDe → Base USDC e2e. */
  BLAST: 81457,
  BERACHAIN: 80094,
  SEI: 1329,
  /** Plume mainnet — Relay WPLUME → Base USDC e2e. */
  PLUME: 98866,
  KATANA: 747474,
  /** Ethereal mainnet — deposit-only destination chain for EtherealExecutor. */
  ETHEREAL: 5064014,
} as const;

/** Base URL for explorer transaction pages: `${prefix}${txHash}`. */
export const BLOCK_EXPLORER_TX_PREFIX: Record<number, string> = {
  [CHAIN_IDS.ETHEREUM]: 'https://etherscan.io/tx/',
  [CHAIN_IDS.OPTIMISM]: 'https://optimistic.etherscan.io/tx/',
  [CHAIN_IDS.BNB]: 'https://bscscan.com/tx/',
  [CHAIN_IDS.GNOSIS]: 'https://gnosisscan.io/tx/',
  [CHAIN_IDS.POLYGON]: 'https://polygonscan.com/tx/',
  [CHAIN_IDS.UNICHAIN]: 'https://uniscan.xyz/tx/',
  [CHAIN_IDS.SONIC]: 'https://sonicscan.org/tx/',
  [CHAIN_IDS.MONAD]: 'https://monadscan.com/tx/',
  [CHAIN_IDS.WORLDCHAIN]: 'https://worldscan.org/tx/',
  [CHAIN_IDS.MANTLE]: 'https://mantlescan.xyz/tx/',
  [CHAIN_IDS.BASE]: 'https://basescan.org/tx/',
  [CHAIN_IDS.HYPEREVM]: 'https://hyperevmscan.io/tx/',
  [CHAIN_IDS.TEMPO]: 'https://explore.mainnet.tempo.xyz/tx/',
  [CHAIN_IDS.MEGAETH]: 'https://mega.etherscan.io/tx/',
  [CHAIN_IDS.ARBITRUM]: 'https://arbiscan.io/tx/',
  [CHAIN_IDS.LINEA]: 'https://lineascan.build/tx/',
  [CHAIN_IDS.INK]: 'https://explorer.inkonchain.com/tx/',
  [CHAIN_IDS.AVALANCHE]: 'https://snowscan.xyz/tx/',
  [CHAIN_IDS.SCROLL]: 'https://scrollscan.com/tx/',
  [CHAIN_IDS.MODE]: 'https://explorer.mode.network/tx/',
  [CHAIN_IDS.SONEIUM]: 'https://soneium.blockscout.com/tx/',
  [CHAIN_IDS.PLASMA]: 'https://plasmascan.to/tx/',
  [CHAIN_IDS.BLAST]: 'https://blastscan.io/tx/',
  [CHAIN_IDS.BERACHAIN]: 'https://berascan.com/tx/',
  [CHAIN_IDS.SEI]: 'https://seitrace.com/tx/',
  [CHAIN_IDS.PLUME]: 'https://explorer.plume.org/tx/',
  [CHAIN_IDS.KATANA]: 'https://explorer.katanarpc.com/tx/',
};

// ─── Contract addresses ───────────────────────────────────────────────────────

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;

export type AllowanceHolderVariant = 'cancun' | 'shanghai';

/** Socket CREATE3 AllowanceHolder — same address on every deployed chain. */
export const ALLOWANCE_HOLDER = '0x50c4E75a512F2A14A7b304787Adf79C4531A5909';

const ALLOWANCE_HOLDER_BY_CHAIN_ID: Record<number, string> = {
};

const ALLOWANCE_HOLDER_VARIANT_BY_CHAIN_ID: Record<
  number,
  AllowanceHolderVariant
> = {
};

/**
 * Resolve AllowanceHolder contract address for `chainId`.
 *
 * Priority: `ALLOWANCE_HOLDER_CHAIN_<chainId>` env → `ALLOWANCE_HOLDER_ADDRESS`
 * env → chain-specific map → {@link ALLOWANCE_HOLDER}.
 */
export function allowanceHolderForChain(chainId: number): string {
  const envSpecific = process.env[`ALLOWANCE_HOLDER_CHAIN_${chainId}`]?.trim();
  if (envSpecific && ADDR_HEX_RE.test(envSpecific)) {
    return envSpecific;
  }

  const envGlobal = process.env.ALLOWANCE_HOLDER_ADDRESS?.trim();
  if (envGlobal && ADDR_HEX_RE.test(envGlobal)) {
    return envGlobal;
  }

  return ALLOWANCE_HOLDER_BY_CHAIN_ID[chainId] ?? ALLOWANCE_HOLDER;
}

export function allowanceHolderVariantForChain(
  chainId: number,
): AllowanceHolderVariant {
  const envSpecific =
    process.env[`ALLOWANCE_HOLDER_VARIANT_CHAIN_${chainId}`]?.trim();
  if (envSpecific === 'cancun' || envSpecific === 'shanghai') {
    return envSpecific;
  }

  const envGlobal = process.env.ALLOWANCE_HOLDER_VARIANT?.trim();
  if (envGlobal === 'cancun' || envGlobal === 'shanghai') {
    return envGlobal;
  }

  return ALLOWANCE_HOLDER_VARIANT_BY_CHAIN_ID[chainId] ?? 'cancun';
}

/** CREATE3 OpenRouter address — same on every deployed chain. Keep in sync with bungee-backend. */
export const OPEN_ROUTER_ADDRESS = '0x50cFe7c1938dB66A1a6D2e86D36F39FBef3d5c4a';

/** Chains with a deployed OpenRouter (direct DEX / bridge quotes). Tempo excluded (deposit-only). */
export const OPEN_ROUTER_CHAIN_IDS: readonly number[] = [
  CHAIN_IDS.ETHEREUM,
  CHAIN_IDS.POLYGON,
  CHAIN_IDS.BASE,
  CHAIN_IDS.OPTIMISM,
  CHAIN_IDS.ARBITRUM,
  CHAIN_IDS.BNB,
  CHAIN_IDS.WORLDCHAIN,
  CHAIN_IDS.SONIC,
  CHAIN_IDS.INK,
  CHAIN_IDS.AVALANCHE,
  CHAIN_IDS.UNICHAIN,
  CHAIN_IDS.BERACHAIN,
  CHAIN_IDS.SCROLL,
  CHAIN_IDS.HYPEREVM,
  CHAIN_IDS.ARC,
  CHAIN_IDS.PLASMA,
  CHAIN_IDS.MONAD,
  CHAIN_IDS.LINEA,
  CHAIN_IDS.MANTLE,
  CHAIN_IDS.GNOSIS,
  CHAIN_IDS.KATANA,
  CHAIN_IDS.MODE,
  CHAIN_IDS.MEGAETH,
  CHAIN_IDS.PLUME,
  CHAIN_IDS.BLAST,
  CHAIN_IDS.SONEIUM,
  CHAIN_IDS.SEI,
];

/**
 * Deployed OpenRouter — one CREATE3 address per chain used by e2e scripts.
 * Override per chain with env `ROUTER_CHAIN_<chainId>` (e.g. ROUTER_CHAIN_1 for Ethereum).
 * Chains without an entry fall back to legacy `ROUTER_ADDRESS` when set.
 */
export const ROUTER_BY_CHAIN_ID: Record<number, string> = Object.fromEntries(
  OPEN_ROUTER_CHAIN_IDS.map((chainId) => [chainId, OPEN_ROUTER_ADDRESS]),
);

/**
 * Resolve router contract address for execution quotes / AH.exec on `chainId`.
 *
 * Priority: `ROUTER_CHAIN_<chainId>` env → {@link ROUTER_BY_CHAIN_ID} → `ROUTER_ADDRESS` env.
 */
export function routerAddressForChain(chainId: number): string {
  const envSpecific = process.env[`ROUTER_CHAIN_${chainId}`]?.trim();
  if (envSpecific && ADDR_HEX_RE.test(envSpecific)) {
    return envSpecific;
  }
  const mapped = ROUTER_BY_CHAIN_ID[chainId];
  if (mapped) {
    return mapped;
  }
  const legacy = process.env.ROUTER_ADDRESS?.trim();
  if (legacy && ADDR_HEX_RE.test(legacy)) {
    return legacy;
  }
  throw new Error(
    `routerAddressForChain(${chainId}): no ROUTER_BY_CHAIN_ID entry and neither ROUTER_CHAIN_${chainId} nor ROUTER_ADDRESS is set.`,
  );
}

/** Standard ERC-20 "native" sentinel used by CurrencyLib */
export const NATIVE_TOKEN_ADDRESS =
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ─── Token addresses ──────────────────────────────────────────────────────────

export const TOKENS = {
  AAVE_ARB: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
  AAVE_ETH: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  /** Polygon PoS AAVE (aPolAAVE ERC-4626-backed). */
  AAVE_POLYGON: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
  USDC_ARB: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  USDC_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_ETH: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  /** Bridged PoS-USDC on Polygon (6 decimals); not burnable via Circle CCTP. */
  USDC_POLYGON: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  /** Circle native USDC on Polygon — required for CCTP `depositForBurn` on PoS. */
  USDC_POLYGON_CIRCLE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  /** Canonical wrapped gas token on Polygon PoS (18 decimals). */
  WMATIC_POLYGON: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  AAVE_BASE: '0x63706e401c06ac8513145b7687a14804d17f814b',
  /** Ethena ENA on Mantle (18 decimals). */
  ENA_MANTLE: '0x58538e6a46e07434d7e7375bc268d3cb839c0133',
  /** Circle-bridged USDC on Mantle (6 decimals). */
  USDC_MANTLE: '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9',
  /**
   * USDT0 on Polygon PoS — the inner ERC-20 token that the OFT Adapter wraps (6 decimals).
   * Users approve the OFT Adapter to pull this token, then call Adapter.send().
   */
  USDT0_POLYGON: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  /**
   * USDT0 on Base — a native OFT (the token contract itself IS the OFT; no separate adapter).
   * Bridged in via LayerZero from Polygon via the USDT0 OFT Adapter on Polygon.
   */
  USDT0_BASE: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  /**
   * Arbitrum USDT — inner token for the USDT0 OFT stack (6 decimals).
   * OFT adapter pulls this ERC-20, then calls LayerZero `send()` to Base USDT0.
   * Matches bungee `oftSupportedTokens` / {@link USDT0_OFT_ADAPTER_ARBITRUM}.
   */
  USDT0_ARB: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  /**
   * MegaUSD / USDM on MegaETH (18 decimals).
   * Relay: https://relay.link/bridge/base?fromChainId=4326&fromCurrency=0xfafddbb3...
   */
  USDM_MEGAETH: '0xfafddbb3fc7688494971a79cc65dca3ef82079e7',
  /**
   * Wrapped PLUME on Plume (18 decimals).
   * Relay: https://relay.link/bridge/base?fromChainId=98866&fromCurrency=0xea237441...
   */
  WPLUME_PLUME: '0xea237441c92cae6fc17caaf9a7acb3f953be4bd1',
  /**
   * Bridged USDC on Soneium (6 decimals).
   * Relay: https://relay.link/bridge/base?fromChainId=1868&fromCurrency=0xba9986d2...
   */
  USDC_SONEIUM: '0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369',
  /**
   * Ethena USDe on Blast (18 decimals).
   * Relay: https://relay.link/bridge/base?fromChainId=81457&fromCurrency=0x5d3a1ff2...
   */
  USDE_BLAST: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
} as const;

/**
 * USDT0 OFT Adapter on Polygon PoS (legacy / alternate route; Polygon→Base may hit LZ NoPeer).
 * Type: OFT_ADAPTER — requires ERC-20 approval of TOKENS.USDT0_POLYGON before calling send().
 */
export const USDT0_OFT_ADAPTER_POLYGON =
  '0x6ba10300f0dc58b7a1e4c0e41f5dabb7d7829e13';

/**
 * USDT0 OFT Adapter on Arbitrum — quote `send()` here; approve adapter to spend {@link TOKENS.USDT0_ARB}.
 * Seed doc: `oftId` `42161-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9`, `adapterAddress` on Arbitrum.
 */
export const USDT0_OFT_ADAPTER_ARBITRUM =
  '0x14e4a1b13Bf7F943c8fF7C51fb60fa964A298d92';

/**
 * LayerZero v2 endpoint ID for Polygon PoS (EID 30109).
 */
export const POLYGON_LZ_EID = 30109;

// ─── CCTP v2 configuration ────────────────────────────────────────────────────

export interface CctpChainConfig {
  tokenMessenger: string;
  /** Circle's domain identifier for CCTP */
  cctpDomain: number;
  usdcAddress: string;
}

export const CCTP_CONFIG: Record<number, CctpChainConfig> = {
  [CHAIN_IDS.POLYGON]: {
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    cctpDomain: 7,
    usdcAddress: TOKENS.USDC_POLYGON_CIRCLE,
  },
  [CHAIN_IDS.ARBITRUM]: {
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    cctpDomain: 3,
    usdcAddress: TOKENS.USDC_ARB,
  },
  [CHAIN_IDS.BASE]: {
    tokenMessenger: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
    cctpDomain: 6,
    usdcAddress: TOKENS.USDC_BASE,
  },
  [CHAIN_IDS.ETHEREUM]: {
    tokenMessenger: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
    cctpDomain: 0,
    usdcAddress: TOKENS.USDC_ETH,
  },
};

// ─── Arbitrum bridge ──────────────────────────────────────────────────────────

/** Arbitrum Delayed Inbox — accepts ETH deposits via depositEth() */
export const ARBITRUM_INBOX = '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f';

// ─── Stargate pools ───────────────────────────────────────────────────────────

/**
 * Stargate Native ETH OFT adapter on Arbitrum.
 * Call send() with msg.value = amountLD + nativeFee to bridge ETH to Base.
 * Ref: poc-openrouter/test/poc/OpenOceanStargateNativeSwapFeeBridgeRouterPoC.t.sol
 */
export const STARGATE_NATIVE_ARB = '0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F';

/**
 * Stargate v2 native ETH OFT pool on Base.
 * send() requires msg.value = amountLD + nativeFee; bridges ETH to Arbitrum/other chains.
 */
export const STARGATE_NATIVE_BASE =
  '0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7';

/**
 * Stargate v2 USDC pool on Arbitrum.
 * ERC20 pool — caller approves USDC to this address; msg.value = nativeFee only.
 * Source: https://stargateprotocol.gitbook.io/stargate/v2-developer-docs/technical-reference
 */
export const STARGATE_USDC_ARB = '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3';

/**
 * Stargate v2 USDC pool on Polygon PoS.
 * NOTE: Polygon has no StargatePoolNative for POL/MATIC — only USDC and USDT
 * pools are deployed. Bridge token is Circle USDC, not the chain native token.
 */
export const STARGATE_USDC_POLYGON =
  '0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4';

/**
 * Stargate v2 USDC pool on Mantle.
 * Source: bungee `STARGATE_CUSTOM_LIST` / Stargate v2 technical reference.
 */
export const STARGATE_USDC_MANTLE =
  '0xAc290Ad4e0c891FDc295ca4F0a6214cf6dC6acDC';

/** LayerZero v2 endpoint ID for Base (EID 30184). */
export const BASE_LZ_EID = 30184;

/** LayerZero v2 endpoint ID for Mantle (EID 30181). */
export const MANTLE_LZ_EID = 30181;

/** LayerZero v2 endpoint ID for Arbitrum (EID 30110). */
export const ARBITRUM_LZ_EID = 30110;

/**
 * Byte offset of sendParam.amountLD within the Stargate send() calldata (after the 4-byte selector).
 * Layout: selector(4) + head[sendParam_ptr(32) + nativeFee(32) + lzTokenFee(32) + refundAddr(32)] +
 *         tail[dstEid(32) + to(32)] + amountLD = 4+128+32+32 = 196
 */
export const STARGATE_AMOUNT_LD_OFFSET = 196;

// ─── Fee config ───────────────────────────────────────────────────────────────

/** Fee applied in scripts that take pre-/post-route fees (basis points). */
export const FEE_BPS = Number(process.env.FEE_AMOUNT_BPS ?? '10');

/**
 * OpenOcean slippage tolerance used when fetching swap quotes.
 * The value is passed directly to OO's `slippage` API parameter (percentage string, e.g. '3' = 3%).
 * OO embeds this as `minReturn` in the swap calldata — if the actual on-chain output falls below
 * `estimatedOut * (1 - slippage/100)`, OO reverts with "Return amount is not enough".
 * AAVE's multi-hop route (AAVE→WMATIC→DAI→USDC) can move 2–3% between quote and execution,
 * so 1% is too tight; 3% provides a safe margin while still protecting against severe slippage.
 * Override via env: OO_SLIPPAGE_PERCENT=5
 */
export const OO_SLIPPAGE_PERCENT = process.env.OO_SLIPPAGE_PERCENT ?? '3';

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10000n;
}

// ─── RPC endpoints ────────────────────────────────────────────────────────────

export const RPC = {
  ETHEREUM: process.env.ETHEREUM_RPC ?? 'https://eth.llamarpc.com',
  OPTIMISM: process.env.OPTIMISM_RPC ?? 'https://mainnet.optimism.io',
  BNB: process.env.BSC_RPC ?? 'https://bsc-dataseed.binance.org/',
  GNOSIS: process.env.GNOSIS_RPC ?? 'https://rpc.ankr.com/gnosis',
  POLYGON: process.env.POLYGON_RPC ?? 'https://polygon-bor.publicnode.com',
  UNICHAIN: process.env.UNICHAIN_RPC ?? 'https://0xrpc.io/uni',
  SONIC: process.env.SONIC_RPC ?? 'https://rpc.ankr.com/sonic_mainnet',
  MONAD: process.env.MONAD_RPC ?? 'https://rpc.monad.xyz',
  WORLDCHAIN: process.env.WORLDCHAIN_RPC ?? 'https://worldchain-mainnet.g.alchemy.com/public',
  MANTLE: process.env.MANTLE_RPC ?? 'https://rpc.mantle.xyz',
  BASE: process.env.BASE_RPC ?? 'https://mainnet.base.org',
  HYPEREVM: process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm',
  TEMPO: process.env.TEMPO_RPC ?? 'https://rpc.mainnet.tempo.xyz',
  MEGAETH: process.env.MEGAETH_RPC ?? 'https://rpc.megaeth.xyz',
  ARBITRUM: process.env.ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc',
  LINEA: process.env.LINEA_RPC ?? 'https://rpc.linea.build',
  INK: process.env.INK_RPC ?? 'https://rpc-gel.inkonchain.com',
  AVALANCHE: process.env.AVALANCHE_RPC ?? 'https://rpc.ankr.com/avalanche',
  SCROLL: process.env.SCROLL_RPC ?? 'https://1rpc.io/scroll',
  MODE: process.env.MODE_RPC ?? 'https://1rpc.io/mode',
  SONEIUM: process.env.SONEIUM_RPC ?? 'https://rpc.soneium.org',
  PLASMA: process.env.PLASMA_RPC ?? 'https://rpc.plasma.to',
  BLAST: process.env.BLAST_RPC ?? 'https://blastl2-mainnet.public.blastapi.io',
  BERACHAIN: process.env.BERACHAIN_RPC ?? 'https://berachain-rpc.publicnode.com',
  SEI: process.env.SEI_RPC ?? 'https://evm-rpc.sei-apis.com',
  PLUME: process.env.PLUME_RPC ?? 'https://rpc.plume.org',
  KATANA: process.env.KATANA_RPC ?? 'https://rpc.katana.network',
} as const;

// ─── API keys ─────────────────────────────────────────────────────────────────

export const RELAY_API_KEY: string | undefined = process.env.RELAY_API_KEY;
export const OPEN_OCEAN_API_KEY: string | undefined =
  process.env.OPEN_OCEAN_API_KEY;
export const KYBERSWAP_API_KEY: string | undefined =
  process.env.KYBERSWAP_API_KEY;
export const ZEROX_API_KEY: string | undefined = process.env.ZEROX_API_KEY;

/**
 * Swap slippage in basis points for KyberSwap and 0x (300 = 3%).
 * Matches the default OO_SLIPPAGE_PERCENT of 3%.
 */
export const SWAP_SLIPPAGE_BPS = 300;
