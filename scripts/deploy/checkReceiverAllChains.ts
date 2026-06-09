/**
 * Checks BungeeReceiver + CalldataExecutor deployment status on all OpenRouter chains.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkReceiverAllChains.ts
 *
 * Optional env:
 *   OWNER_ADDRESS         — assert BungeeReceiver owner() matches
 *   SOLVER_SIGNER_ADDRESS — assert BungeeReceiver SOLVER_SIGNER() matches
 */

import {
  BUNGEE_RECEIVER_EXPECTED_ADDRESS,
  CALLDATA_EXECUTOR_EXPECTED_ADDRESS,
} from './create3';
import { RECEIVER_DEPLOY_NETWORKS } from './networks';
import { getReceiverChainStatus } from './receiverDeployCore';

async function main() {
  const expectedOwner = process.env.OWNER_ADDRESS?.trim();
  const expectedSolverSigner = process.env.SOLVER_SIGNER_ADDRESS?.trim();

  console.log(`Expected BungeeReceiver:   ${BUNGEE_RECEIVER_EXPECTED_ADDRESS}`);
  console.log(`Expected CalldataExecutor: ${CALLDATA_EXECUTOR_EXPECTED_ADDRESS}`);
  if (expectedOwner) {
    console.log(`Expected owner:          ${expectedOwner}`);
  }
  if (expectedSolverSigner) {
    console.log(`Expected SOLVER_SIGNER:    ${expectedSolverSigner}`);
  }
  console.log('');

  let fullyDeployed = 0;
  let partial = 0;
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

    const bothDeployed = status.executorDeployed && status.receiverDeployed;
    const wiringOk =
      !status.executorDeployed ||
      status.executorBungeeReceiver?.toLowerCase() ===
        BUNGEE_RECEIVER_EXPECTED_ADDRESS.toLowerCase();

    let ownerOk = true;
    if (expectedOwner && status.receiverDeployed) {
      ownerOk =
        status.receiverOwner?.toLowerCase() === expectedOwner.toLowerCase();
    }

    let solverOk = true;
    if (expectedSolverSigner && status.receiverDeployed) {
      solverOk =
        status.receiverSolverSigner?.toLowerCase() ===
        expectedSolverSigner.toLowerCase();
    }

    const configOk = wiringOk && ownerOk && solverOk;

    if (bothDeployed && configOk) {
      fullyDeployed++;
      console.log(
        `[OK ] ${network.name} (chainId=${network.chainId}) — deployed, owner=${status.receiverOwner}, solver=${status.receiverSolverSigner}`,
      );
    } else if (status.executorDeployed || status.receiverDeployed) {
      partial++;
      console.log(
        `[PARTIAL] ${network.name} (chainId=${network.chainId}) — executor=${status.executorDeployed}, receiver=${status.receiverDeployed}`,
      );
      if (!wiringOk) {
        mismatches++;
        console.log(
          `          executor BUNGEE_RECEIVER=${status.executorBungeeReceiver} (expected ${BUNGEE_RECEIVER_EXPECTED_ADDRESS})`,
        );
      }
      if (!ownerOk) {
        mismatches++;
        console.log(
          `          owner=${status.receiverOwner} (expected ${expectedOwner})`,
        );
      }
      if (!solverOk) {
        mismatches++;
        console.log(
          `          solver=${status.receiverSolverSigner} (expected ${expectedSolverSigner})`,
        );
      }
    } else {
      missing++;
      console.log(`[MISSING] ${network.name} (chainId=${network.chainId})`);
    }
  }

  console.log('');
  console.log(
    `Summary: ${fullyDeployed} fully deployed, ${partial} partial, ${missing} missing, ${mismatches} config mismatches, ${errors} RPC errors`,
  );

  if (partial > 0 || missing > 0 || mismatches > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
