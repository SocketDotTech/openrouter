/**
 * Shared configuration: addresses, chain IDs, token info, and CCTP config
 * used across all e2e scripts.
 */
import * as dotenv from 'dotenv';
dotenv.config();

// ─── Chain IDs ───────────────────────────────────────────────────────────────

export const CHAIN_IDS = {
  ETHEREUM: 1,
  ARBITRUM: 42161,
  BASE: 8453,
} as const;

// ─── Contract addresses ───────────────────────────────────────────────────────

/** 0x AllowanceHolder — same address on every EVM chain */
export const ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';

/** Deployed combined unchecked router instance (set via env after deployment) */
export const ROUTER_ADDRESS: string = '0x33cBEF62f74f5204651D4C5Dcc3fd8E56A01F2aF';

/** Standard ERC-20 "native" sentinel used by CurrencyLib */
export const NATIVE_TOKEN_ADDRESS =
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ─── Token addresses ──────────────────────────────────────────────────────────

export const TOKENS = {
  AAVE_ARB: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
  AAVE_ETH: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  USDC_ARB: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  USDC_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_ETH: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  AAVE_BASE: '0x63706e401c06ac8513145b7687a14804d17f814b',
} as const;

// ─── CCTP v2 configuration ────────────────────────────────────────────────────

export interface CctpChainConfig {
  tokenMessenger: string;
  /** Circle's domain identifier for CCTP */
  cctpDomain: number;
  usdcAddress: string;
}

export const CCTP_CONFIG: Record<number, CctpChainConfig> = {
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

// ─── Stargate Native Pool (ETH Arbitrum → ETH Base) ─────────────────────────

/**
 * Stargate Native ETH OFT adapter on Arbitrum.
 * Call send() with msg.value = amountLD + nativeFee to bridge ETH to Base.
 * Ref: poc-openrouter/test/poc/OpenOceanStargateNativeSwapFeeBridgeRouterPoC.t.sol
 */
export const STARGATE_NATIVE_ARB = '0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F';

/** LayerZero v2 endpoint ID for Base (EID 30184). Used in Stargate sendParam.dstEid. */
export const BASE_LZ_EID = 30184;

/**
 * Byte offset of sendParam.amountLD within the Stargate send() calldata (after the 4-byte selector).
 * Layout: selector(4) + head[sendParam_ptr(32) + nativeFee(32) + lzTokenFee(32) + refundAddr(32)] +
 *         tail[dstEid(32) + to(32)] + amountLD = 4+128+32+32 = 196
 */
export const STARGATE_AMOUNT_LD_OFFSET = 196;

// ─── Fee config ───────────────────────────────────────────────────────────────

/** Fee applied in scripts that take pre-/post-route fees (basis points). */
export const FEE_BPS = Number(process.env.FEE_AMOUNT_BPS ?? '10');

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10000n;
}

// ─── RPC endpoints ────────────────────────────────────────────────────────────

export const RPC = {
  ARBITRUM: process.env.ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc',
  ETHEREUM: process.env.ETHEREUM_RPC ?? 'https://eth.llamarpc.com',
  BASE: process.env.BASE_RPC ?? 'https://mainnet.base.org',
} as const;

// ─── API keys ─────────────────────────────────────────────────────────────────

export const RELAY_API_KEY: string | undefined = process.env.RELAY_API_KEY;
export const OPEN_OCEAN_API_KEY: string | undefined =
  process.env.OPEN_OCEAN_API_KEY;
