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
 */

import { Wallet, formatEther } from 'ethers';
import { RECEIVER_DEPLOY_NETWORKS } from './networks';
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

  console.log(`Deployer:     ${wallet.address}`);
  console.log(`Owner:        ${owner}`);
  console.log(`SolverSigner: ${solverSigner}`);
  console.log(`Min balance:  ${formatEther(minBalanceWei)} native`);
  console.log(`Dry run:      ${dryRun}`);
  console.log(`Chains:       ${networks.map((n) => n.name).join(', ')}`);
  console.log('');

  let skippedDeployed = 0;
  let skippedUnfunded = 0;
  let deployed = 0;
  let failed = 0;

  for (const network of networks) {
    console.log(`--- ${network.name} (chainId=${network.chainId}) ---`);

    const status = await getReceiverChainStatus(network);
    if (status.error) {
      failed++;
      console.error(`  RPC error: ${status.error}`);
      continue;
    }

    if (status.executorDeployed && status.receiverDeployed) {
      skippedDeployed++;
      console.log('  Skip: already fully deployed');
      const registryPath = await writeReceiverDeploymentRegistryForNetwork(network);
      if (registryPath) {
        console.log(`  Deployment CSV: ${registryPath}`);
      }
      continue;
    }

    const provider = createNetworkProvider(network);
    const balance = await provider.getBalance(wallet.address);
    if (balance < minBalanceWei) {
      skippedUnfunded++;
      console.log(
        `  Skip: insufficient balance (${formatEther(balance)} native, need ${formatEther(minBalanceWei)})`,
      );
      if (status.executorDeployed || status.receiverDeployed) {
        const registryPath = await writeReceiverDeploymentRegistryForNetwork(network);
        if (registryPath) {
          console.log(`  Deployment CSV: ${registryPath}`);
        }
      }
      continue;
    }

    if (dryRun) {
      console.log('  Would deploy (DRY_RUN)');
      continue;
    }

    const result = await deployReceiverOnNetwork({
      network,
      deployerPrivateKey: deployerKey,
      owner,
      solverSigner,
    });

    if (result.error) {
      failed++;
      console.error(`  Failed: ${result.error}`);
    } else if (result.skipped) {
      skippedDeployed++;
      console.log('  Done (was already deployed)');
    } else {
      deployed++;
      console.log('  Done');
    }
  }

  console.log('');
  console.log(
    `Summary: ${deployed} deployed, ${skippedDeployed} already deployed, ${skippedUnfunded} unfunded, ${failed} failed`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
