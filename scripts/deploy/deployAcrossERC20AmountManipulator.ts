/**
 * Deployment script for AcrossERC20AmountManipulator via CreateX CREATE3.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployAcrossERC20AmountManipulator.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY - deployer wallet private key
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import {
  ACROSS_MANIPULATOR_CREATE3_SALT,
  CREATE_X_FACTORY,
  Create3ABI,
  decodeCreate3DeploymentFromTxReceipt,
  getAcrossManipulatorDeploymentStatus,
} from './create3';
import { confirm } from '../utils';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;

  console.log('Deployer:  ', deployer.address);
  console.log('Network:   ', networkName);
  console.log('');

  const existing = await getAcrossManipulatorDeploymentStatus({
    provider: ethers.provider,
  });
  if (existing.deployed) {
    console.log(
      `AcrossERC20AmountManipulator already deployed on ${networkName} at ${existing.address}`,
    );
    return;
  }

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );

  const factory = await ethers.getContractFactory(
    'AcrossERC20AmountManipulator',
  );
  const deployTransaction = await factory.getDeployTransaction();

  const deployAddress = await create3Factory.deployCreate3.staticCall(
    ACROSS_MANIPULATOR_CREATE3_SALT,
    deployTransaction.data,
  );
  console.log('Contract address will be:', deployAddress);
  // await confirm('Are you sure you want to deploy? (y/n) ');

  console.log('Deploying AcrossERC20AmountManipulator via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    ACROSS_MANIPULATOR_CREATE3_SALT,
    deployTransaction.data,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const manipulatorAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!manipulatorAddress) {
    throw new Error(
      'AcrossERC20AmountManipulator address not found in CREATE3 deployment receipt',
    );
  }

  console.log('AcrossERC20AmountManipulator deployed to:', manipulatorAddress);

  console.log('\n=== Deployment Summary ===');
  console.log(`AcrossERC20AmountManipulator:  ${manipulatorAddress}`);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await hre.run('verify:verify', {
      address: manipulatorAddress,
      constructorArguments: [],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
