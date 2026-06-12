import { Provider } from 'ethers';
import { ReceiverDeployNetwork } from './networks';

const DEFAULT_GAS_PRICE_MULTIPLIER = 1.05;

type ChainOverride = {
  type?: number;
  gasLimit?: number;
  gasPrice?: bigint;
  gasPriceMultiplier?: number;
};

export type DeploymentTransactionOverrides = {
  type?: number;
  gasLimit?: number;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
};

const CHAIN_OVERRIDES: Record<string, ChainOverride> = {
  unichain: {
    type: 0,
    gasPrice: 100_000_000n,
  },
  gnosis: {
    gasPrice: 1_000_000n,
  },
  plasma: {
    type: 2,
    gasLimit: 5_000_000,
    gasPrice: 1_000_000_000n,
  },
  sei: {
    gasLimit: 5_000_000,
  },
  monad: {
    gasLimit: 5_000_000,
  },
  plume: {
    gasLimit: 5_000_000,
  },
  scroll: {
    gasLimit: 3_000_000,
    gasPriceMultiplier: 20,
  },
  avalanche: {
    gasLimit: 3_000_000,
    gasPriceMultiplier: 2,
  },
};

function applyMultiplier(value: bigint, multiplier: number): bigint {
  return (value * BigInt(Math.round(multiplier * 100_000))) / 100_000n;
}

export async function getDeploymentTransactionOverrides(params: {
  network: ReceiverDeployNetwork;
  provider: Provider;
}): Promise<DeploymentTransactionOverrides> {
  const override = CHAIN_OVERRIDES[params.network.name] ?? {};
  const { gasLimit, type = override.type } = override;

  if (type === 2) {
    const feeData = await params.provider.getFeeData();
    const latestBlock = await params.provider.getBlock('latest');
    const baseFee = latestBlock?.baseFeePerGas ?? 0n;
    const baseMaxFee = override.gasPrice ?? feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!baseMaxFee) {
      return { type, gasLimit };
    }

    const multiplier =
      override.gasPriceMultiplier ?? DEFAULT_GAS_PRICE_MULTIPLIER;
    const maxFeePerGas = override.gasPrice
      ? override.gasPrice
      : applyMultiplier(baseMaxFee, multiplier);
    const maxPriorityFeePerGas =
      maxFeePerGas > baseFee ? maxFeePerGas - baseFee : 0n;

    return { type, gasLimit, maxFeePerGas, maxPriorityFeePerGas };
  }

  const feeData = await params.provider.getFeeData();
  const baseGasPrice = override.gasPrice ?? feeData.gasPrice;
  if (!baseGasPrice) {
    return { type, gasLimit };
  }

  const multiplier =
    override.gasPriceMultiplier ?? DEFAULT_GAS_PRICE_MULTIPLIER;
  const gasPrice = override.gasPrice
    ? override.gasPrice
    : applyMultiplier(baseGasPrice, multiplier);

  return { type, gasLimit, gasPrice };
}
