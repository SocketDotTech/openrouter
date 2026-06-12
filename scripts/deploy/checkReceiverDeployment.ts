/**
 * Checks that BungeeReceiver and CalldataExecutor are deployed on the current network.
 * Addresses are derived from CREATE3 salts via CreateX (guarded salt + factory deployer).
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkReceiverDeployment.ts --network <network>
 *
 * Optional env vars:
 *   OWNER_ADDRESS — if set, assert BungeeReceiver owner() matches this address
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import {
  BUNGEE_RECEIVER_CREATE3_SALT,
  CALLDATA_EXECUTOR_CREATE3_SALT,
  CREATE_X_FACTORY,
  Create3ABI,
  computeFinalAddress,
  getBungeeReceiverDeploymentStatus,
  getCalldataExecutorDeploymentStatus,
} from './create3';
import { writeReceiverDeploymentRegistry } from './receiverDeployCore';

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();
  const registryNetwork = {
    name: networkName,
    chainId: Number(chainId),
    rpcEnvKey: '',
    rpcFallback: '',
  };

  const create3Factory = new Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    ethers.provider,
  );

  // Do not use computeCreate3Address(rawSalt, eoa): CreateX uses guarded salt + factory deployer.
  const receiverAddress = await computeFinalAddress(
    BUNGEE_RECEIVER_CREATE3_SALT,
    create3Factory,
  );
  const executorAddress = await computeFinalAddress(
    CALLDATA_EXECUTOR_CREATE3_SALT,
    create3Factory,
  );

  let hasError = false;

  // ── Check CalldataExecutor ───────────────────────────────────────────────────

  const executorStatus = await getCalldataExecutorDeploymentStatus({
    provider: ethers.provider,
    address: executorAddress,
  });

  if (!executorStatus.deployed) {
    console.error(
      `CalldataExecutor NOT deployed on ${networkName} (chainId=${chainId}) at ${executorAddress}`,
    );
    hasError = true;
  } else {
    if (
      executorStatus.bungeeReceiver?.toLowerCase() !==
      receiverAddress.toLowerCase()
    ) {
      console.error(
        `CalldataExecutor BUNGEE_RECEIVER mismatch on ${networkName} (chainId=${chainId}): ` +
          `executor=${executorAddress}, expected receiver=${receiverAddress}, got ${executorStatus.bungeeReceiver}`,
      );
      hasError = true;
    } else {
      console.log(
        `CalldataExecutor deployed on ${networkName} (chainId=${chainId}) at ${executorAddress}, BUNGEE_RECEIVER=${executorStatus.bungeeReceiver}`,
      );
    }
  }

  // ── Check BungeeReceiver ─────────────────────────────────────────────────────

  const receiverStatus = await getBungeeReceiverDeploymentStatus({
    provider: ethers.provider,
    address: receiverAddress,
  });

  if (!receiverStatus.deployed) {
    console.error(
      `BungeeReceiver NOT deployed on ${networkName} (chainId=${chainId}) at ${receiverAddress}`,
    );
    hasError = true;
  } else {
    const expectedOwner = process.env.OWNER_ADDRESS?.trim();
    if (
      expectedOwner &&
      receiverStatus.owner?.toLowerCase() !== expectedOwner.toLowerCase()
    ) {
      console.error(
        `BungeeReceiver owner mismatch on ${networkName} (chainId=${chainId}): expected ${expectedOwner}, got ${receiverStatus.owner}`,
      );
      hasError = true;
    } else {
      console.log(
        `BungeeReceiver deployed on ${networkName} (chainId=${chainId}) at ${receiverAddress}, owner=${receiverStatus.owner}`,
      );
    }
  }

  if (executorStatus.deployed || receiverStatus.deployed) {
    const registryPath = await writeReceiverDeploymentRegistry({
      network: registryNetwork,
      provider: ethers.provider,
      receiverAddress,
      executorAddress,
    });
    if (registryPath) {
      console.log(`Deployment CSV: ${registryPath}`);
    }
  }

  if (hasError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
