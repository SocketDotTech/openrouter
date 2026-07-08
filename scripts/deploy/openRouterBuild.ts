import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  CHAIN_IDS,
  allowanceHolderForChain,
  allowanceHolderVariantForChain,
} from '../e2e/config';
import type { AllowanceHolderVariant } from '../e2e/config';
import {
  findDeploymentRegistryRow,
  upsertDeploymentRegistryRow,
} from './deploymentRegistry';

const OPENROUTER_ALLOWANCE_HOLDER_SOURCE = resolve(
  process.cwd(),
  'src',
  'common',
  'interfaces',
  'IAllowanceHolder.sol',
);

const ALLOWANCE_HOLDER_CONSTANT_RE =
  /IAllowanceHolder constant ALLOWANCE_HOLDER = IAllowanceHolder\(0x[a-fA-F0-9]{40}\);/;

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;

export const OPENROUTER_NETWORK_CHAIN_IDS: Record<string, number> = {
  hardhat: 31337,
  ethereum: CHAIN_IDS.ETHEREUM,
  polygon: CHAIN_IDS.POLYGON,
  base: CHAIN_IDS.BASE,
  optimism: CHAIN_IDS.OPTIMISM,
  arbitrum: CHAIN_IDS.ARBITRUM,
  bsc: CHAIN_IDS.BNB,
  worldchain: CHAIN_IDS.WORLDCHAIN,
  sonic: CHAIN_IDS.SONIC,
  ink: CHAIN_IDS.INK,
  avalanche: CHAIN_IDS.AVALANCHE,
  unichain: CHAIN_IDS.UNICHAIN,
  berachain: CHAIN_IDS.BERACHAIN,
  scroll: CHAIN_IDS.SCROLL,
  hyperEvm: CHAIN_IDS.HYPEREVM,
  arc: CHAIN_IDS.ARC,
  plasma: CHAIN_IDS.PLASMA,
  tempo: CHAIN_IDS.TEMPO,
  monad: CHAIN_IDS.MONAD,
  linea: CHAIN_IDS.LINEA,
  mantle: CHAIN_IDS.MANTLE,
  gnosis: CHAIN_IDS.GNOSIS,
  katana: CHAIN_IDS.KATANA,
  mode: CHAIN_IDS.MODE,
  megaeth: CHAIN_IDS.MEGAETH,
  robinhood: CHAIN_IDS.ROBINHOOD,
  plume: CHAIN_IDS.PLUME,
  blast: CHAIN_IDS.BLAST,
  soneium: CHAIN_IDS.SONEIUM,
  sei: CHAIN_IDS.SEI,
  citrea: CHAIN_IDS.CITREA,
  arbitrumSepolia: 421614,
  optimismSepolia: 11155420,
};

export const OPENROUTER_DEPLOY_NETWORKS = [
  'ethereum',
  'polygon',
  'base',
  'optimism',
  'arbitrum',
  'bsc',
  'worldchain',
  'sonic',
  'ink',
  'avalanche',
  'unichain',
  'berachain',
  'scroll',
  'hyperEvm',
  'arc',
  'plasma',
  'monad',
  'linea',
  'mantle',
  'gnosis',
  'katana',
  'mode',
  'megaeth',
  'robinhood',
  'plume',
  'blast',
  'soneium',
  'sei',
  'citrea',
] as const;

export function networkForChainId(chainId: number): string | undefined {
  return Object.entries(OPENROUTER_NETWORK_CHAIN_IDS).find(
    ([network, networkChainId]) =>
      network !== 'hardhat' && networkChainId === chainId,
  )?.[0];
}

export interface OpenRouterBuildConfig {
  network: string;
  chainId: number;
  allowanceHolder: string;
  allowanceHolderConfigSource: 'env' | 'deployment_registry' | 'static_config';
  allowanceHolderVariant: AllowanceHolderVariant;
  evmVersion: AllowanceHolderVariant;
}

function envAllowanceHolderForChain(chainId: number): string | undefined {
  const envSpecific = process.env[`ALLOWANCE_HOLDER_CHAIN_${chainId}`]?.trim();
  if (envSpecific && ADDR_HEX_RE.test(envSpecific)) {
    return envSpecific;
  }

  const envGlobal = process.env.ALLOWANCE_HOLDER_ADDRESS?.trim();
  if (envGlobal && ADDR_HEX_RE.test(envGlobal)) {
    return envGlobal;
  }

  return undefined;
}

function resolveAllowanceHolderForOpenRouter(chainId: number): {
  address: string;
  variant: AllowanceHolderVariant;
  source: OpenRouterBuildConfig['allowanceHolderConfigSource'];
} {
  const envAddress = envAllowanceHolderForChain(chainId);
  if (envAddress) {
    return {
      address: envAddress,
      variant: allowanceHolderVariantForChain(chainId),
      source: 'env',
    };
  }

  const registryRow = findDeploymentRegistryRow(chainId);
  if (registryRow?.allowanceHolderAddress) {
    if (!ADDR_HEX_RE.test(registryRow.allowanceHolderAddress)) {
      throw new Error(
        `Invalid AllowanceHolder address in deployments.csv for chain ${chainId}: ${registryRow.allowanceHolderAddress}`,
      );
    }

    return {
      address: registryRow.allowanceHolderAddress,
      variant: registryRow.variant,
      source: 'deployment_registry',
    };
  }

  return {
    address: allowanceHolderForChain(chainId),
    variant: allowanceHolderVariantForChain(chainId),
    source: 'static_config',
  };
}

export function parseNetworkArg(argv: string[]): string {
  const networkFlagIndex = argv.indexOf('--network');
  if (networkFlagIndex >= 0) {
    const network = argv[networkFlagIndex + 1];
    if (!network) {
      throw new Error('--network requires a value');
    }
    return network;
  }

  const positional = argv.find((arg) => !arg.startsWith('-'));
  if (positional) {
    return positional;
  }

  throw new Error('Network is required. Pass e.g. `polygon` or `--network polygon`.');
}

export function parseNetworkArgs(argv: string[]): {
  networks: string[];
  variant?: AllowanceHolderVariant;
} {
  const args = [...argv];
  let variant: AllowanceHolderVariant | undefined;
  const variantFlagIndex = args.indexOf('--variant');
  if (variantFlagIndex >= 0) {
    const value = args[variantFlagIndex + 1];
    if (value !== 'cancun' && value !== 'shanghai') {
      throw new Error("--variant requires 'cancun' or 'shanghai'");
    }
    variant = value;
    args.splice(variantFlagIndex, 2);
  }

  const networks = args.filter((arg) => !arg.startsWith('-'));
  return {
    networks: networks.length > 0 ? networks : [...OPENROUTER_DEPLOY_NETWORKS],
    variant,
  };
}

export function resolveOpenRouterBuildConfig(
  network: string,
): OpenRouterBuildConfig {
  const chainId = OPENROUTER_NETWORK_CHAIN_IDS[network];
  if (!chainId) {
    throw new Error(`Unknown network '${network}'`);
  }

  const resolvedAllowanceHolder = resolveAllowanceHolderForOpenRouter(chainId);
  const allowanceHolder = resolvedAllowanceHolder.address;
  if (!ADDR_HEX_RE.test(allowanceHolder)) {
    throw new Error(
      `Invalid AllowanceHolder address for chain ${chainId}: ${allowanceHolder}`,
    );
  }

  const allowanceHolderVariant = resolvedAllowanceHolder.variant;

  return {
    network,
    chainId,
    allowanceHolder,
    allowanceHolderConfigSource: resolvedAllowanceHolder.source,
    allowanceHolderVariant,
    evmVersion: allowanceHolderVariant,
  };
}

export async function patchOpenRouterAllowanceHolderConstant(
  allowanceHolder: string,
): Promise<void> {
  const source = await readFile(OPENROUTER_ALLOWANCE_HOLDER_SOURCE, 'utf8');
  if (!ALLOWANCE_HOLDER_CONSTANT_RE.test(source)) {
    throw new Error(
      `Could not find ALLOWANCE_HOLDER constant in ${OPENROUTER_ALLOWANCE_HOLDER_SOURCE}`,
    );
  }

  const patched = source.replace(
    ALLOWANCE_HOLDER_CONSTANT_RE,
    `IAllowanceHolder constant ALLOWANCE_HOLDER = IAllowanceHolder(${allowanceHolder});`,
  );

  if (patched !== source) {
    await writeFile(OPENROUTER_ALLOWANCE_HOLDER_SOURCE, patched);
  }
}

export async function writeOpenRouterBuildRegistry(
  config: OpenRouterBuildConfig,
): Promise<string> {
  return upsertDeploymentRegistryRow({
    chainId: config.chainId,
    variant: config.evmVersion,
    allowanceHolderAddress: config.allowanceHolder,
  });
}

export async function assertOpenRouterForkCompatibility(
  config: OpenRouterBuildConfig,
): Promise<void> {
  if (config.evmVersion !== 'shanghai') {
    return;
  }

  const openRouterSource = await readFile(
    resolve(process.cwd(), 'src', 'OpenRouter.sol'),
    'utf8',
  );
  const bytesSpliceSource = await readFile(
    resolve(process.cwd(), 'src', 'common', 'lib', 'BytesSpliceLib.sol'),
    'utf8',
  );

  if (/\bmcopy\b/.test(openRouterSource) || /\bmcopy\b/.test(bytesSpliceSource)) {
    throw new Error(
      [
        'OpenRouter cannot be built for shanghai/no-Cancun chains yet: source uses the Cancun MCOPY opcode.',
        'Replace mcopy with a Shanghai-compatible memory copy before deploying OpenRouter on this chain.',
        `network=${config.network}`,
        `chainId=${config.chainId}`,
        `allowanceHolder=${config.allowanceHolder}`,
      ].join(' '),
    );
  }
}

export async function prepareOpenRouterBuild(
  network: string,
): Promise<{ config: OpenRouterBuildConfig; registryPath: string }> {
  const config = resolveOpenRouterBuildConfig(network);
  await assertOpenRouterForkCompatibility(config);
  await patchOpenRouterAllowanceHolderConstant(config.allowanceHolder);
  const registryPath = await writeOpenRouterBuildRegistry(config);
  return { config, registryPath };
}

export function openRouterBuildProfileKey(
  config: OpenRouterBuildConfig,
): string {
  return `${config.evmVersion}:${config.allowanceHolder.toLowerCase()}`;
}
