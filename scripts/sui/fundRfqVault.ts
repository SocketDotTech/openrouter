import { spawnSync } from 'child_process';
import { config as dotenvConfig } from 'dotenv';
import { mkdtemp, rm } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';

import {
  SUI_RFQ_VAULT_GAS_BUDGET,
  SUI_RFQ_VAULT_NETWORK_ALIAS,
  SUI_RFQ_VAULT_RPC_URL,
} from './rfqVaultDeploymentConfig';

dotenvConfig({ path: resolve(__dirname, '../../.env') });

const REPO_ROOT = resolve(__dirname, '../..');
const DEPLOYER_ALIAS = 'rfq-vault-funder';
const TEMP_ENV_ALIAS_PREFIX = 'rfqvault_fund_';
const DEPLOYER_SCHEMES = new Set(['ed25519', 'secp256k1', 'secp256r1']);

// Edit these constants for manual funding runs.
const FUND_AMOUNT = '10';
const FUND_TOKEN_DECIMALS = 6;
const FUND_TOKEN_TYPE =
  '0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI';
const FUND_SOURCE_COIN_ID =
  '0xdb07fb3f5389a24866aa8056902cbc9e5fd943967f764a9525c6500cdcf4135a';
const RFQ_VAULT_PACKAGE =
  '0x4479fe1d936051823526e9a0c890c3d582001d28c6d57ce26d7bb9159a8c5638';
const RFQ_VAULT_OBJECT =
  '0xae8664656a8a5644cc8d7f7c4d1fcf7c5123bdb093a588be46aba55e06f71e6c';
const FUND_GAS_BUDGET = SUI_RFQ_VAULT_GAS_BUDGET || '1000000000';
const FUND_NETWORK_ALIAS = SUI_RFQ_VAULT_NETWORK_ALIAS || 'mainnet';
const FUND_RPC_URL = SUI_RFQ_VAULT_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

type SuiObjectChange = {
  type?: string;
  objectId?: string;
  objectType?: string;
};

type SuiCommandResult = {
  digest?: string;
  objectChanges?: SuiObjectChange[];
};

function resolveDeployerConfig(): { secret: string; scheme: string } {
  const secret = process.env.SUI_DEPLOYER?.trim();
  if (!secret) {
    throw new Error('SUI_DEPLOYER is required');
  }

  const scheme = (
    process.env.SUI_DEPLOYER_SCHEME?.trim() || 'ed25519'
  ).toLowerCase();
  if (!DEPLOYER_SCHEMES.has(scheme)) {
    throw new Error(
      `SUI_DEPLOYER_SCHEME must be one of ${Array.from(DEPLOYER_SCHEMES).join(', ')}`,
    );
  }

  return { secret, scheme };
}

function assertPositiveInteger(name: string, value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function parseTokenAmount(amount: string, decimals: number): string {
  const trimmed = amount.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    throw new Error('FUND_AMOUNT must be a positive decimal string');
  }

  const [whole, fractional = ''] = trimmed.split('.');
  if (fractional.length > decimals) {
    throw new Error(
      `FUND_AMOUNT has too many decimal places; token supports ${decimals}`,
    );
  }

  const units = `${whole}${fractional.padEnd(decimals, '0')}`.replace(
    /^0+/,
    '',
  );
  if (!units) {
    throw new Error('FUND_AMOUNT must be greater than zero');
  }

  return units;
}

function childEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: configDir,
    SUI_CONFIG_DIR: configDir,
  };
}

function redact(value: string, redactions: readonly string[]): string {
  const withExplicitRedactions = redactions.reduce(
    (acc, secret) => (secret ? acc.split(secret).join('[redacted]') : acc),
    value,
  );
  return withExplicitRedactions.replace(
    /secret recovery phrase\s*:\s*\[[^\]]*]/gi,
    'secret recovery phrase : [redacted]',
  );
}

function runSui(
  args: string[],
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    label: string;
    redactions?: readonly string[];
  },
): string {
  console.log(`[sui] ${params.label}`);
  const result = spawnSync('sui', args, {
    cwd: params.cwd ?? REPO_ROOT,
    env: params.env,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = redact(
      [result.stdout, result.stderr].filter(Boolean).join('\n'),
      params.redactions ?? [],
    );
    throw new Error(`${params.label} failed\n${output}`);
  }

  return result.stdout.trim();
}

function runSuiJson<T>(
  args: string[],
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    label: string;
    redactions?: readonly string[];
  },
): T {
  const stdout = runSui(args, params);
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new Error(
      `${params.label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function tempEnvAlias(networkAlias: string): string {
  return `${TEMP_ENV_ALIAS_PREFIX}${networkAlias.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function findCreatedCoinId(
  result: SuiCommandResult,
  coinType: string,
): string {
  const expectedObjectType = `0x2::coin::Coin<${coinType}>`;
  const coinId = result.objectChanges?.find(
    (change) =>
      change.type === 'created' &&
      change.objectId &&
      change.objectType === expectedObjectType,
  )?.objectId;
  if (!coinId) {
    throw new Error(
      `Split coin object not found in Sui result for ${expectedObjectType}`,
    );
  }

  return coinId;
}

async function main() {
  assertPositiveInteger('FUND_GAS_BUDGET', FUND_GAS_BUDGET);
  if (!FUND_SOURCE_COIN_ID.trim()) {
    throw new Error('FUND_SOURCE_COIN_ID is required');
  }
  const deployer = resolveDeployerConfig();
  const amountInBaseUnits = parseTokenAmount(
    FUND_AMOUNT,
    FUND_TOKEN_DECIMALS,
  );
  const configDir = await mkdtemp(resolve(tmpdir(), 'sui-rfq-vault-fund-'));
  const clientConfig = resolve(configDir, 'client.yaml');
  const env = childEnv(configDir);
  const networkAlias = tempEnvAlias(FUND_NETWORK_ALIAS);

  try {
    runSui(
      [
        'client',
        '--client.config',
        clientConfig,
        '-y',
        'new-env',
        '--alias',
        networkAlias,
        '--rpc',
        FUND_RPC_URL,
      ],
      { env, label: 'create temporary Sui client env' },
    );
    runSui(
      [
        'keytool',
        'import',
        '--alias',
        DEPLOYER_ALIAS,
        '--json',
        deployer.secret,
        deployer.scheme,
      ],
      {
        env,
        label: 'import SUI_DEPLOYER into temporary keystore',
        redactions: [deployer.secret],
      },
    );
    runSui(
      [
        'client',
        '--client.config',
        clientConfig,
        'switch',
        '--env',
        networkAlias,
      ],
      { env, label: 'select Sui env' },
    );
    runSui(
      [
        'client',
        '--client.config',
        clientConfig,
        'switch',
        '--address',
        DEPLOYER_ALIAS,
      ],
      { env, label: 'select Sui funder' },
    );

    const splitResult = runSuiJson<SuiCommandResult>(
      [
        'client',
        '--client.config',
        clientConfig,
        '--json',
        'split-coin',
        '--coin-id',
        FUND_SOURCE_COIN_ID,
        '--amounts',
        amountInBaseUnits,
        '--gas-budget',
        FUND_GAS_BUDGET,
      ],
      { env, label: `split ${FUND_AMOUNT} token units for vault funding` },
    );
    const splitCoinId = findCreatedCoinId(splitResult, FUND_TOKEN_TYPE);

    const fundResult = runSuiJson<SuiCommandResult>(
      [
        'client',
        '--client.config',
        clientConfig,
        '--json',
        'call',
        '--package',
        RFQ_VAULT_PACKAGE,
        '--module',
        'vault',
        '--function',
        'fund',
        '--type-args',
        FUND_TOKEN_TYPE,
        '--args',
        RFQ_VAULT_OBJECT,
        splitCoinId,
        '--gas-budget',
        FUND_GAS_BUDGET,
      ],
      { env, label: 'fund RFQ vault' },
    );

    console.log('');
    console.log('Sui RFQ vault funded');
    console.log(`Amount:       ${FUND_AMOUNT}`);
    console.log(`Base units:   ${amountInBaseUnits}`);
    console.log(`Token:        ${FUND_TOKEN_TYPE}`);
    console.log(`Vault:        ${RFQ_VAULT_OBJECT}`);
    console.log(`Split tx:     ${splitResult.digest ?? 'unknown'}`);
    console.log(`Split coin:   ${splitCoinId}`);
    console.log(`Fund tx:      ${fundResult.digest ?? 'unknown'}`);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
