/**
 * Checks that OpenRouter is deployed on the current Hardhat network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/checkOpenRouterDeployment.ts --network <network>
 *
 * Optional env:
 *   OPENROUTER_ADDRESS — override expected CREATE3 address
 *   OWNER_ADDRESS      — if set, assert `owner()` matches this address
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import { getOpenRouterDeploymentStatus } from './create3';

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await ethers.provider.getNetwork();

  const deployment = await getOpenRouterDeploymentStatus({
    provider: ethers.provider,
  });

  if (!deployment.deployed) {
    console.error(
      `OpenRouter NOT deployed on ${networkName} (chainId=${chainId}) at ${deployment.address}`,
    );
    process.exit(1);
  }

  const expectedOwner = process.env.OWNER_ADDRESS?.trim();
  if (
    expectedOwner &&
    deployment.owner?.toLowerCase() !== expectedOwner.toLowerCase()
  ) {
    console.error(
      `OpenRouter owner mismatch on ${networkName} (chainId=${chainId}): expected ${expectedOwner}, got ${deployment.owner}`,
    );
    process.exit(1);
  }

  console.log(
    `OpenRouter deployed on ${networkName} (chainId=${chainId}) at ${deployment.address}, owner=${deployment.owner}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
