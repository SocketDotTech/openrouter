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
  BUNGEE_RECEIVER_CREATE3_SALT,
  BUNGEE_RECEIVER_EXPECTED_ADDRESS,
  CALLDATA_EXECUTOR_CREATE3_SALT,
  CALLDATA_EXECUTOR_EXPECTED_ADDRESS,
  CREATE_X_FACTORY,
  Create3ABI,
  computeFinalAddress,
  decodeCreate3DeploymentFromTxReceipt,
  getBungeeReceiverDeploymentStatus,
  getCalldataExecutorDeploymentStatus,
} from './create3';
import { writeReceiverDeploymentRegistry } from './receiverDeployCore';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const registryNetwork = {
    name: networkName,
    chainId,
    rpcEnvKey: '',
    rpcFallback: '',
  };
  const owner = process.env.OWNER_ADDRESS?.trim() || deployer.address;
  const solverSigner =
    process.env.SOLVER_SIGNER_ADDRESS?.trim() || deployer.address;
  let executorInitcodeHash: string | undefined;
  let receiverInitcodeHash: string | undefined;

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

  // Pre-compute both CREATE3 addresses before deploying anything (no bytecode dependency).
  // Do not use computeCreate3Address(rawSalt, deployer.address): CreateX deployCreate3 runs
  // _guard(rawSalt) and resolves the address with the factory (_SELF) as deployer, not the EOA.
  // EOA as the second argument only applies when you operate your own CREATE3 factory.
  const receiverAddress = await computeFinalAddress(
    BUNGEE_RECEIVER_CREATE3_SALT,
    create3Factory,
  );
  const executorAddress = await computeFinalAddress(
    CALLDATA_EXECUTOR_CREATE3_SALT,
    create3Factory,
  );

  if (receiverAddress !== BUNGEE_RECEIVER_EXPECTED_ADDRESS) {
    throw new Error(
      `BungeeReceiver precomputed address mismatch: got ${receiverAddress}, expected ${BUNGEE_RECEIVER_EXPECTED_ADDRESS}`,
    );
  }
  if (executorAddress !== CALLDATA_EXECUTOR_EXPECTED_ADDRESS) {
    throw new Error(
      `CalldataExecutor precomputed address mismatch: got ${executorAddress}, expected ${CALLDATA_EXECUTOR_EXPECTED_ADDRESS}`,
    );
  }

  console.log('Pre-computed BungeeReceiver address:   ', receiverAddress);
  console.log('Pre-computed CalldataExecutor address: ', executorAddress);
  console.log('');

  // ── Deploy CalldataExecutor (wired with pre-computed receiver address) ──────

  const executorStatus = await getCalldataExecutorDeploymentStatus({
    provider: ethers.provider,
    address: executorAddress,
  });

  if (executorStatus.deployed) {
    if (
      executorStatus.bungeeReceiver?.toLowerCase() !==
      receiverAddress.toLowerCase()
    ) {
      throw new Error(
        `CalldataExecutor wiring mismatch at ${executorAddress}: ` +
          `BUNGEE_RECEIVER=${executorStatus.bungeeReceiver}, expected ${receiverAddress}`,
      );
    }
    console.log(
      `CalldataExecutor already deployed at ${executorAddress}, BUNGEE_RECEIVER=${executorStatus.bungeeReceiver}`,
    );
  } else {
    const executorFactory = await ethers.getContractFactory('CalldataExecutor');
    const executorDeployTx =
      await executorFactory.getDeployTransaction(receiverAddress);
    if (!executorDeployTx.data) {
      throw new Error('CalldataExecutor deploy transaction is missing data');
    }
    executorInitcodeHash = ethers.keccak256(executorDeployTx.data);

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

  const executorRegistryPath = await writeReceiverDeploymentRegistry({
    network: registryNetwork,
    provider: ethers.provider,
    receiverAddress,
    executorAddress,
    executorInitcodeHash,
  });
  if (executorRegistryPath) {
    console.log('Deployment CSV:', executorRegistryPath);
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
    const registryPath = await writeReceiverDeploymentRegistry({
      network: registryNetwork,
      provider: ethers.provider,
      receiverAddress,
      executorAddress,
    });
    if (registryPath) {
      console.log('Deployment CSV:', registryPath);
    }
  } else {
    const receiverFactory = await ethers.getContractFactory('BungeeReceiver');
    const receiverDeployTx = await receiverFactory.getDeployTransaction(
      owner,
      solverSigner,
      executorAddress,
    );
    if (!receiverDeployTx.data) {
      throw new Error('BungeeReceiver deploy transaction is missing data');
    }
    receiverInitcodeHash = ethers.keccak256(receiverDeployTx.data);

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

    const registryPath = await writeReceiverDeploymentRegistry({
      network: registryNetwork,
      provider: ethers.provider,
      receiverAddress,
      executorAddress,
      receiverInitcodeHash,
      executorInitcodeHash,
    });
    if (registryPath) {
      console.log('Deployment CSV:', registryPath);
    }
  }

  if (receiverAddress !== BUNGEE_RECEIVER_EXPECTED_ADDRESS) {
    throw new Error(
      `BungeeReceiver address mismatch after deploy: got ${receiverAddress}, expected ${BUNGEE_RECEIVER_EXPECTED_ADDRESS}`,
    );
  }
  if (executorAddress !== CALLDATA_EXECUTOR_EXPECTED_ADDRESS) {
    throw new Error(
      `CalldataExecutor address mismatch after deploy: got ${executorAddress}, expected ${CALLDATA_EXECUTOR_EXPECTED_ADDRESS}`,
    );
  }

  console.log('\n=== Deployment Summary ===');
  console.log(`CalldataExecutor: ${executorAddress}`);
  console.log(`BungeeReceiver:   ${receiverAddress}`);

  if (BigInt(chainId) !== 31337n) {
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
