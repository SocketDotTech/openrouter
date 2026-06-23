/**
 * Deploys RFQVaultExecutor on all receiver deployment chains via CreateX CREATE3.
 *
 * Usage:
 *   OWNER_ADDRESS=0x... SOLVER_SIGNER_ADDRESS=0x... npx ts-node scripts/deploy/deployRFQVaultExecutorAllChains.ts
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   OWNER_ADDRESS
 *   SOLVER_SIGNER_ADDRESS
 *
 * Optional env:
 *   DRY_RUN=true          — print plan only, do not send txs
 *   CHAINS=base,arbitrum  — comma-separated hardhat network names to limit scope
 *   PARALLELISM=6         — max chains deployed concurrently (default: 6)
 *   TX_WAIT_TIMEOUT_MS    — receipt wait timeout per tx (default: 10000)
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  formatEther,
  isAddress,
  keccak256,
} from 'ethers';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  RFQ_VAULT_EXECUTOR_CREATE3_SALT,
  RFQ_VAULT_EXECUTOR_CREATE3_SALT_TEXT,
  computeFinalAddress,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import {
  RECEIVER_DEPLOY_NETWORKS,
  ReceiverDeployNetwork,
  resolveRpcUrl,
} from './networks';
import { getDeploymentTransactionOverrides } from './transactionOverrides';
import { writeRFQVaultExecutorAddress } from './rfqVaultExecutorAddresses';

type NetworkRunResult = {
  deployed: number;
  alreadyDeployed: number;
  dryRun: number;
  failed: number;
};

type RFQVaultExecutorArtifact = {
  abi: unknown[];
  bytecode: {
    object?: string;
  };
};

const EMPTY_RESULT: NetworkRunResult = {
  deployed: 0,
  alreadyDeployed: 0,
  dryRun: 0,
  failed: 0,
};

const TX_WAIT_TIMEOUT_MS = Number(
  process.env.TX_WAIT_TIMEOUT_MS?.trim() || '10000',
);

function resolvePrivateKey(): string {
  const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY is required');
  }

  return key.startsWith('0x') ? key : `0x${key}`;
}

function resolveAddressEnv(name: string): string {
  const address = process.env[name]?.trim();
  if (!address) {
    throw new Error(`${name} is required`);
  }
  if (!isAddress(address)) {
    throw new Error(`Invalid ${name}: ${address}`);
  }
  if (address.toLowerCase() === ZeroAddress.toLowerCase()) {
    throw new Error(`${name} cannot be zero`);
  }

  return address;
}

function parseChainFilter(): Set<string> | null {
  const raw = process.env.CHAINS?.trim();
  if (!raw) {
    return null;
  }

  return new Set(
    raw
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function resolveParallelism(networkCount: number): number {
  const raw = process.env.PARALLELISM?.trim();
  if (!raw) {
    return Math.min(6, networkCount);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PARALLELISM must be a positive integer, got ${raw}`);
  }

  return Math.min(parsed, networkCount);
}

function createNetworkProvider(network: ReceiverDeployNetwork): JsonRpcProvider {
  return new JsonRpcProvider(resolveRpcUrl(network), network.chainId, {
    staticNetwork: true,
  });
}

async function loadRFQVaultExecutorInitcode(params: {
  owner: string;
  solverSigner: string;
}): Promise<{ initcode: string; initcodeHash: string }> {
  const artifactPath = resolve(
    process.cwd(),
    'out',
    'RFQVaultExecutor.sol',
    'RFQVaultExecutor.json',
  );
  const artifact = JSON.parse(
    await readFile(artifactPath, 'utf8'),
  ) as RFQVaultExecutorArtifact;
  const bytecode = artifact.bytecode.object;
  if (!bytecode || !bytecode.startsWith('0x')) {
    throw new Error(`Invalid RFQVaultExecutor bytecode in ${artifactPath}`);
  }

  const constructorArgs = AbiCoder.defaultAbiCoder()
    .encode(['address', 'address'], [params.owner, params.solverSigner])
    .slice(2);
  const initcode = `${bytecode}${constructorArgs}`;

  return { initcode, initcodeHash: keccak256(initcode) };
}

async function waitForReceiptWithTimeout<T extends { wait: () => Promise<unknown>; hash: string }>(
  transaction: T,
  label: string,
): Promise<unknown> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      transaction.wait(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `${label} transaction ${transaction.hash} was not mined within ${TX_WAIT_TIMEOUT_MS}ms`,
              ),
            ),
          TX_WAIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<NetworkRunResult>,
): Promise<NetworkRunResult[]> {
  let nextIndex = 0;
  const results = new Array<NetworkRunResult>(items.length);

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(workers);
  return results.map((result) => result ?? EMPTY_RESULT);
}

async function assertRFQVaultExecutorDeployment(params: {
  provider: JsonRpcProvider;
  address: string;
  owner: string;
  solverSigner: string;
}): Promise<void> {
  const contract = new Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function solverSigner() view returns (address)',
    ],
    params.provider,
  );

  const [owner, solverSigner] = (await Promise.all([
    contract.owner(),
    contract.solverSigner(),
  ])) as [string, string];

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(
      `RFQVaultExecutor owner mismatch: expected ${params.owner}, got ${owner}`,
    );
  }

  if (solverSigner.toLowerCase() !== params.solverSigner.toLowerCase()) {
    throw new Error(
      `RFQVaultExecutor solverSigner mismatch: expected ${params.solverSigner}, got ${solverSigner}`,
    );
  }
}

async function persistRFQVaultExecutorAddress(params: {
  network: ReceiverDeployNetwork;
  address: string;
}): Promise<void> {
  const filePath = await writeRFQVaultExecutorAddress(
    params.network.name,
    params.address,
  );
  console.log(`  [${params.network.name}] Deployment JSON: ${filePath}`);
}

async function deployNetwork(params: {
  network: ReceiverDeployNetwork;
  deployerPrivateKey: string;
  owner: string;
  solverSigner: string;
  initcode: string;
  dryRun: boolean;
}): Promise<NetworkRunResult> {
  const { network, deployerPrivateKey, owner, solverSigner, initcode, dryRun } =
    params;
  console.log(`--- ${network.name} (chainId=${network.chainId}) ---`);

  try {
    const provider = createNetworkProvider(network);
    const wallet = new Wallet(deployerPrivateKey, provider);
    const create3Factory = new Contract(
      CREATE_X_FACTORY,
      Create3ABI,
      wallet,
    );
    const expectedAddress = await computeFinalAddress(
      RFQ_VAULT_EXECUTOR_CREATE3_SALT,
      create3Factory,
    );
    const existingBytecode = await provider.getCode(expectedAddress);

    if (hasContractBytecode(existingBytecode)) {
      await assertRFQVaultExecutorDeployment({
        provider,
        address: expectedAddress,
        owner,
        solverSigner,
      });
      await persistRFQVaultExecutorAddress({
        network,
        address: expectedAddress,
      });
      console.log(`  [${network.name}] Already deployed: ${expectedAddress}`);
      return { ...EMPTY_RESULT, alreadyDeployed: 1 };
    }

    if (dryRun) {
      console.log(`  [${network.name}] Would deploy to ${expectedAddress}`);
      return { ...EMPTY_RESULT, dryRun: 1 };
    }

    const balance = await provider.getBalance(wallet.address);
    console.log(
      `  [${network.name}] Deploying RFQVaultExecutor to ${expectedAddress} (deployer balance ${formatEther(balance)})`,
    );
    const overrides = await getDeploymentTransactionOverrides({
      network,
      provider,
    });
    const tx = await create3Factory.deployCreate3(
      RFQ_VAULT_EXECUTOR_CREATE3_SALT,
      initcode,
      overrides,
    );
    console.log(`  [${network.name}] Tx: ${tx.hash}`);
    const receipt = await waitForReceiptWithTimeout(tx, 'RFQVaultExecutor');
    const deployedAddress = decodeCreate3DeploymentFromTxReceipt({
      receipt: receipt as Awaited<ReturnType<typeof tx.wait>>,
    });

    if (
      !deployedAddress ||
      deployedAddress.toLowerCase() !== expectedAddress.toLowerCase()
    ) {
      throw new Error(
        `RFQVaultExecutor address mismatch: got ${deployedAddress}, expected ${expectedAddress}`,
      );
    }

    await assertRFQVaultExecutorDeployment({
      provider,
      address: expectedAddress,
      owner,
      solverSigner,
    });
    await persistRFQVaultExecutorAddress({
      network,
      address: expectedAddress,
    });
    console.log(`  [${network.name}] Deployed`);
    return { ...EMPTY_RESULT, deployed: 1 };
  } catch (err) {
    console.error(
      `  [${network.name}] Failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...EMPTY_RESULT, failed: 1 };
  }
}

async function main() {
  const deployerPrivateKey = resolvePrivateKey();
  const deployer = new Wallet(deployerPrivateKey);
  const owner = resolveAddressEnv('OWNER_ADDRESS');
  const solverSigner = resolveAddressEnv('SOLVER_SIGNER_ADDRESS');
  const dryRun = process.env.DRY_RUN?.trim().toLowerCase() === 'true';
  const chainFilter = parseChainFilter();
  const networks = chainFilter
    ? RECEIVER_DEPLOY_NETWORKS.filter((n) =>
        chainFilter.has(n.name.toLowerCase()),
      )
    : [...RECEIVER_DEPLOY_NETWORKS];

  if (networks.length === 0) {
    throw new Error('No networks matched CHAINS filter');
  }

  const parallelism = resolveParallelism(networks.length);
  const { initcode, initcodeHash } = await loadRFQVaultExecutorInitcode({
    owner,
    solverSigner,
  });

  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Owner:          ${owner}`);
  console.log(`SolverSigner:   ${solverSigner}`);
  console.log(`CREATE3 salt:   ${RFQ_VAULT_EXECUTOR_CREATE3_SALT_TEXT}`);
  console.log(`Initcode hash:  ${initcodeHash}`);
  console.log(`Dry run:        ${dryRun}`);
  console.log(`Parallelism:    ${parallelism}`);
  console.log(`Chains:         ${networks.map((n) => n.name).join(', ')}`);
  console.log('');

  const results = await runWithConcurrency(
    networks,
    parallelism,
    (network) =>
      deployNetwork({
        network,
        deployerPrivateKey,
        owner,
        solverSigner,
        initcode,
        dryRun,
      }),
  );

  const summary = results.reduce<NetworkRunResult>(
    (acc, result) => ({
      deployed: acc.deployed + result.deployed,
      alreadyDeployed: acc.alreadyDeployed + result.alreadyDeployed,
      dryRun: acc.dryRun + result.dryRun,
      failed: acc.failed + result.failed,
    }),
    EMPTY_RESULT,
  );

  console.log('');
  console.log(
    `Summary: ${summary.deployed} deployed, ${summary.alreadyDeployed} already deployed, ${summary.dryRun} dry-run, ${summary.failed} failed`,
  );

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
