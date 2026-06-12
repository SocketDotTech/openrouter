/**
 * Checks that the configured AllowanceHolder has bytecode on the current
 * Hardhat network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkAllowanceHolderDeployment.ts --network <network>
 *
 * Optional env vars:
 *   ALLOWANCE_HOLDER_ADDRESS            - override expected holder for all chains
 *   ALLOWANCE_HOLDER_CHAIN_<chainId>    - override expected holder for one chain
 *   ALLOWANCE_HOLDER_VARIANT            - cancun or shanghai override for all chains
 *   ALLOWANCE_HOLDER_VARIANT_CHAIN_<chainId> - variant override for one chain
 *   ALLOWANCE_HOLDER_CREATE3_SALT_TEXT  - optional CREATE3 salt label
 *   ALLOWANCE_HOLDER_CREATE3_SALT       - optional raw bytes32 CREATE3 salt
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import {
  getAllowanceHolderDeploymentStatus,
  writeAllowanceHolderDeploymentRegistry,
} from './allowanceHolderDeployment';

async function main() {
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const deployment = await getAllowanceHolderDeploymentStatus({
    provider: ethers.provider,
    chainId,
  });

  if (!deployment.deployed) {
    throw new Error(
      `AllowanceHolder NOT deployed on ${networkName} (chainId=${chainId}) at ${deployment.address}`,
    );
  }

  const registryPath = await writeAllowanceHolderDeploymentRegistry({
    chainId,
    network: networkName,
    allowanceHolder: deployment.address,
    variant: deployment.variant,
    create3Salt: deployment.create3Salt,
    create3SaltText: deployment.create3SaltText,
    status: 'checked',
    runtimeBytecodeHash: deployment.runtimeBytecodeHash,
    updatedAt: new Date().toISOString(),
  });

  console.log(
    `AllowanceHolder deployed on ${networkName} (chainId=${chainId}) at ${deployment.address} (${deployment.variant}, create3)`,
  );
  console.log(`Runtime bytecode hash: ${deployment.runtimeBytecodeHash}`);
  console.log(`Deployment CSV: ${registryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
