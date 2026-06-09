/**
 * Deployment script for OpenRouter via CreateX CREATE3.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployOpenRouter.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  OPEN_ROUTER_CREATE3_SALT,
  decodeCreate3DeploymentFromTxReceipt,
  getOpenRouterDeploymentStatus,
} from './create3';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;

  console.log('Deployer:  ', deployer.address);
  console.log('Network:   ', networkName);
  console.log('');

  const existing = await getOpenRouterDeploymentStatus({
    provider: ethers.provider,
  });
  if (existing.deployed) {
    console.log(
      `OpenRouter already deployed on ${networkName} at ${existing.address}`,
    );
    return;
  }

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );

  const factory = await ethers.getContractFactory('OpenRouter');
  const deployTransaction = await factory.getDeployTransaction();

  const deployAddress = await create3Factory.deployCreate3.staticCall(
    OPEN_ROUTER_CREATE3_SALT,
    deployTransaction.data,
  );
  console.log('Contract address will be:', deployAddress);

  console.log('Deploying OpenRouter via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    OPEN_ROUTER_CREATE3_SALT,
    deployTransaction.data,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const routerAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!routerAddress) {
    throw new Error(
      'OpenRouter address not found in CREATE3 deployment receipt',
    );
  }

  console.log('OpenRouter deployed to:', routerAddress);

  console.log('\n=== Deployment Summary ===');
  console.log(`OpenRouter:  ${routerAddress}`);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await hre.run('verify:verify', {
        address: routerAddress,
        constructorArguments: [],
      });
      console.log('Contract verified on block explorer');
    } catch (err) {
      console.warn(
        'Contract verification failed (deployment succeeded):',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
