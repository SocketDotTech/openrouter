/**
 * Deployment script for MathManipulator via CreateX CREATE3.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployMathManipulator.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY - deployer wallet private key
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  MATH_MANIPULATOR_CREATE3_SALT,
  MATH_MANIPULATOR_EXPECTED_ADDRESS,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import { writeManipulatorAddress } from './manipulatorAddresses';

async function persist(network: string): Promise<void> {
  const filePath = await writeManipulatorAddress(
    network,
    'MathManipulator',
    MATH_MANIPULATOR_EXPECTED_ADDRESS,
  );
  console.log('Deployment JSON:', filePath);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;

  console.log('Deployer:  ', deployer.address);
  console.log('Network:   ', networkName);
  console.log('');

  const existingBytecode = await ethers.provider.getCode(
    MATH_MANIPULATOR_EXPECTED_ADDRESS,
  );
  if (hasContractBytecode(existingBytecode)) {
    console.log(
      `MathManipulator already deployed on ${networkName} at ${MATH_MANIPULATOR_EXPECTED_ADDRESS}`,
    );
    await persist(networkName);
    return;
  }

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );
  const factory = await ethers.getContractFactory('MathManipulator');
  const deployTransaction = await factory.getDeployTransaction();
  if (!deployTransaction.data) {
    throw new Error('MathManipulator deployment bytecode is empty');
  }

  const deployAddress = await create3Factory.deployCreate3.staticCall(
    MATH_MANIPULATOR_CREATE3_SALT,
    deployTransaction.data,
  );
  if (
    deployAddress.toLowerCase() !==
    MATH_MANIPULATOR_EXPECTED_ADDRESS.toLowerCase()
  ) {
    throw new Error(
      `CREATE3 address ${deployAddress} does not match expected ${MATH_MANIPULATOR_EXPECTED_ADDRESS}`,
    );
  }
  console.log('Contract address will be:', deployAddress);

  const deployment = await create3Factory.deployCreate3(
    MATH_MANIPULATOR_CREATE3_SALT,
    deployTransaction.data,
  );
  console.log('CREATE3 deployment tx:', deployment.hash);
  const receipt = await deployment.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`MathManipulator deployment failed: ${deployment.hash}`);
  }

  const deployedAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (
    !deployedAddress ||
    deployedAddress.toLowerCase() !==
      MATH_MANIPULATOR_EXPECTED_ADDRESS.toLowerCase()
  ) {
    throw new Error(
      `MathManipulator receipt address ${deployedAddress}, expected ${MATH_MANIPULATOR_EXPECTED_ADDRESS}`,
    );
  }

  console.log('MathManipulator deployed to:', deployedAddress);
  await persist(networkName);

  const skipVerify = process.env.SKIP_VERIFY?.trim().toLowerCase() === 'true';
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n && !skipVerify) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await hre.run('verify:verify', {
      address: deployedAddress,
      constructorArguments: [],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
