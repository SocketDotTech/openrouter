/**
 * Checks that CalldataExecutor is deployed on the current Hardhat network.
 * Address is derived from CREATE3 salt via CreateX (guarded salt + factory deployer).
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkCalldataExecutorDeployment.ts --network <network>
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import {
  BUNGEE_RECEIVER_EXPECTED_ADDRESS,
  CALLDATA_EXECUTOR_CREATE3_SALT,
  CREATE_X_FACTORY,
  Create3ABI,
  computeFinalAddress,
  getCalldataExecutorDeploymentStatus,
} from './create3';

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();

  const create3Factory = new Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    ethers.provider,
  );

  const executorAddress = await computeFinalAddress(
    CALLDATA_EXECUTOR_CREATE3_SALT,
    create3Factory,
  );

  const status = await getCalldataExecutorDeploymentStatus({
    provider: ethers.provider,
    address: executorAddress,
  });

  if (!status.deployed) {
    console.error(
      `CalldataExecutor NOT deployed on ${networkName} (chainId=${chainId}) at ${executorAddress}`,
    );
    process.exit(1);
  }

  if (
    status.bungeeReceiver?.toLowerCase() !==
    BUNGEE_RECEIVER_EXPECTED_ADDRESS.toLowerCase()
  ) {
    console.error(
      `CalldataExecutor BUNGEE_RECEIVER mismatch on ${networkName} (chainId=${chainId}): ` +
        `executor=${executorAddress}, expected receiver=${BUNGEE_RECEIVER_EXPECTED_ADDRESS}, got ${status.bungeeReceiver}`,
    );
    process.exit(1);
  }

  console.log(
    `CalldataExecutor deployed on ${networkName} (chainId=${chainId}) at ${executorAddress}, BUNGEE_RECEIVER=${status.bungeeReceiver}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
