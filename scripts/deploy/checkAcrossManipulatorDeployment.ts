/**
 * Checks that AcrossERC20AmountManipulator is deployed on the current Hardhat network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkAcrossManipulatorDeployment.ts --network <network>
 *
 * Optional env:
 *   ACROSS_MANIPULATOR_ADDRESS — override expected CREATE3 address
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import { getAcrossManipulatorDeploymentStatus } from './create3';

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();

  const deployment = await getAcrossManipulatorDeploymentStatus({
    provider: ethers.provider,
  });

  if (!deployment.deployed) {
    console.error(
      `AcrossERC20AmountManipulator NOT deployed on ${networkName} (chainId=${chainId}) at ${deployment.address}`,
    );
    process.exit(1);
  }

  console.log(
    `AcrossERC20AmountManipulator deployed on ${networkName} (chainId=${chainId}) at ${deployment.address}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
