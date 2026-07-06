/**
 * Deployment script for EtherealExecutor via CreateX CREATE3.
 *
 * Deploy on Ethereal only — the sole destination chain USDe deposits into ExchangeGateway.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployEtherealExecutor.ts --network ethereal
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key
 *
 * Optional env vars:
 *   OWNER_ADDRESS  — EtherealExecutor owner/EXECUTOR_ROLE holder; defaults to DEFAULT_OWNER_ADDRESS or deployer
 *   RESCUE_ADDRESS — RESCUE_ROLE holder; defaults to the resolved owner address
 */

import hre, { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  ETHEREAL_EXECUTOR_CREATE3_SALT,
  ETHEREAL_EXECUTOR_CREATE3_SALT_TEXT,
  CALLDATA_EXECUTOR_EXPECTED_ADDRESS,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import { findDeploymentRegistryRow } from './deploymentRegistry';
import { writeEtherealExecutorAddress } from './etherealExecutorAddresses';
import { ETHEREAL_EXECUTOR_CHAIN_CONFIG } from './etherealExecutorConfig';

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

async function getEtherealExecutorInitcode(params: {
  owner: string;
  rescueAddress: string;
  calldataExecutor: string;
  exchangeGateway: string;
  depositToken: string;
}): Promise<string> {
  const factory = await ethers.getContractFactory('EtherealExecutor');
  const deployTransaction = await factory.getDeployTransaction(
    params.owner,
    params.rescueAddress,
    params.calldataExecutor,
    params.exchangeGateway,
    params.depositToken,
  );

  if (!deployTransaction.data) {
    throw new Error('EtherealExecutor deploy transaction data is empty');
  }

  return deployTransaction.data;
}

async function assertEtherealExecutorDeployment(params: {
  address: string;
  owner: string;
  calldataExecutor: string;
  exchangeGateway: string;
  depositToken: string;
}): Promise<void> {
  const contract = new ethers.Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function CALLDATA_EXECUTOR() view returns (address)',
      'function exchangeGateway() view returns (address)',
      'function DEPOSIT_TOKEN() view returns (address)',
    ],
    ethers.provider,
  );

  const [owner, calldataExecutor, exchangeGateway, depositToken] = await Promise.all([
    contract.owner() as Promise<string>,
    contract.CALLDATA_EXECUTOR() as Promise<string>,
    contract.exchangeGateway() as Promise<string>,
    contract.DEPOSIT_TOKEN() as Promise<string>,
  ]);

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(`EtherealExecutor owner mismatch: expected ${params.owner}, got ${owner}`);
  }

  if (calldataExecutor.toLowerCase() !== params.calldataExecutor.toLowerCase()) {
    throw new Error(
      `EtherealExecutor CALLDATA_EXECUTOR mismatch: expected ${params.calldataExecutor}, got ${calldataExecutor}`,
    );
  }

  if (exchangeGateway.toLowerCase() !== params.exchangeGateway.toLowerCase()) {
    throw new Error(
      `EtherealExecutor exchangeGateway mismatch: expected ${params.exchangeGateway}, got ${exchangeGateway}`,
    );
  }

  if (depositToken.toLowerCase() !== params.depositToken.toLowerCase()) {
    throw new Error(
      `EtherealExecutor DEPOSIT_TOKEN mismatch: expected ${params.depositToken}, got ${depositToken}`,
    );
  }
}

function printBackendConfigSnippet(chainId: number, address: string): void {
  console.log('\n=== bungee-backend config snippet ===');
  console.log(
    'Update executorAddress in bungee-backend/src/modules/bungee-auto/constants.ts (ETHEREAL_DEPOSIT_CONFIG):',
  );
  console.log(`  [${chainId}]: '${address}',`);
}

async function persistEtherealExecutorAddress(params: {
  network: string;
  chainId: number;
  address: string;
}): Promise<void> {
  const filePath = await writeEtherealExecutorAddress(params.network, params.address);
  console.log('Deployment JSON:', filePath);
  printBackendConfigSnippet(params.chainId, params.address);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const chainConfig = ETHEREAL_EXECUTOR_CHAIN_CONFIG[chainId];
  if (!chainConfig) {
    throw new Error(`Chain ${chainId} is not configured for EtherealExecutor deployment`);
  }

  console.log('Deployer:     ', deployer.address);
  console.log('Network:      ', networkName);
  console.log('Chain ID:     ', chainId);
  console.log('CREATE3 salt: ', ETHEREAL_EXECUTOR_CREATE3_SALT_TEXT);
  console.log('');

  const owner = resolveOwnerAddress(deployer.address);
  const rescueAddress = resolveRescueAddress(owner);
  const calldataExecutor = resolveCalldataExecutorAddress(chainId);
  const { exchangeGateway, depositToken } = chainConfig;

  console.log('Owner:            ', owner);
  console.log('RescueAddress:    ', rescueAddress);
  console.log('CalldataExecutor: ', calldataExecutor);
  console.log('ExchangeGateway:  ', exchangeGateway);
  console.log('DepositToken:     ', depositToken);
  console.log('');

  const initcode = await getEtherealExecutorInitcode({
    owner,
    rescueAddress,
    calldataExecutor,
    exchangeGateway,
    depositToken,
  });

  const create3Factory = new ethers.Contract(CREATE_X_FACTORY, Create3ABI, deployer);

  const expectedAddress = (await create3Factory.deployCreate3.staticCall(
    ETHEREAL_EXECUTOR_CREATE3_SALT,
    initcode,
  )) as string;

  console.log('Expected address:', expectedAddress);

  const existingBytecode = await ethers.provider.getCode(expectedAddress);
  if (hasContractBytecode(existingBytecode)) {
    console.log(`EtherealExecutor already deployed at ${expectedAddress}`);
    await assertEtherealExecutorDeployment({
      address: expectedAddress,
      owner,
      calldataExecutor,
      exchangeGateway,
      depositToken,
    });
    await persistEtherealExecutorAddress({
      network: networkName,
      chainId,
      address: expectedAddress,
    });
    return;
  }

  console.log('Deploying EtherealExecutor via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    ETHEREAL_EXECUTOR_CREATE3_SALT,
    initcode,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const executorAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!executorAddress) {
    throw new Error('EtherealExecutor address not found in CREATE3 deployment receipt');
  }

  if (executorAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Deployed address ${executorAddress} does not match staticCall ${expectedAddress}`,
    );
  }

  await assertEtherealExecutorDeployment({
    address: executorAddress,
    owner,
    calldataExecutor,
    exchangeGateway,
    depositToken,
  });

  console.log('\n=== Deployment Summary ===');
  console.log(`EtherealExecutor (${networkName}): ${executorAddress}`);
  await persistEtherealExecutorAddress({
    network: networkName,
    chainId,
    address: executorAddress,
  });

  if (chainId !== 31337) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await hre.run('verify:verify', {
        address: executorAddress,
        constructorArguments: [owner, rescueAddress, calldataExecutor, exchangeGateway, depositToken],
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
