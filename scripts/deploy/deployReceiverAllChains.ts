/**
 * Deploys CalldataExecutor + BungeeReceiver on all OpenRouter chains.
 * Skips chains where both contracts are already deployed; logs and continues on failure.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployReceiverAllChains.ts
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *
 * Optional env:
 *   OWNER_ADDRESS         — BungeeReceiver owner (defaults to deployer)
 *   SOLVER_SIGNER_ADDRESS — BungeeReceiver SOLVER_SIGNER (defaults to deployer)
 *   MIN_BALANCE_WEI       — skip chains below this native balance (default: 10^15)
 *   DRY_RUN=true          — print plan only, do not send txs
 *   CHAINS=base,arbitrum  — comma-separated hardhat network names to limit scope
 *   PARALLELISM=6         — max chains deployed concurrently (default: 6)
 */

import { Wallet, formatEther } from 'ethers';
import { RECEIVER_DEPLOY_NETWORKS, ReceiverDeployNetwork } from './networks';
import {
  createNetworkProvider,
  deployReceiverOnNetwork,
  getReceiverChainStatus,
  resolveDeployerPrivateKey,
  resolveOwnerAddress,
  resolveSolverSignerAddress,
  writeReceiverDeploymentRegistryForNetwork,
} from './receiverDeployCore';

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

type NetworkRunResult = {
  deployed: number;
  skippedDeployed: number;
  skippedUnfunded: number;
  failed: number;
};

const EMPTY_RESULT: NetworkRunResult = {
  deployed: 0,
  skippedDeployed: 0,
  skippedUnfunded: 0,
  failed: 0,
};

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<NetworkRunResult>,
): Promise<NetworkRunResult[]> {
  let nextIndex = 0;
  const results = new Array<NetworkRunResult>(items.length);

  const workers = Array.from(
    { length: concurrency },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }

        results[index] = await worker(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results.map((result) => result ?? EMPTY_RESULT);
}

async function deployNetwork(params: {
  network: ReceiverDeployNetwork;
  deployerKey: string;
  walletAddress: string;
  owner: string;
  solverSigner: string;
  minBalanceWei: bigint;
  dryRun: boolean;
}): Promise<NetworkRunResult> {
  const {
    network,
    deployerKey,
    walletAddress,
    owner,
    solverSigner,
    minBalanceWei,
    dryRun,
  } = params;

  console.log(`--- ${network.name} (chainId=${network.chainId}) ---`);

  const status = await getReceiverChainStatus(network);
  if (status.error) {
    console.error(`  [${network.name}] RPC error: ${status.error}`);
    return { ...EMPTY_RESULT, failed: 1 };
  }

  if (status.executorDeployed && status.receiverDeployed) {
    console.log(`  [${network.name}] Skip: already fully deployed`);
    const registryPath = await writeReceiverDeploymentRegistryForNetwork(network);
    if (registryPath) {
      console.log(`  [${network.name}] Deployment CSV: ${registryPath}`);
    }
    return { ...EMPTY_RESULT, skippedDeployed: 1 };
  }

  const provider = createNetworkProvider(network);
  const balance = await provider.getBalance(walletAddress);
  if (balance < minBalanceWei) {
    console.log(
      `  [${network.name}] Skip: insufficient balance (${formatEther(balance)} native, need ${formatEther(minBalanceWei)})`,
    );
    if (status.executorDeployed || status.receiverDeployed) {
      const registryPath = await writeReceiverDeploymentRegistryForNetwork(network);
      if (registryPath) {
        console.log(`  [${network.name}] Deployment CSV: ${registryPath}`);
      }
    }
    return { ...EMPTY_RESULT, skippedUnfunded: 1 };
  }

  if (dryRun) {
    console.log(`  [${network.name}] Would deploy (DRY_RUN)`);
    return EMPTY_RESULT;
  }

  const result = await deployReceiverOnNetwork({
    network,
    deployerPrivateKey: deployerKey,
    owner,
    solverSigner,
  });

  if (result.error) {
    console.error(`  [${network.name}] Failed: ${result.error}`);
    return { ...EMPTY_RESULT, failed: 1 };
  }

  if (result.skipped) {
    console.log(`  [${network.name}] Done (was already deployed)`);
    return { ...EMPTY_RESULT, skippedDeployed: 1 };
  }

  console.log(`  [${network.name}] Done`);
  return { ...EMPTY_RESULT, deployed: 1 };
}

async function main() {
  const deployerKey = resolveDeployerPrivateKey();
  const wallet = new Wallet(deployerKey);
  const owner = resolveOwnerAddress(wallet.address);
  const solverSigner = resolveSolverSignerAddress(wallet.address);
  const minBalanceWei = BigInt(process.env.MIN_BALANCE_WEI?.trim() || '1000000000000000');
  const dryRun = process.env.DRY_RUN?.trim().toLowerCase() === 'true';
  const chainFilter = parseChainFilter();

  const networks = chainFilter
    ? RECEIVER_DEPLOY_NETWORKS.filter((n) => chainFilter.has(n.name.toLowerCase()))
    : [...RECEIVER_DEPLOY_NETWORKS];

  if (networks.length === 0) {
    throw new Error('No networks matched CHAINS filter');
  }

  const parallelism = resolveParallelism(networks.length);

  console.log(`Deployer:     ${wallet.address}`);
  console.log(`Owner:        ${owner}`);
  console.log(`SolverSigner: ${solverSigner}`);
  console.log(`Min balance:  ${formatEther(minBalanceWei)} native`);
  console.log(`Dry run:      ${dryRun}`);
  console.log(`Parallelism:  ${parallelism}`);
  console.log(`Chains:       ${networks.map((n) => n.name).join(', ')}`);
  console.log('');

  const results = await runWithConcurrency(
    networks,
    parallelism,
    (network) =>
      deployNetwork({
        network,
        deployerKey,
        walletAddress: wallet.address,
        owner,
        solverSigner,
        minBalanceWei,
        dryRun,
      }),
  );

  const summary = results.reduce<NetworkRunResult>(
    (acc, result) => ({
      deployed: acc.deployed + result.deployed,
      skippedDeployed: acc.skippedDeployed + result.skippedDeployed,
      skippedUnfunded: acc.skippedUnfunded + result.skippedUnfunded,
      failed: acc.failed + result.failed,
    }),
    EMPTY_RESULT,
  );

  console.log('');
  console.log(
    `Summary: ${summary.deployed} deployed, ${summary.skippedDeployed} already deployed, ${summary.skippedUnfunded} unfunded, ${summary.failed} failed`,
  );

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
