/**
 * Per-chain Circle CCTP v2 config for CctpClaimExecutor deployment.
 */
import { CHAIN_IDS } from '../e2e/config';

export const CCTP_MESSAGE_TRANSMITTER =
  '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';

export type CctpClaimExecutorChainConfig = {
  chainId: number;
  usdcAddress: string;
  messageTransmitter: string;
};

export const CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG: Record<number, CctpClaimExecutorChainConfig> = {
  [CHAIN_IDS.ETHEREUM]: {
    chainId: CHAIN_IDS.ETHEREUM,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  [CHAIN_IDS.AVALANCHE]: {
    chainId: CHAIN_IDS.AVALANCHE,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },
  [CHAIN_IDS.BASE]: {
    chainId: CHAIN_IDS.BASE,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  [CHAIN_IDS.LINEA]: {
    chainId: CHAIN_IDS.LINEA,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
  },
  [CHAIN_IDS.ARBITRUM]: {
    chainId: CHAIN_IDS.ARBITRUM,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  },
  [CHAIN_IDS.SONIC]: {
    chainId: CHAIN_IDS.SONIC,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  },
  [CHAIN_IDS.WORLDCHAIN]: {
    chainId: CHAIN_IDS.WORLDCHAIN,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1',
  },
  [CHAIN_IDS.OPTIMISM]: {
    chainId: CHAIN_IDS.OPTIMISM,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  },
  [CHAIN_IDS.UNICHAIN]: {
    chainId: CHAIN_IDS.UNICHAIN,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  },
  [CHAIN_IDS.POLYGON]: {
    chainId: CHAIN_IDS.POLYGON,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  },
  [CHAIN_IDS.SEI]: {
    chainId: CHAIN_IDS.SEI,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
  },
  [CHAIN_IDS.HYPEREVM]: {
    chainId: CHAIN_IDS.HYPEREVM,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  },
  [CHAIN_IDS.PLUME]: {
    chainId: CHAIN_IDS.PLUME,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x222365EF19F7947e5484218551B56bb3965Aa7aF',
  },
  [CHAIN_IDS.INK]: {
    chainId: CHAIN_IDS.INK,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x2D270e6886d130D724215A266106e6832161EAEd',
  },
  [CHAIN_IDS.MONAD]: {
    chainId: CHAIN_IDS.MONAD,
    messageTransmitter: CCTP_MESSAGE_TRANSMITTER,
    usdcAddress: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  },
};

export const CCTP_CLAIM_EXECUTOR_CHAIN_IDS = Object.keys(CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG).map(
  (id) => Number(id),
);
