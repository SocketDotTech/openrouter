/**
 * Deploys CctpClaimExecutor on all CCTP destination chains via CreateX CREATE3.
 *
 * Usage:
 *   OWNER_ADDRESS=0x... SOLVER_SIGNER_ADDRESS=0x... npx ts-node scripts/deploy/deployCctpClaimExecutorAllChains.ts
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   OWNER_ADDRESS
 *   SOLVER_SIGNER_ADDRESS
 *
 * Optional env:
 *   DRY_RUN=true
 *   CHAINS=base,arbitrum
 *   PARALLELISM=6
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
  CCTP_CLAIM_EXECUTOR_CREATE3_SALT,
  CCTP_CLAIM_EXECUTOR_CREATE3_SALT_TEXT,
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
import { writeCctpClaimExecutorAddress } from './cctpClaimExecutorAddresses';
import {
  CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG,
  CCTP_CLAIM_EXECUTOR_CHAIN_IDS,
} from './cctpClaimExecutorConfig';

type NetworkRunResult = {
  deployed: number;
  alreadyDeployed: number;
  dryRun: number;
  failed: number;
};

type CctpClaimExecutorArtifact = {
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

const TX_WAIT_TIMEOUT_MS = Number(process.env.TX_WAIT_TIMEOUT_MS?.trim() || '10000');

const DEFAULT_OWNER_ADDRESS = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';

function resolvePrivateKey(): string {
  const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY is required');
  }

  return key.startsWith('0x') ? key : `0x${key}`;
}

function resolveAddressEnv(name: string, fallback?: string): string {
  const address = process.env[name]?.trim() ?? fallback?.trim();
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

async function loadCctpClaimExecutorInitcode(params: {
  owner: string;
  messageTransmitter: string;
  solverSigner: string;
  usdcAddress: string;
}): Promise<string> {
  const artifactPath = resolve(
    process.cwd(),
    'out',
    'CctpClaimExecutor.sol',
    'CctpClaimExecutor.json',
  );
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as CctpClaimExecutorArtifact;
  const bytecode = artifact.bytecode.object;
  if (!bytecode || !bytecode.startsWith('0x')) {
    throw new Error(`Invalid CctpClaimExecutor bytecode in ${artifactPath}`);
  }

  const constructorArgs = AbiCoder.defaultAbiCoder()
    .encode(
      ['address', 'address', 'address', 'address'],
      [params.owner, params.messageTransmitter, params.solverSigner, params.usdcAddress],
    )
    .slice(2);

  return `${bytecode}${constructorArgs}`;
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

async function assertCctpClaimExecutorDeployment(params: {
  provider: JsonRpcProvider;
  address: string;
  owner: string;
  messageTransmitter: string;
  solverSigner: string;
  usdcAddress: string;
}): Promise<void> {
  const contract = new Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function SOLVER_SIGNER() view returns (address)',
      'function MESSAGE_TRANSMITTER() view returns (address)',
      'function USDC() view returns (address)',
    ],
    params.provider,
  );

  const [owner, solverSigner, messageTransmitter, usdc] = (await Promise.all([
    contract.owner(),
    contract.SOLVER_SIGNER(),
    contract.MESSAGE_TRANSMITTER(),
    contract.USDC(),
  ])) as [string, string, string, string];

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(`CctpClaimExecutor owner mismatch: expected ${params.owner}, got ${owner}`);
  }

  if (solverSigner.toLowerCase() !== params.solverSigner.toLowerCase()) {
    throw new Error(
      `CctpClaimExecutor SOLVER_SIGNER mismatch: expected ${params.solverSigner}, got ${solverSigner}`,
    );
  }

  if (messageTransmitter.toLowerCase() !== params.messageTransmitter.toLowerCase()) {
    throw new Error(
      `CctpClaimExecutor MESSAGE_TRANSMITTER mismatch: expected ${params.messageTransmitter}, got ${messageTransmitter}`,
    );
  }

  if (usdc.toLowerCase() !== params.usdcAddress.toLowerCase()) {
    throw new Error(`CctpClaimExecutor USDC mismatch: expected ${params.usdcAddress}, got ${usdc}`);
  }
}

async function deployNetwork(params: {
  network: ReceiverDeployNetwork;
  deployerPrivateKey: string;
  owner: string;
  solverSigner: string;
  dryRun: boolean;
}): Promise<NetworkRunResult> {
  const { network, deployerPrivateKey, owner, solverSigner, dryRun } = params;
  console.log(`--- ${network.name} (chainId=${network.chainId}) ---`);

  const chainConfig = CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG[network.chainId];
  if (!chainConfig) {
    console.log(`  [${network.name}] Skipped — not a CCTP destination chain`);
    return EMPTY_RESULT;
  }

  try {
    const initcode = await loadCctpClaimExecutorInitcode({
      owner,
      messageTransmitter: chainConfig.messageTransmitter,
      solverSigner,
      usdcAddress: chainConfig.usdcAddress,
    });

    const provider = createNetworkProvider(network);
    const wallet = new Wallet(deployerPrivateKey, provider);
    const create3Factory = new Contract(CREATE_X_FACTORY, Create3ABI, wallet);
    const expectedAddress = await computeFinalAddress(CCTP_CLAIM_EXECUTOR_CREATE3_SALT, create3Factory);
    const existingBytecode = await provider.getCode(expectedAddress);

    if (hasContractBytecode(existingBytecode)) {
      await assertCctpClaimExecutorDeployment({
        provider,
        address: expectedAddress,
        owner,
        messageTransmitter: chainConfig.messageTransmitter,
        solverSigner,
        usdcAddress: chainConfig.usdcAddress,
      });
      await writeCctpClaimExecutorAddress(network.name, expectedAddress);
      console.log(`  [${network.name}] Already deployed: ${expectedAddress}`);
      return { ...EMPTY_RESULT, alreadyDeployed: 1 };
    }

    if (dryRun) {
      console.log(`  [${network.name}] Would deploy to ${expectedAddress}`);
      return { ...EMPTY_RESULT, dryRun: 1 };
    }

    const balance = await provider.getBalance(wallet.address);
    console.log(`  [${network.name}] Deployer balance: ${formatEther(balance)} ETH`);

    const txOverrides = await getDeploymentTransactionOverrides({
      network,
      provider,
    });
    const create3Deployment = await create3Factory.deployCreate3(
      CCTP_CLAIM_EXECUTOR_CREATE3_SALT,
      initcode,
      txOverrides,
    );
    console.log(`  [${network.name}] CREATE3 tx: ${create3Deployment.hash}`);

    const receipt = await waitForReceiptWithTimeout(
      create3Deployment,
      network.name,
    );

    const executorAddress = decodeCreate3DeploymentFromTxReceipt({
      receipt: receipt as Awaited<ReturnType<typeof create3Deployment.wait>>,
    });
    if (!executorAddress) {
      throw new Error('CctpClaimExecutor address not found in CREATE3 receipt');
    }

    await assertCctpClaimExecutorDeployment({
      provider,
      address: executorAddress,
      owner,
      messageTransmitter: chainConfig.messageTransmitter,
      solverSigner,
      usdcAddress: chainConfig.usdcAddress,
    });

    await writeCctpClaimExecutorAddress(network.name, executorAddress);
    console.log(`  [${network.name}] Deployed: ${executorAddress}`);
    return { ...EMPTY_RESULT, deployed: 1 };
  } catch (err) {
    console.error(`  [${network.name}] FAILED:`, (err as Error).message);
    return { ...EMPTY_RESULT, failed: 1 };
  }
}

async function main() {
  const dryRun = process.env.DRY_RUN?.trim().toLowerCase() === 'true';
  const chainFilter = parseChainFilter();
  const deployerPrivateKey = resolvePrivateKey();
  const owner = resolveAddressEnv('OWNER_ADDRESS', DEFAULT_OWNER_ADDRESS);
  const solverSigner = resolveAddressEnv('SOLVER_SIGNER_ADDRESS');

  const networks = RECEIVER_DEPLOY_NETWORKS.filter(
    (network) =>
      CCTP_CLAIM_EXECUTOR_CHAIN_IDS.includes(network.chainId) &&
      (!chainFilter || chainFilter.has(network.name.toLowerCase())),
  );

  if (networks.length === 0) {
    throw new Error('No CCTP networks matched CHAINS filter');
  }

  const parallelism = resolveParallelism(networks.length);

  console.log('CctpClaimExecutor CREATE3 batch deploy');
  console.log('Salt:         ', CCTP_CLAIM_EXECUTOR_CREATE3_SALT_TEXT);
  console.log('Owner:        ', owner);
  console.log('SolverSigner: ', solverSigner);
  console.log('Networks:     ', networks.map((n) => n.name).join(', '));
  console.log('Parallelism:  ', parallelism);
  console.log('Dry run:      ', dryRun);
  console.log('');

  const results = await runWithConcurrency(networks, parallelism, (network) =>
    deployNetwork({ network, deployerPrivateKey, owner, solverSigner, dryRun }),
  );

  const totals = results.reduce(
    (acc, result) => ({
      deployed: acc.deployed + result.deployed,
      alreadyDeployed: acc.alreadyDeployed + result.alreadyDeployed,
      dryRun: acc.dryRun + result.dryRun,
      failed: acc.failed + result.failed,
    }),
    { deployed: 0, alreadyDeployed: 0, dryRun: 0, failed: 0 },
  );

  console.log('\n=== Batch summary ===');
  console.log(`Deployed:         ${totals.deployed}`);
  console.log(`Already deployed: ${totals.alreadyDeployed}`);
  console.log(`Dry run:          ${totals.dryRun}`);
  console.log(`Failed:           ${totals.failed}`);

  if (totals.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
