/**
 * Deployment script for RFQVaultExecutor via CreateX CREATE3.
 *
 * Deploy on any network configured in hardhat.config.ts.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployRFQVaultExecutor.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key
 *
 * Optional env vars:
 *   OWNER_ADDRESS — RFQVaultExecutor owner; defaults to DEFAULT_OWNER_ADDRESS or deployer
 *   SOLVER_SIGNER_ADDRESS — solver signer for fulfil/refund signatures; defaults to deployer
 */

import hre, { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  OPEN_ROUTER_EXPECTED_ADDRESS,
  RFQ_VAULT_EXECUTOR_CREATE3_SALT,
  RFQ_VAULT_EXECUTOR_CREATE3_SALT_TEXT,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import { findDeploymentRegistryRow } from './deploymentRegistry';
import { writeRFQVaultExecutorAddress } from './rfqVaultExecutorAddresses';

// =============================================================================
// Deployment config — fill DEFAULT_OWNER_ADDRESS before mainnet deploy
// =============================================================================

/** RFQVaultExecutor owner (admin). Override via OWNER_ADDRESS env at runtime. */
const DEFAULT_OWNER_ADDRESS = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;

function resolveOwnerAddress(deployerAddress: string): string {
  const envOwner = process.env.OWNER_ADDRESS?.trim();
  if (envOwner && ADDR_HEX_RE.test(envOwner)) {
    return envOwner;
  }

  if (DEFAULT_OWNER_ADDRESS && ADDR_HEX_RE.test(DEFAULT_OWNER_ADDRESS)) {
    return DEFAULT_OWNER_ADDRESS;
  }

  return deployerAddress;
}

function resolveSolverSignerAddress(deployerAddress: string): string {
  const envSolverSigner = process.env.SOLVER_SIGNER_ADDRESS?.trim();
  if (envSolverSigner && ADDR_HEX_RE.test(envSolverSigner)) {
    return envSolverSigner;
  }

  return deployerAddress;
}

function resolveOpenRouterAddress(chainId: number): string {
  const row = findDeploymentRegistryRow(chainId);
  const registryAddress = row?.openRouterAddress?.trim();
  if (registryAddress && ADDR_HEX_RE.test(registryAddress)) {
    return registryAddress;
  }

  return OPEN_ROUTER_EXPECTED_ADDRESS;
}

async function getRFQVaultExecutorInitcode(params: {
  owner: string;
  openRouter: string;
  solverSigner: string;
}): Promise<string> {
  const factory = await ethers.getContractFactory('RFQVaultExecutor');
  const deployTransaction = await factory.getDeployTransaction(
    params.owner,
    params.openRouter,
    params.solverSigner,
  );

  if (!deployTransaction.data) {
    throw new Error('RFQVaultExecutor deploy transaction data is empty');
  }

  return deployTransaction.data;
}

async function assertRFQVaultExecutorDeployment(params: {
  address: string;
  owner: string;
  openRouter: string;
  solverSigner: string;
}): Promise<void> {
  const contract = new ethers.Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function OPEN_ROUTER() view returns (address)',
      'function solverSigner() view returns (address)',
    ],
    ethers.provider,
  );

  const [owner, openRouter, solverSigner] = await Promise.all([
    contract.owner() as Promise<string>,
    contract.OPEN_ROUTER() as Promise<string>,
    contract.solverSigner() as Promise<string>,
  ]);

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(
      `RFQVaultExecutor owner mismatch: expected ${params.owner}, got ${owner}`,
    );
  }

  if (openRouter.toLowerCase() !== params.openRouter.toLowerCase()) {
    throw new Error(
      `RFQVaultExecutor OPEN_ROUTER mismatch: expected ${params.openRouter}, got ${openRouter}`,
    );
  }

  if (solverSigner.toLowerCase() !== params.solverSigner.toLowerCase()) {
    throw new Error(
      `RFQVaultExecutor solverSigner mismatch: expected ${params.solverSigner}, got ${solverSigner}`,
    );
  }
}

function printBackendConfigSnippet(chainId: number, address: string): void {
  console.log('\n=== bungee-backend config snippet (placeholder) ===');
  console.log('Add RFQVaultExecutor address when RFQ router config is introduced:');
  console.log(`  [${chainId}]: '${address}',`);
}

async function persistRFQVaultExecutorAddress(params: {
  network: string;
  chainId: number;
  address: string;
}): Promise<void> {
  const filePath = await writeRFQVaultExecutorAddress(
    params.network,
    params.address,
  );
  console.log('Deployment JSON:', filePath);
  printBackendConfigSnippet(params.chainId, params.address);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('Deployer:     ', deployer.address);
  console.log('Network:      ', networkName);
  console.log('Chain ID:     ', chainId);
  console.log('CREATE3 salt: ', RFQ_VAULT_EXECUTOR_CREATE3_SALT_TEXT);
  console.log('');

  const owner = resolveOwnerAddress(deployer.address);
  const openRouter = resolveOpenRouterAddress(chainId);
  const solverSigner = resolveSolverSignerAddress(deployer.address);

  console.log('Owner:        ', owner);
  console.log('OpenRouter:   ', openRouter);
  console.log('SolverSigner: ', solverSigner);
  console.log('');

  const initcode = await getRFQVaultExecutorInitcode({
    owner,
    openRouter,
    solverSigner,
  });

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );

  const expectedAddress = (await create3Factory.deployCreate3.staticCall(
    RFQ_VAULT_EXECUTOR_CREATE3_SALT,
    initcode,
  )) as string;

  console.log('Expected address:', expectedAddress);

  const existingBytecode = await ethers.provider.getCode(expectedAddress);
  if (hasContractBytecode(existingBytecode)) {
    console.log(`RFQVaultExecutor already deployed at ${expectedAddress}`);
    await assertRFQVaultExecutorDeployment({
      address: expectedAddress,
      owner,
      openRouter,
      solverSigner,
    });
    await persistRFQVaultExecutorAddress({
      network: networkName,
      chainId,
      address: expectedAddress,
    });
    return;
  }

  console.log('Deploying RFQVaultExecutor via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    RFQ_VAULT_EXECUTOR_CREATE3_SALT,
    initcode,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const executorAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!executorAddress) {
    throw new Error(
      'RFQVaultExecutor address not found in CREATE3 deployment receipt',
    );
  }

  if (executorAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Deployed address ${executorAddress} does not match staticCall ${expectedAddress}`,
    );
  }

  await assertRFQVaultExecutorDeployment({
    address: executorAddress,
    owner,
    openRouter,
    solverSigner,
  });

  console.log('\n=== Deployment Summary ===');
  console.log(`RFQVaultExecutor (${networkName}): ${executorAddress}`);
  await persistRFQVaultExecutorAddress({
    network: networkName,
    chainId,
    address: executorAddress,
  });

  if (chainId !== 31337) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await hre.run('verify:verify', {
      address: executorAddress,
      constructorArguments: [owner, openRouter, solverSigner],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
