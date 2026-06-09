/**
 * Checks CalldataExecutor deployment status on all OpenRouter chains.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkCalldataExecutorAllChains.ts
 */

import {
  BUNGEE_RECEIVER_EXPECTED_ADDRESS,
  CALLDATA_EXECUTOR_EXPECTED_ADDRESS,
} from './create3';
import { RECEIVER_DEPLOY_NETWORKS } from './networks';
import { getReceiverChainStatus } from './receiverDeployCore';

async function main() {
  console.log(`Expected CalldataExecutor: ${CALLDATA_EXECUTOR_EXPECTED_ADDRESS}`);
  console.log(`Expected BUNGEE_RECEIVER:  ${BUNGEE_RECEIVER_EXPECTED_ADDRESS}`);
  console.log('');

  let deployed = 0;
  let missing = 0;
  let mismatches = 0;
  let errors = 0;

  for (const network of RECEIVER_DEPLOY_NETWORKS) {
    const status = await getReceiverChainStatus(network);

    if (status.error) {
      errors++;
      console.log(`[ERR] ${network.name} (chainId=${network.chainId}): ${status.error}`);
      continue;
    }

    if (!status.executorDeployed) {
      missing++;
      console.log(`[MISSING] ${network.name} (chainId=${network.chainId})`);
      continue;
    }

    const wiringOk =
      status.executorBungeeReceiver?.toLowerCase() ===
      BUNGEE_RECEIVER_EXPECTED_ADDRESS.toLowerCase();

    if (!wiringOk) {
      mismatches++;
      console.log(
        `[MISMATCH] ${network.name} (chainId=${network.chainId}) — BUNGEE_RECEIVER=${status.executorBungeeReceiver}, expected ${BUNGEE_RECEIVER_EXPECTED_ADDRESS}`,
      );
      continue;
    }

    deployed++;
    console.log(
      `[OK ] ${network.name} (chainId=${network.chainId}) — BUNGEE_RECEIVER=${status.executorBungeeReceiver}`,
    );
  }

  console.log('');
  console.log(
    `Summary: ${deployed} deployed, ${missing} missing, ${mismatches} wiring mismatches, ${errors} RPC errors`,
  );

  if (missing > 0 || mismatches > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
