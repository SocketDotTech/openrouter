import { spawnSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { tmpdir } from 'os';
import {
  SUI_RFQ_VAULT_DEPLOYMENT_STAGE,
  SUI_RFQ_VAULT_DOMAIN,
  SUI_RFQ_VAULT_GAS_BUDGET,
  SUI_RFQ_VAULT_NETWORK_ALIAS,
  SUI_RFQ_VAULT_OWNER_ADDRESS,
  SUI_RFQ_VAULT_PACKAGE_PATH,
  SUI_RFQ_VAULT_RPC_URL,
  SUI_RFQ_VAULT_SOLVER_PUBLIC_KEY,
  SUI_RFQ_VAULT_VERIFY_SOURCE,
} from './rfqVaultDeploymentConfig';

type SuiObjectChange = {
  type?: string;
  packageId?: string;
  objectId?: string;
  objectType?: string;
};

type SuiCommandResult = {
  digest?: string;
  objectChanges?: SuiObjectChange[];
};

type DeploymentConfig = {
  networkAlias: string;
  rpcUrl: string;
  ownerAddress: string;
  solverPublicKey: string;
  domain: string;
  gasBudget: string;
  packagePath: string;
  stage: string;
  verifySource: boolean;
};

type DeployerConfig = {
  secret: string;
  scheme: string;
};

type DeploymentRecord = {
  SuiRFQVaultPackage: string;
  SuiRFQVault: string;
  SuiRFQVaultUpgradeCap?: string;
  SuiRFQVaultPublishTx?: string;
  SuiRFQVaultCreateTx?: string;
  SuiRFQVaultOwner: string;
  SuiRFQVaultSolverPublicKey: string;
  SuiRFQVaultDomain: string;
  SuiRFQVaultNetworkAlias: string;
};

const REPO_ROOT = resolve(__dirname, '../..');
const DEPLOYER_ALIAS = 'rfq-vault-deployer';
const SUI_ADDRESS_RE = /^0x[a-fA-F0-9]{64}$/;
const HEX_RE = /^0x[a-fA-F0-9]*$/;
const DEPLOYER_SCHEMES = new Set(['ed25519', 'secp256k1', 'secp256r1']);

function requireConfig(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `Fill ${name} in scripts/sui/rfqVaultDeploymentConfig.ts before deploying`,
    );
  }

  return trimmed;
}

function resolveDeploymentConfig(): DeploymentConfig {
  const config = {
    networkAlias: requireConfig(
      'SUI_RFQ_VAULT_NETWORK_ALIAS',
      SUI_RFQ_VAULT_NETWORK_ALIAS,
    ),
    rpcUrl: requireConfig('SUI_RFQ_VAULT_RPC_URL', SUI_RFQ_VAULT_RPC_URL),
    ownerAddress: requireConfig(
      'SUI_RFQ_VAULT_OWNER_ADDRESS',
      SUI_RFQ_VAULT_OWNER_ADDRESS,
    ),
    solverPublicKey: requireConfig(
      'SUI_RFQ_VAULT_SOLVER_PUBLIC_KEY',
      SUI_RFQ_VAULT_SOLVER_PUBLIC_KEY,
    ),
    domain: requireConfig('SUI_RFQ_VAULT_DOMAIN', SUI_RFQ_VAULT_DOMAIN),
    gasBudget: requireConfig(
      'SUI_RFQ_VAULT_GAS_BUDGET',
      SUI_RFQ_VAULT_GAS_BUDGET,
    ),
    packagePath: SUI_RFQ_VAULT_PACKAGE_PATH,
    stage: SUI_RFQ_VAULT_DEPLOYMENT_STAGE,
    verifySource: SUI_RFQ_VAULT_VERIFY_SOURCE,
  };

  assertSuiAddress('SUI_RFQ_VAULT_OWNER_ADDRESS', config.ownerAddress);
  assertHexBytes('SUI_RFQ_VAULT_SOLVER_PUBLIC_KEY', config.solverPublicKey, 33);
  assertPositiveInteger('SUI_RFQ_VAULT_GAS_BUDGET', config.gasBudget);

  return config;
}

function resolveDeployerConfig(): DeployerConfig {
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

function assertSuiAddress(name: string, value: string): void {
  if (!SUI_ADDRESS_RE.test(value)) {
    throw new Error(`${name} must be a 32-byte Sui address`);
  }
}

function assertHexBytes(name: string, value: string, byteLength: number): void {
  if (!HEX_RE.test(value) || value.length !== 2 + byteLength * 2) {
    throw new Error(`${name} must be ${byteLength} bytes of 0x-prefixed hex`);
  }
}

function assertPositiveInteger(name: string, value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function hexToBytes(hex: string): number[] {
  const stripped = hex.slice(2);
  return Array.from({ length: stripped.length / 2 }, (_, index) =>
    Number.parseInt(stripped.slice(index * 2, index * 2 + 2), 16),
  );
}

function stringToBytes(value: string): number[] {
  return [...Buffer.from(value, 'utf8')];
}

function vectorArg(bytes: number[]): string {
  return `[${bytes.join(',')}]`;
}

function childEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: configDir,
    SUI_CONFIG_DIR: configDir,
  };
}

function redact(value: string, redactions: readonly string[]): string {
  return redactions.reduce(
    (acc, secret) => (secret ? acc.split(secret).join('[redacted]') : acc),
    value,
  );
}

function runSui(args: string[], params: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  redactions?: readonly string[];
}): string {
  console.log(`[sui] ${params.label}`);
  const result = spawnSync('sui', args, {
    cwd: params.cwd ?? REPO_ROOT,
    env: params.env,
    encoding: 'utf8',
  });

  const redactions = params.redactions ?? [];
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = redact(
      [result.stdout, result.stderr].filter(Boolean).join('\n'),
      redactions,
    );
    throw new Error(`${params.label} failed\n${output}`);
  }

  return result.stdout.trim();
}

function runSuiJson<T>(args: string[], params: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  redactions?: readonly string[];
}): T {
  const stdout = runSui(args, params);
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new Error(
      `${params.label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function findPublishedPackageId(result: SuiCommandResult): string {
  const packageId = result.objectChanges?.find(
    (change) => change.type === 'published' && change.packageId,
  )?.packageId;
  if (!packageId) {
    throw new Error('Published package ID not found in Sui publish result');
  }

  return packageId;
}

function findCreatedObjectId(
  result: SuiCommandResult,
  objectTypeSuffix: string,
): string | undefined {
  return result.objectChanges?.find(
    (change) =>
      change.type === 'created' &&
      change.objectId &&
      change.objectType?.endsWith(objectTypeSuffix),
  )?.objectId;
}

function deploymentsPath(stage: string): string {
  return resolve(REPO_ROOT, 'deployments', stage, 'addresses', 'sui.json');
}

async function persistDeployment(
  stage: string,
  record: DeploymentRecord,
): Promise<string> {
  const filePath = deploymentsPath(stage);
  let deployments: Record<string, unknown> = {};

  try {
    deployments = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  Object.assign(deployments, record);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(deployments, null, 2)}\n`, 'utf8');

  return filePath;
}

async function main() {
  const config = resolveDeploymentConfig();
  const deployer = resolveDeployerConfig();
  const packagePath = resolve(REPO_ROOT, config.packagePath);
  const configDir = await mkdtemp(resolve(tmpdir(), 'sui-rfq-vault-deploy-'));
  const clientConfig = resolve(configDir, 'client.yaml');
  const env = childEnv(configDir);

  try {
    runSui(['move', 'build', '--path', packagePath], {
      label: 'build Move package',
    });
    runSui(
      [
        'client',
        '--client.config',
        clientConfig,
        '-y',
        'new-env',
        '--alias',
        config.networkAlias,
        '--rpc',
        config.rpcUrl,
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
        config.networkAlias,
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
      { env, label: 'select Sui deployer' },
    );

    const publishResult = runSuiJson<SuiCommandResult>(
      [
        'client',
        '--client.config',
        clientConfig,
        '--json',
        'publish',
        packagePath,
        '--gas-budget',
        config.gasBudget,
      ],
      { env, label: 'publish RFQ vault package' },
    );
    const packageId = findPublishedPackageId(publishResult);
    const upgradeCapId = findCreatedObjectId(
      publishResult,
      '0x2::package::UpgradeCap',
    );

    const createVaultResult = runSuiJson<SuiCommandResult>(
      [
        'client',
        '--client.config',
        clientConfig,
        '--json',
        'call',
        '--package',
        packageId,
        '--module',
        'vault',
        '--function',
        'create_vault',
        '--args',
        config.ownerAddress,
        vectorArg(hexToBytes(config.solverPublicKey)),
        vectorArg(stringToBytes(config.domain)),
        '--gas-budget',
        config.gasBudget,
      ],
      { env, label: 'create shared RFQ vault' },
    );
    const vaultId = findCreatedObjectId(createVaultResult, '::vault::Vault');
    if (!vaultId) {
      throw new Error(
        'Shared RFQ vault object ID not found in create_vault result',
      );
    }

    if (config.verifySource) {
      runSui(
        [
          'client',
          '--client.config',
          clientConfig,
          '--json',
          'verify-source',
          packagePath,
          '--address-override',
          packageId,
          '--verify-deps',
        ],
        { env, label: 'verify published source' },
      );
    }

    const filePath = await persistDeployment(config.stage, {
      SuiRFQVaultPackage: packageId,
      SuiRFQVault: vaultId,
      SuiRFQVaultUpgradeCap: upgradeCapId,
      SuiRFQVaultPublishTx: publishResult.digest,
      SuiRFQVaultCreateTx: createVaultResult.digest,
      SuiRFQVaultOwner: config.ownerAddress,
      SuiRFQVaultSolverPublicKey: config.solverPublicKey,
      SuiRFQVaultDomain: config.domain,
      SuiRFQVaultNetworkAlias: config.networkAlias,
    });

    console.log('');
    console.log('Sui RFQ vault deployed');
    console.log(`Package:     ${packageId}`);
    console.log(`Vault:       ${vaultId}`);
    if (upgradeCapId) {
      console.log(`UpgradeCap:  ${upgradeCapId}`);
    }
    console.log(`Deployment:  ${filePath}`);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
