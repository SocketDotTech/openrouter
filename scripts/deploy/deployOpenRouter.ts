/**
 * Deployment script for OpenRouter.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployOpenRouter.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key

 */

import hre from 'hardhat';
import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;

  const owner = deployer.address;

  console.log('Deployer:  ', deployer.address);
  console.log('Owner:     ', owner);
  console.log('Network:   ', networkName);
  console.log('');

  console.log('Deploying OpenRouter...');
  const factory = await ethers.getContractFactory('OpenRouter');
  const router = await factory.deploy(owner);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log('OpenRouter deployed to:', routerAddress);

  console.log('\n=== Deployment Summary ===');
  console.log(`OpenRouter:  ${routerAddress}`);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n) {
    // sleep for 5secs before verification attempt
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // run verification
    await hre.run('verify:verify', {
      address: routerAddress,
      constructorArguments: [owner],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
