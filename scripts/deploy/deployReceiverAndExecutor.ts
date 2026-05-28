/**
 * Deploys CalldataExecutor and BungeeReceiver via CreateX CREATE3.
 *
 * Both contracts reference each other in their constructors (CalldataExecutor is wired with the
 * receiver's address; BungeeReceiver is wired with the executor's address). We resolve this by
 * pre-computing both CREATE3 addresses from the factory before deploying either contract, then
 * deploying in order: CalldataExecutor first (using pre-computed receiver address), then BungeeReceiver.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployReceiverAndExecutor.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — deployer wallet private key
 *
 * Optional env vars:
 *   OWNER_ADDRESS         — owner of BungeeReceiver (defaults to deployer)
 *   SOLVER_SIGNER_ADDRESS — initial SOLVER_SIGNER on BungeeReceiver (defaults to deployer)
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  BUNGEE_RECEIVER_CREATE3_SALT,
  CALLDATA_EXECUTOR_CREATE3_SALT,
  decodeCreate3DeploymentFromTxReceipt,
  getBungeeReceiverDeploymentStatus,
  getCalldataExecutorDeploymentStatus,
} from './create3';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const owner = process.env.OWNER_ADDRESS?.trim() || deployer.address;
  const solverSigner =
    process.env.SOLVER_SIGNER_ADDRESS?.trim() || deployer.address;

  console.log('Deployer:      ', deployer.address);
  console.log('Owner:         ', owner);
  console.log('SolverSigner:  ', solverSigner);
  console.log('Network:       ', networkName);
  console.log('');

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );

  // Pre-compute both CREATE3 addresses before deploying anything.
  // CREATE3 address is deterministic: f(salt, deployer) — no bytecode dependency.
  const receiverAddress = (await create3Factory.computeCreate3Address(
    BUNGEE_RECEIVER_CREATE3_SALT,
    deployer.address,
  )) as string;

  const executorAddress = (await create3Factory.computeCreate3Address(
    CALLDATA_EXECUTOR_CREATE3_SALT,
    deployer.address,
  )) as string;

  console.log('Pre-computed BungeeReceiver address:   ', receiverAddress);
  console.log('Pre-computed CalldataExecutor address: ', executorAddress);
  console.log('');

  // ── Deploy CalldataExecutor (wired with pre-computed receiver address) ──────

  const executorStatus = await getCalldataExecutorDeploymentStatus({
    provider: ethers.provider,
    address: executorAddress,
  });

  if (executorStatus.deployed) {
    console.log(
      `CalldataExecutor already deployed at ${executorAddress}, BUNGEE_RECEIVER=${executorStatus.bungeeReceiver}`,
    );
  } else {
    const executorFactory = await ethers.getContractFactory('CalldataExecutor');
    const executorDeployTx =
      await executorFactory.getDeployTransaction(receiverAddress);

    console.log('Deploying CalldataExecutor via CREATE3...');
    const executorDeployment = await create3Factory.deployCreate3(
      CALLDATA_EXECUTOR_CREATE3_SALT,
      executorDeployTx.data,
    );
    console.log('CREATE3 deployment tx:', executorDeployment.hash);

    const executorReceipt = await executorDeployment.wait();
    const deployedExecutorAddress = decodeCreate3DeploymentFromTxReceipt({
      receipt: executorReceipt,
    });
    if (!deployedExecutorAddress) {
      throw new Error('CalldataExecutor address not found in CREATE3 receipt');
    }
    console.log('CalldataExecutor deployed to:', deployedExecutorAddress);
  }

  // ── Deploy BungeeReceiver (wired with actual executor address) ───────────────

  const receiverStatus = await getBungeeReceiverDeploymentStatus({
    provider: ethers.provider,
    address: receiverAddress,
  });

  if (receiverStatus.deployed) {
    console.log(
      `BungeeReceiver already deployed at ${receiverAddress}, owner=${receiverStatus.owner}`,
    );
  } else {
    const receiverFactory = await ethers.getContractFactory('BungeeReceiver');
    const receiverDeployTx = await receiverFactory.getDeployTransaction(
      owner,
      solverSigner,
      executorAddress,
    );

    console.log('Deploying BungeeReceiver via CREATE3...');
    const receiverDeployment = await create3Factory.deployCreate3(
      BUNGEE_RECEIVER_CREATE3_SALT,
      receiverDeployTx.data,
    );
    console.log('CREATE3 deployment tx:', receiverDeployment.hash);

    const receiverReceipt = await receiverDeployment.wait();
    const deployedReceiverAddress = decodeCreate3DeploymentFromTxReceipt({
      receipt: receiverReceipt,
    });
    if (!deployedReceiverAddress) {
      throw new Error('BungeeReceiver address not found in CREATE3 receipt');
    }
    console.log('BungeeReceiver deployed to:', deployedReceiverAddress);
  }

  console.log('\n=== Deployment Summary ===');
  console.log(`CalldataExecutor: ${executorAddress}`);
  console.log(`BungeeReceiver:   ${receiverAddress}`);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 31337n) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await hre.run('verify:verify', {
        address: executorAddress,
        constructorArguments: [receiverAddress],
      });
      console.log('CalldataExecutor verified on block explorer');
    } catch (err) {
      console.warn(
        'CalldataExecutor verification failed (deployment succeeded):',
        err instanceof Error ? err.message : err,
      );
    }

    try {
      await hre.run('verify:verify', {
        address: receiverAddress,
        constructorArguments: [owner, solverSigner, executorAddress],
      });
      console.log('BungeeReceiver verified on block explorer');
    } catch (err) {
      console.warn(
        'BungeeReceiver verification failed (deployment succeeded):',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
