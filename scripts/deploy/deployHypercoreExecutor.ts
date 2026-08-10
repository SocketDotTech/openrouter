/**
 * Deployment script for HypercoreDepositExecutor via CreateX CREATE3.
 *
 * Deploy on HyperEVM only — the sole destination chain for the Hypercore deposit executor.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployHypercoreExecutor.ts --network hyperEvm
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key
 *
 * Optional env vars:
 *   OWNER_ADDRESS  — HypercoreDepositExecutor owner/EXECUTOR_ROLE holder; defaults to
 *                    DEFAULT_OWNER_ADDRESS or deployer
 *   RESCUE_ADDRESS — RESCUE_ROLE holder; defaults to the resolved owner address
 */

import hre, { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  HYPERCORE_EXECUTOR_CREATE3_SALT,
  HYPERCORE_EXECUTOR_CREATE3_SALT_TEXT,
  CALLDATA_EXECUTOR_EXPECTED_ADDRESS,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import { findDeploymentRegistryRow } from './deploymentRegistry';
import { writeHypercoreExecutorAddress } from './hypercoreExecutorAddresses';
import { HYPERCORE_EXECUTOR_CHAIN_CONFIG } from './hypercoreExecutorConfig';

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

function resolveRescueAddress(ownerAddress: string): string {
  const envRescue = process.env.RESCUE_ADDRESS?.trim();
  if (envRescue && ADDR_HEX_RE.test(envRescue)) {
    return envRescue;
  }

  return ownerAddress;
}

function resolveCalldataExecutorAddress(chainId: number): string {
  const row = findDeploymentRegistryRow(chainId);
  const registryAddress = row?.calldataExecutorAddress?.trim();
  if (registryAddress && ADDR_HEX_RE.test(registryAddress)) {
    return registryAddress;
  }

  return CALLDATA_EXECUTOR_EXPECTED_ADDRESS;
}

async function getHypercoreExecutorInitcode(params: {
  owner: string;
  rescueAddress: string;
  calldataExecutor: string;
  coreDepositWallet: string;
  depositToken: string;
}): Promise<string> {
  const factory = await ethers.getContractFactory('HypercoreDepositExecutor');
  const deployTransaction = await factory.getDeployTransaction(
    params.owner,
    params.rescueAddress,
    params.calldataExecutor,
    params.coreDepositWallet,
    params.depositToken,
  );

  if (!deployTransaction.data) {
    throw new Error('HypercoreDepositExecutor deploy transaction data is empty');
  }

  return deployTransaction.data;
}

async function assertHypercoreExecutorDeployment(params: {
  address: string;
  owner: string;
  calldataExecutor: string;
  coreDepositWallet: string;
  depositToken: string;
}): Promise<void> {
  const contract = new ethers.Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function CALLDATA_EXECUTOR() view returns (address)',
      'function coreDepositWallet() view returns (address)',
      'function DEPOSIT_TOKEN() view returns (address)',
    ],
    ethers.provider,
  );

  const [owner, calldataExecutor, coreDepositWallet, depositToken] =
    await Promise.all([
      contract.owner() as Promise<string>,
      contract.CALLDATA_EXECUTOR() as Promise<string>,
      contract.coreDepositWallet() as Promise<string>,
      contract.DEPOSIT_TOKEN() as Promise<string>,
    ]);

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(
      `HypercoreDepositExecutor owner mismatch: expected ${params.owner}, got ${owner}`,
    );
  }

  if (calldataExecutor.toLowerCase() !== params.calldataExecutor.toLowerCase()) {
    throw new Error(
      `HypercoreDepositExecutor CALLDATA_EXECUTOR mismatch: expected ${params.calldataExecutor}, got ${calldataExecutor}`,
    );
  }

  if (coreDepositWallet.toLowerCase() !== params.coreDepositWallet.toLowerCase()) {
    throw new Error(
      `HypercoreDepositExecutor coreDepositWallet mismatch: expected ${params.coreDepositWallet}, got ${coreDepositWallet}`,
    );
  }

  if (depositToken.toLowerCase() !== params.depositToken.toLowerCase()) {
    throw new Error(
      `HypercoreDepositExecutor DEPOSIT_TOKEN mismatch: expected ${params.depositToken}, got ${depositToken}`,
    );
  }
}

function printBackendConfigSnippet(chainId: number, address: string): void {
  console.log('\n=== bungee-backend config snippet ===');
  console.log(
    'Update executorAddress in bungee-backend/src/modules/bungee-auto/constants.ts (HYPERCORE_DEPOSIT_CONFIG):',
  );
  console.log(`  [${chainId}]: '${address}',`);
}

async function persistHypercoreExecutorAddress(params: {
  network: string;
  chainId: number;
  address: string;
}): Promise<void> {
  const filePath = await writeHypercoreExecutorAddress(
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

  const chainConfig = HYPERCORE_EXECUTOR_CHAIN_CONFIG[chainId];
  if (!chainConfig) {
    throw new Error(
      `Chain ${chainId} is not configured for HypercoreDepositExecutor deployment`,
    );
  }

  console.log('Deployer:         ', deployer.address);
  console.log('Network:          ', networkName);
  console.log('Chain ID:         ', chainId);
  console.log('CREATE3 salt:     ', HYPERCORE_EXECUTOR_CREATE3_SALT_TEXT);
  console.log('');

  const owner = resolveOwnerAddress(deployer.address);
  const rescueAddress = resolveRescueAddress(owner);
  const calldataExecutor = resolveCalldataExecutorAddress(chainId);
  const { coreDepositWallet, depositToken } = chainConfig;

  console.log('Owner:            ', owner);
  console.log('RescueAddress:    ', rescueAddress);
  console.log('CalldataExecutor: ', calldataExecutor);
  console.log('CoreDepositWallet:', coreDepositWallet);
  console.log('DepositToken:     ', depositToken);
  console.log('');

  const initcode = await getHypercoreExecutorInitcode({
    owner,
    rescueAddress,
    calldataExecutor,
    coreDepositWallet,
    depositToken,
  });

  const create3Factory = new ethers.Contract(CREATE_X_FACTORY, Create3ABI, deployer);

  const expectedAddress = (await create3Factory.deployCreate3.staticCall(
    HYPERCORE_EXECUTOR_CREATE3_SALT,
    initcode,
  )) as string;

  console.log('Expected address:', expectedAddress);

  const existingBytecode = await ethers.provider.getCode(expectedAddress);
  if (hasContractBytecode(existingBytecode)) {
    console.log(`HypercoreDepositExecutor already deployed at ${expectedAddress}`);
    await assertHypercoreExecutorDeployment({
      address: expectedAddress,
      owner,
      calldataExecutor,
      coreDepositWallet,
      depositToken,
    });
    await persistHypercoreExecutorAddress({
      network: networkName,
      chainId,
      address: expectedAddress,
    });
    return;
  }

  console.log('Deploying HypercoreDepositExecutor via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    HYPERCORE_EXECUTOR_CREATE3_SALT,
    initcode,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const executorAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!executorAddress) {
    throw new Error(
      'HypercoreDepositExecutor address not found in CREATE3 deployment receipt',
    );
  }

  if (executorAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Deployed address ${executorAddress} does not match staticCall ${expectedAddress}`,
    );
  }

  await assertHypercoreExecutorDeployment({
    address: executorAddress,
    owner,
    calldataExecutor,
    coreDepositWallet,
    depositToken,
  });

  console.log('\n=== Deployment Summary ===');
  console.log(`HypercoreDepositExecutor (${networkName}): ${executorAddress}`);
  await persistHypercoreExecutorAddress({
    network: networkName,
    chainId,
    address: executorAddress,
  });

  if (chainId !== 31337) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await hre.run('verify:verify', {
        address: executorAddress,
        constructorArguments: [
          owner,
          rescueAddress,
          calldataExecutor,
          coreDepositWallet,
          depositToken,
        ],
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
