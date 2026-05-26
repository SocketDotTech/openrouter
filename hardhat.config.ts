import '@nomicfoundation/hardhat-foundry';
import '@nomicfoundation/hardhat-toolbox';
import { config as dotenvConfig } from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
import { resolve } from 'path';

dotenvConfig({ path: resolve(__dirname, './.env') });

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.34',
    settings: {
      optimizer: {
        enabled: true,
        runs: 2000,
      },
      evmVersion: 'cancun',
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    ethereum: {
      url: process.env.ETHEREUM_RPC ?? 'https://eth.llamarpc.com',
      chainId: 1,
      accounts,
    },
    polygon: {
      url: process.env.POLYGON_RPC ?? 'https://polygon.llamarpc.com',
      chainId: 137,
      accounts,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC ?? 'https://rpc.ankr.com/arbitrum',
      chainId: 42161,
      accounts,
    },
    optimism: {
      url: process.env.OPTIMISM_RPC ?? 'https://mainnet.optimism.io',
      chainId: 10,
      accounts,
    },
    base: {
      url: process.env.BASE_RPC ?? 'https://mainnet.base.org',
      chainId: 8453,
      accounts,
    },
    avalanche: {
      url: process.env.AVALANCHE_RPC ?? 'https://rpc.ankr.com/avalanche',
      chainId: 43114,
      accounts,
    },
    bsc: {
      url: process.env.BSC_RPC ?? 'https://bsc-dataseed.binance.org/',
      chainId: 56,
      accounts,
    },
    linea: {
      url: process.env.LINEA_RPC ?? 'https://rpc.linea.build',
      chainId: 59144,
      accounts,
    },
    scroll: {
      url: process.env.SCROLL_RPC ?? 'https://1rpc.io/scroll',
      chainId: 534352,
      accounts,
    },
    blast: {
      url:
        process.env.BLAST_RPC ?? 'https://blastl2-mainnet.public.blastapi.io',
      chainId: 81457,
      accounts,
    },
    mode: {
      url: process.env.MODE_RPC ?? 'https://1rpc.io/mode',
      chainId: 34443,
      accounts,
    },
    mantle: {
      url: process.env.MANTLE_RPC ?? 'https://rpc.mantle.xyz',
      chainId: 5000,
      accounts,
    },
    gnosis: {
      url: process.env.GNOSIS_RPC ?? 'https://rpc.ankr.com/gnosis',
      chainId: 100,
      accounts,
    },
    sonic: {
      url: process.env.SONIC_RPC ?? 'https://rpc.ankr.com/sonic_mainnet',
      chainId: 146,
      accounts,
    },
    unichain: {
      url: process.env.UNICHAIN_RPC ?? 'https://0xrpc.io/uni',
      chainId: 130,
      accounts,
    },
    berachain: {
      url: process.env.BERACHAIN_RPC ?? 'https://berachain-rpc.publicnode.com',
      chainId: 80094,
      accounts,
    },
    ink: {
      url: process.env.INK_RPC ?? 'https://rpc-gel.inkonchain.com',
      chainId: 57073,
      accounts,
    },
    soneium: {
      url: process.env.SONEIUM_RPC ?? 'https://soneium.drpc.org',
      chainId: 1868,
      accounts,
    },
    worldchain: {
      url:
        process.env.WORLDCHAIN_RPC ??
        'https://worldchain-mainnet.g.alchemy.com/public',
      chainId: 480,
      accounts,
    },
    sei: {
      url: process.env.SEI_RPC ?? 'https://evm-rpc.sei-apis.com',
      chainId: 1329,
      accounts,
    },
    katana: {
      url: process.env.KATANA_RPC ?? 'https://rpc.katana.network',
      chainId: 747474,
      accounts,
    },
    hyperEvm: {
      url: process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm',
      chainId: 999,
      accounts,
    },
    plasma: {
      url: process.env.PLASMA_RPC ?? 'https://rpc.plasma.to',
      chainId: 9745,
      accounts,
      gasPrice: 1_000_000_000,
    },
    monad: {
      url: process.env.MONAD_RPC ?? 'https://rpc.monad.xyz',
      chainId: 143,
      accounts,
    },
    tempo: {
      url: process.env.TEMPO_RPC ?? 'https://rpc.mainnet.tempo.xyz',
      chainId: 4217,
      accounts,
    },
    // testnets
    arbitrumSepolia: {
      url:
        process.env.ARBITRUM_SEPOLIA_RPC ??
        'https://arbitrum-sepolia-rpc.publicnode.com',
      chainId: 421614,
      accounts,
    },
    optimismSepolia: {
      url: process.env.OPTIMISM_SEPOLIA_RPC ?? 'https://sepolia.optimism.io',
      chainId: 11155420,
      accounts,
    },
  },
  etherscan: {
    enabled: true,
    apiKey: {
      mainnet: process.env.MAINNET_ETHERSCAN_KEY ?? '',
      ethereum: process.env.MAINNET_ETHERSCAN_KEY ?? '',
      polygon: process.env.POLYGON_ETHERSCAN_KEY ?? '',
      arbitrumOne: process.env.ARBITRUM_ETHERSCAN_KEY ?? '',
      optimism: process.env.OPTIMISM_ETHERSCAN_KEY ?? '',
      base: process.env.BASE_ETHERSCAN_KEY ?? '',
      bsc: process.env.BSC_ETHERSCAN_KEY ?? '',
      avalanche: process.env.AVALANCHE_ETHERSCAN_KEY ?? '',
      linea: process.env.LINEA_ETHERSCAN_KEY ?? '',
      scroll: process.env.SCROLL_ETHERSCAN_KEY ?? '',
      blast: process.env.BLAST_ETHERSCAN_KEY ?? '',
      mantle: process.env.MANTLE_ETHERSCAN_KEY ?? '',
      gnosis: process.env.GNOSIS_ETHERSCAN_KEY ?? '',
      sonic: process.env.SONIC_ETHERSCAN_KEY ?? '',
      unichain: process.env.UNICHAIN_ETHERSCAN_KEY ?? '',
      berachain: process.env.BERACHAIN_ETHERSCAN_KEY ?? '',
      ink: process.env.INK_ETHERSCAN_KEY ?? '',
      mode: process.env.MODE_ETHERSCAN_KEY ?? '',
      worldchain: process.env.WORLDCHAIN_ETHERSCAN_KEY ?? '',
      sei: process.env.SEI_ETHERSCAN_KEY ?? '',
      katana: process.env.KATANA_ETHERSCAN_KEY ?? '',
      hyperEvm: process.env.HYPEREVM_ETHERSCAN_KEY ?? '',
      plasma: process.env.PLASMA_ETHERSCAN_KEY ?? '',
      monad: process.env.MONAD_ETHERSCAN_KEY ?? '',
      tempo: process.env.TEMPO_ETHERSCAN_KEY ?? '',
      arbitrumSepolia: process.env.ARBITRUM_ETHERSCAN_KEY ?? '',
      optimismSepolia: process.env.OPTIMISM_ETHERSCAN_KEY ?? '',
    },
    customChains: [
      {
        network: 'ethereum',
        chainId: 1,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=1',
          browserURL: 'https://etherscan.io',
        },
      },
      {
        network: 'optimism',
        chainId: 10,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=10',
          browserURL: 'https://optimistic.etherscan.io',
        },
      },
      {
        network: 'bsc',
        chainId: 56,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=56',
          browserURL: 'https://bscscan.com',
        },
      },
      {
        network: 'polygon',
        chainId: 137,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=137',
          browserURL: 'https://polygonscan.com',
        },
      },
      {
        network: 'mantle',
        chainId: 5000,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=5000',
          browserURL: 'https://mantlescan.xyz',
        },
      },
      {
        network: 'arbitrumOne',
        chainId: 42161,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=42161',
          browserURL: 'https://arbiscan.io',
        },
      },
      {
        network: 'avalanche',
        chainId: 43114,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=43114',
          browserURL: 'https://snowscan.xyz',
        },
      },
      {
        network: 'linea',
        chainId: 59144,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=59144',
          browserURL: 'https://lineascan.build',
        },
      },
      {
        network: 'base',
        chainId: 8453,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=8453',
          browserURL: 'https://basescan.org',
        },
      },
      {
        network: 'gnosis',
        chainId: 100,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=100',
          browserURL: 'https://gnosisscan.io',
        },
      },
      {
        network: 'blast',
        chainId: 81457,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=81457',
          browserURL: 'https://blastscan.io',
        },
      },
      {
        network: 'scroll',
        chainId: 534352,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=534352',
          browserURL: 'https://scrollscan.com',
        },
      },
      {
        network: 'mode',
        chainId: 34443,
        urls: {
          apiURL: 'https://explorer.mode.network/api',
          browserURL: 'https://explorer.mode.network',
        },
      },
      {
        network: 'sonic',
        chainId: 146,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=146',
          browserURL: 'https://sonicscan.org',
        },
      },
      {
        network: 'unichain',
        chainId: 130,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=130',
          browserURL: 'https://uniscan.xyz',
        },
      },
      {
        network: 'berachain',
        chainId: 80094,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=80094',
          browserURL: 'https://berascan.com',
        },
      },
      {
        network: 'ink',
        chainId: 57073,
        urls: {
          apiURL: 'https://explorer.inkonchain.com/api',
          browserURL: 'https://explorer.inkonchain.com',
        },
      },
      {
        network: 'soneium',
        chainId: 1868,
        urls: {
          apiURL: 'https://soneium.blockscout.com/api',
          browserURL: 'https://soneium.blockscout.com',
        },
      },
      {
        network: 'worldchain',
        chainId: 480,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=480',
          browserURL: 'https://worldscan.org',
        },
      },
      {
        network: 'sei',
        chainId: 1329,
        urls: {
          apiURL: 'https://seitrace.com/pacific-1/api',
          browserURL: 'https://seitrace.com',
        },
      },
      {
        network: 'katana',
        chainId: 747474,
        urls: {
          apiURL: 'https://explorer.katanarpc.com/api',
          browserURL: 'https://explorer.katanarpc.com',
        },
      },
      {
        network: 'hyperEvm',
        chainId: 999,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=999',
          browserURL: 'https://hyperevmscan.io',
        },
      },
      {
        network: 'plasma',
        chainId: 9745,
        urls: {
          apiURL:
            'https://api.routescan.io/v2/network/mainnet/evm/9745/etherscan/api',
          browserURL: 'https://plasmascan.to',
        },
      },
      {
        network: 'monad',
        chainId: 143,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=143',
          browserURL: 'https://monadscan.com',
        },
      },
      {
        network: 'tempo',
        chainId: 4217,
        urls: {
          apiURL: 'https://explore.mainnet.tempo.xyz/api',
          browserURL: 'https://explore.mainnet.tempo.xyz',
        },
      },
      {
        network: 'arbitrumSepolia',
        chainId: 421614,
        urls: {
          apiURL: 'https://api-sepolia.arbiscan.io/api',
          browserURL: 'https://sepolia.arbiscan.io',
        },
      },
      {
        network: 'optimismSepolia',
        chainId: 11155420,
        urls: {
          apiURL: 'https://api-sepolia-optimistic.etherscan.io/api',
          browserURL: 'https://sepolia-optimism.etherscan.io',
        },
      },
    ],
  },
  typechain: {
    outDir: 'typechain',
    alwaysGenerateOverloads: true,
  },
  paths: {
    sources: './src',
    scripts: './scripts',
    cache: './cache-hh',
    artifacts: './artifacts',
  },
};

export default config;
