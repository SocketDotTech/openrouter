/**
 * Checks that BungeeReceiver and CalldataExecutor are deployed on the current network.
 * Addresses are computed deterministically from the deployer address and CREATE3 salts —
 * no hardcoded address constants needed.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkReceiverDeployment.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_ADDRESS — address used to deploy the contracts (determines CREATE3 addresses)
 *
 * Optional env vars:
 *   OWNER_ADDRESS    — if set, assert BungeeReceiver owner() matches this address
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  BUNGEE_RECEIVER_CREATE3_SALT,
  CALLDATA_EXECUTOR_CREATE3_SALT,
  getBungeeReceiverDeploymentStatus,
  getCalldataExecutorDeploymentStatus,
} from './create3';

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();

  const deployerAddress = process.env.DEPLOYER_ADDRESS?.trim();
  if (!deployerAddress) {
    console.error('DEPLOYER_ADDRESS env var is required');
    process.exit(1);
  }

  const create3Factory = new Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    ethers.provider,
  );

  const receiverAddress = (await create3Factory.computeCreate3Address(
    BUNGEE_RECEIVER_CREATE3_SALT,
    deployerAddress,
  )) as string;

  const executorAddress = (await create3Factory.computeCreate3Address(
    CALLDATA_EXECUTOR_CREATE3_SALT,
    deployerAddress,
  )) as string;

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

  if (hasError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
