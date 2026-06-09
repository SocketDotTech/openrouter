import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import {
  CHAIN_IDS,
  allowanceHolderForChain,
  allowanceHolderVariantForChain,
} from '../e2e/config';
import type { AllowanceHolderVariant } from '../e2e/config';
import {
  allowanceHolderManifestPath,
  type AllowanceHolderDeploymentManifest,
} from './allowanceHolderDeployment';

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
  plasma: CHAIN_IDS.PLASMA,
  monad: CHAIN_IDS.MONAD,
  linea: CHAIN_IDS.LINEA,
  mantle: CHAIN_IDS.MANTLE,
  gnosis: CHAIN_IDS.GNOSIS,
  katana: CHAIN_IDS.KATANA,
  mode: CHAIN_IDS.MODE,
  megaeth: CHAIN_IDS.MEGAETH,
  plume: CHAIN_IDS.PLUME,
  blast: CHAIN_IDS.BLAST,
  soneium: CHAIN_IDS.SONEIUM,
  sei: CHAIN_IDS.SEI,
  tempo: CHAIN_IDS.TEMPO,
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
  'plasma',
  'monad',
  'linea',
  'mantle',
  'gnosis',
  'katana',
  'mode',
  'megaeth',
  'plume',
  'blast',
  'soneium',
  'sei',
] as const;

export interface OpenRouterBuildConfig {
  network: string;
  chainId: number;
  allowanceHolder: string;
  allowanceHolderConfigSource: 'env' | 'deployment_manifest' | 'static_config';
  allowanceHolderDeploymentManifest?: string;
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

function readAllowanceHolderDeploymentManifest(
  chainId: number,
):
  | {
      manifest: AllowanceHolderDeploymentManifest;
      manifestPath: string;
    }
  | undefined {
  const manifestPath = allowanceHolderManifestPath(chainId);
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as AllowanceHolderDeploymentManifest;
  if (!ADDR_HEX_RE.test(manifest.allowanceHolder)) {
    throw new Error(
      `Invalid AllowanceHolder address in ${manifestPath}: ${manifest.allowanceHolder}`,
    );
  }

  if (manifest.variant !== 'cancun' && manifest.variant !== 'shanghai') {
    throw new Error(
      `Invalid AllowanceHolder variant in ${manifestPath}: ${manifest.variant}`,
    );
  }

  return { manifest, manifestPath };
}

function resolveAllowanceHolderForOpenRouter(chainId: number): {
  address: string;
  variant: AllowanceHolderVariant;
  source: OpenRouterBuildConfig['allowanceHolderConfigSource'];
  manifestPath?: string;
} {
  const envAddress = envAllowanceHolderForChain(chainId);
  if (envAddress) {
    return {
      address: envAddress,
      variant: allowanceHolderVariantForChain(chainId),
      source: 'env',
    };
  }

  const manifest = readAllowanceHolderDeploymentManifest(chainId);
  if (manifest) {
    return {
      address: manifest.manifest.allowanceHolder,
      variant: manifest.manifest.variant,
      source: 'deployment_manifest',
      manifestPath: manifest.manifestPath,
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
    allowanceHolderDeploymentManifest: resolvedAllowanceHolder.manifestPath,
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

export function openRouterBuildManifestPath(chainId: number): string {
  return resolve(
    process.cwd(),
    'deployments',
    'openrouter-build',
    `${chainId}.json`,
  );
}

export async function writeOpenRouterBuildManifest(
  config: OpenRouterBuildConfig,
): Promise<string> {
  const filePath = openRouterBuildManifestPath(config.chainId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ...config,
        allowanceHolderSource: OPENROUTER_ALLOWANCE_HOLDER_SOURCE,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return filePath;
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
): Promise<{ config: OpenRouterBuildConfig; manifestPath: string }> {
  const config = resolveOpenRouterBuildConfig(network);
  await assertOpenRouterForkCompatibility(config);
  await patchOpenRouterAllowanceHolderConstant(config.allowanceHolder);
  const manifestPath = await writeOpenRouterBuildManifest(config);
  return { config, manifestPath };
}

export function openRouterBuildProfileKey(
  config: OpenRouterBuildConfig,
): string {
  return `${config.evmVersion}:${config.allowanceHolder.toLowerCase()}`;
}
