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
import { allowanceHolderVariantForChain } from '../e2e/config';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  OPEN_ROUTER_CREATE3_SALT,
  OPEN_ROUTER_CREATE3_SALT_TEXT,
  decodeCreate3DeploymentFromTxReceipt,
  getOpenRouterDeploymentStatus,
} from './create3';
import { upsertDeploymentRegistryRow } from './deploymentRegistry';

type OpenRouterDeploymentStatus = 'deployed' | 'already_deployed';

function resolveOpenRouterVariant(chainId: number): 'cancun' | 'shanghai' {
  const evmVersion = process.env.OPENROUTER_EVM_VERSION?.trim();
  if (evmVersion === 'cancun' || evmVersion === 'shanghai') {
    return evmVersion;
  }

  return allowanceHolderVariantForChain(chainId);
}

async function writeOpenRouterDeploymentRegistry(manifest: {
  chainId: number;
  network: string;
  openRouter: string;
  status: OpenRouterDeploymentStatus;
  deployer?: string;
  create3Salt: string;
  create3SaltText: string;
  txHash?: string;
  blockNumber?: number;
  initcodeHash?: string;
  runtimeBytecodeHash?: string;
  updatedAt: string;
}): Promise<string> {
  return upsertDeploymentRegistryRow({
    chainId: manifest.chainId,
    variant: resolveOpenRouterVariant(manifest.chainId),
    openRouterAddress: manifest.openRouter,
    openRouterSalt: manifest.create3Salt,
    openRouterSaltText: manifest.create3SaltText,
    openRouterInitcodeHash: manifest.initcodeHash,
    openRouterRuntimeBytecodeHash: manifest.runtimeBytecodeHash,
  });
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('Deployer:  ', deployer.address);
  console.log('Network:   ', networkName);
  console.log('Chain ID:  ', chainId);
  console.log('');

  const existing = await getOpenRouterDeploymentStatus({
    provider: ethers.provider,
  });
  if (existing.deployed) {
    console.log(
      `OpenRouter already deployed on ${networkName} at ${existing.address}`,
    );
    const bytecode = await ethers.provider.getCode(existing.address);
    const registryPath = await writeOpenRouterDeploymentRegistry({
      chainId,
      network: networkName,
      openRouter: existing.address,
      status: 'already_deployed',
      deployer: deployer.address,
      create3Salt: OPEN_ROUTER_CREATE3_SALT,
      create3SaltText: OPEN_ROUTER_CREATE3_SALT_TEXT,
      runtimeBytecodeHash: ethers.keccak256(bytecode),
      updatedAt: new Date().toISOString(),
    });
    console.log('Deployment CSV:', registryPath);
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
  console.log('Expected address:        ', existing.address);

  if (deployAddress.toLowerCase() !== existing.address.toLowerCase()) {
    throw new Error(
      `CREATE3 staticCall returned ${deployAddress}, expected ${existing.address}`,
    );
  }

  console.log('Deploying OpenRouter via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    OPEN_ROUTER_CREATE3_SALT,
    deployTransaction.data,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `OpenRouter CREATE3 deployment failed: ${create3Deployment.hash}`,
    );
  }

  const routerAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!routerAddress) {
    throw new Error(
      'OpenRouter address not found in CREATE3 deployment receipt',
    );
  }

  if (routerAddress.toLowerCase() !== existing.address.toLowerCase()) {
    throw new Error(
      `OpenRouter CREATE3 receipt address ${routerAddress}, expected ${existing.address}`,
    );
  }

  const bytecode = await ethers.provider.getCode(existing.address);
  if (bytecode === '0x' || bytecode.length <= 2) {
    throw new Error(
      `OpenRouter deployment tx succeeded but no bytecode exists at ${existing.address}`,
    );
  }

  const registryPath = await writeOpenRouterDeploymentRegistry({
    chainId,
    network: networkName,
    openRouter: existing.address,
    status: 'deployed',
    deployer: deployer.address,
    create3Salt: OPEN_ROUTER_CREATE3_SALT,
    create3SaltText: OPEN_ROUTER_CREATE3_SALT_TEXT,
    txHash: create3Deployment.hash,
    blockNumber: receipt.blockNumber,
    initcodeHash: ethers.keccak256(deployTransaction.data),
    runtimeBytecodeHash: ethers.keccak256(bytecode),
    updatedAt: new Date().toISOString(),
  });

  console.log('OpenRouter deployed to:', routerAddress);

  console.log('\n=== Deployment Summary ===');
  console.log(`OpenRouter:  ${routerAddress}`);
  console.log(`Deployment CSV: ${registryPath}`);

  if (chainId !== 31337) {
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
