/**
 * Deployment script for CelerExecutor via CreateX CREATE3.
 *
 * Deploy on Celer direct-quote origin chains only (8 chains in CELER_EXECUTOR_CHAIN_CONFIG).
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployCelerExecutor.ts --network <network>
 *
 * Supported hardhat networks for Celer origin:
 *   ethereum, optimism, bsc, polygon, arbitrum, avalanche, base, linea
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key
 *
 * Optional env vars:
 *   OWNER_ADDRESS — CelerExecutor owner (refund admin); defaults to DEFAULT_OWNER_ADDRESS or deployer
 */

import hre, { ethers } from 'hardhat';
import {
  CELER_EXECUTOR_CREATE3_SALT,
  CELER_EXECUTOR_CREATE3_SALT_TEXT,
  CREATE_X_FACTORY,
  Create3ABI,
  OPEN_ROUTER_EXPECTED_ADDRESS,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import { findDeploymentRegistryRow } from './deploymentRegistry';
import { writeCelerExecutorAddress } from './celerExecutorAddresses';

// =============================================================================
// Deployment config — fill DEFAULT_OWNER_ADDRESS before mainnet deploy
// =============================================================================

/** CelerExecutor owner (refund admin). Override via OWNER_ADDRESS env at runtime. */
const DEFAULT_OWNER_ADDRESS = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';

/**
 * Per-chain cBridge router addresses (Celer MessageBus).
 * OpenRouter is resolved from deployments.csv per chainId.
 */
const CELER_EXECUTOR_CHAIN_CONFIG: Record<
  number,
  { name: string; cBridgeRouter: string }
> = {
  1: {
    name: 'ethereum',
    cBridgeRouter: '0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820',
  },
  10: {
    name: 'optimism',
    cBridgeRouter: '0x9D39Fc627A6d9d9F8C831c16995b209548cc3401',
  },
  56: {
    name: 'bsc',
    cBridgeRouter: '0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF',
  },
  137: {
    name: 'polygon',
    cBridgeRouter: '0x88DCDC47D2f83a99CF0000FDF667A468bB958a78',
  },
  42161: {
    name: 'arbitrum',
    cBridgeRouter: '0x1619DE6B6B20eD217a58d00f37B9d47C7663feca',
  },
  43114: {
    name: 'avalanche',
    cBridgeRouter: '0xef3c714c9425a8F3697A9C969Dc1af30ba82e5d4',
  },
  8453: {
    name: 'base',
    cBridgeRouter: '0x7d43AABC515C356145049227CeE54B608342c0ad',
  },
  59144: {
    name: 'linea',
    cBridgeRouter: '0x9B36f165baB9ebe611d491180418d8De4b8f3a1f',
  },
};

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

function resolveOpenRouterAddress(chainId: number): string {
  const row = findDeploymentRegistryRow(chainId);
  const registryAddress = row?.openRouterAddress?.trim();
  if (registryAddress && ADDR_HEX_RE.test(registryAddress)) {
    return registryAddress;
  }

  return OPEN_ROUTER_EXPECTED_ADDRESS;
}

async function getCelerExecutorInitcode(params: {
  owner: string;
  openRouter: string;
  cBridgeRouter: string;
}): Promise<string> {
  const factory = await ethers.getContractFactory('CelerExecutor');
  const deployTransaction = await factory.getDeployTransaction(
    params.owner,
    params.openRouter,
    params.cBridgeRouter,
  );

  if (!deployTransaction.data) {
    throw new Error('CelerExecutor deploy transaction data is empty');
  }

  return deployTransaction.data;
}

async function assertCelerExecutorDeployment(params: {
  address: string;
  owner: string;
  openRouter: string;
  cBridgeRouter: string;
}): Promise<void> {
  const contract = new ethers.Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function OPEN_ROUTER() view returns (address)',
      'function CELER_BRIDGE() view returns (address)',
    ],
    ethers.provider,
  );

  const [owner, openRouter, cBridge] = await Promise.all([
    contract.owner() as Promise<string>,
    contract.OPEN_ROUTER() as Promise<string>,
    contract.CELER_BRIDGE() as Promise<string>,
  ]);

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(
      `CelerExecutor owner mismatch: expected ${params.owner}, got ${owner}`,
    );
  }

  if (openRouter.toLowerCase() !== params.openRouter.toLowerCase()) {
    throw new Error(
      `CelerExecutor OPEN_ROUTER mismatch: expected ${params.openRouter}, got ${openRouter}`,
    );
  }

  if (cBridge.toLowerCase() !== params.cBridgeRouter.toLowerCase()) {
    throw new Error(
      `CelerExecutor CELER_BRIDGE mismatch: expected ${params.cBridgeRouter}, got ${cBridge}`,
    );
  }
}

function printBackendConfigSnippet(chainId: number, address: string): void {
  console.log('\n=== bungee-backend config snippet ===');
  console.log(
    'Update CELER_EXECUTOR_ADDRESSES in bungee-backend/src/modules/router/routers/staked/celer/celer.config.ts:',
  );
  console.log(`  [${chainId}]: '${address}',`);
}

async function persistCelerExecutorAddress(params: {
  network: string;
  chainId: number;
  address: string;
}): Promise<void> {
  const filePath = await writeCelerExecutorAddress(
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
  const chainConfig = CELER_EXECUTOR_CHAIN_CONFIG[chainId];

  console.log('Deployer:     ', deployer.address);
  console.log('Network:      ', networkName);
  console.log('Chain ID:     ', chainId);
  console.log('CREATE3 salt: ', CELER_EXECUTOR_CREATE3_SALT_TEXT);
  console.log('');

  if (!chainConfig) {
    throw new Error(
      `Chain ${chainId} is not a Celer origin chain. Supported chainIds: ${Object.keys(
        CELER_EXECUTOR_CHAIN_CONFIG,
      ).join(', ')}`,
    );
  }

  const owner = resolveOwnerAddress(deployer.address);
  const openRouter = resolveOpenRouterAddress(chainId);
  const { cBridgeRouter } = chainConfig;

  console.log('Owner:        ', owner);
  console.log('OpenRouter:   ', openRouter);
  console.log('cBridgeRouter:', cBridgeRouter);
  console.log('');

  const initcode = await getCelerExecutorInitcode({
    owner,
    openRouter,
    cBridgeRouter,
  });

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );

  const expectedAddress = (await create3Factory.deployCreate3.staticCall(
    CELER_EXECUTOR_CREATE3_SALT,
    initcode,
  )) as string;

  console.log('Expected address:', expectedAddress);

  const existingBytecode = await ethers.provider.getCode(expectedAddress);
  if (hasContractBytecode(existingBytecode)) {
    console.log(`CelerExecutor already deployed at ${expectedAddress}`);
    await assertCelerExecutorDeployment({
      address: expectedAddress,
      owner,
      openRouter,
      cBridgeRouter,
    });
    await persistCelerExecutorAddress({
      network: chainConfig.name,
      chainId,
      address: expectedAddress,
    });
    return;
  }

  console.log('Deploying CelerExecutor via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    CELER_EXECUTOR_CREATE3_SALT,
    initcode,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const executorAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!executorAddress) {
    throw new Error(
      'CelerExecutor address not found in CREATE3 deployment receipt',
    );
  }

  if (executorAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Deployed address ${executorAddress} does not match staticCall ${expectedAddress}`,
    );
  }

  await assertCelerExecutorDeployment({
    address: executorAddress,
    owner,
    openRouter,
    cBridgeRouter,
  });

  console.log('\n=== Deployment Summary ===');
  console.log(`CelerExecutor (${chainConfig.name}): ${executorAddress}`);
  await persistCelerExecutorAddress({
    network: chainConfig.name,
    chainId,
    address: executorAddress,
  });

  if (chainId !== 31337) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await hre.run('verify:verify', {
      address: executorAddress,
      constructorArguments: [owner, openRouter, cBridgeRouter],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
