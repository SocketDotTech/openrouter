/**
 * Deployment script for an AllowanceHolder.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployAllowanceHolder.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY                          - deployer wallet private key
 *   ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE   - Cancun/EIP-1153 deployment bytecode
 *   ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE - Shanghai/no-TLOAD deployment bytecode
 *
 * Optional env vars:
 *   ALLOWANCE_HOLDER_ADDRESS              - expected holder for all chains
 *   ALLOWANCE_HOLDER_CHAIN_<chainId>      - expected holder for one chain
 *   ALLOWANCE_HOLDER_VARIANT              - cancun or shanghai override for all chains
 *   ALLOWANCE_HOLDER_VARIANT_CHAIN_<chainId> - variant override for one chain
 *   ALLOWANCE_HOLDER_CREATE3_SALT_TEXT  - optional CREATE3 salt label
 *   ALLOWANCE_HOLDER_CREATE3_SALT       - optional raw bytes32 CREATE3 salt
 *   ALLOWANCE_HOLDER_CANCUN_INITCODE_HASH - optional expected Cancun initcode hash
 *   ALLOWANCE_HOLDER_SHANGHAI_INITCODE_HASH - optional expected Shanghai initcode hash
 *
 * The configured AllowanceHolder address must match the CreateX-computed
 * CREATE3 address and the canonical Socket address
 * (`0x50c4E75a512F2A14A7b304787Adf79C4531A5909`).
 */

import hre from 'hardhat';
import { ethers } from 'hardhat';
import {
  ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  CREATE_X_FACTORY,
  Create3ABI,
  assertAddressMatchesExpected,
  assertCreateXFactoryDeployed,
  decodeCreate3DeploymentFromTxReceipt,
} from './create3';
import {
  getAllowanceHolderDeploymentStatus,
  resolveAllowanceHolderDeploymentBytecode,
  writeAllowanceHolderDeploymentRegistry,
} from './allowanceHolderDeployment';
import { confirmCreate3Deployment } from './deployConfirm';

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log('Deployer: ', deployer.address);
  console.log('Network:  ', networkName);
  console.log('Chain ID: ', chainId);
  console.log('');

  await assertCreateXFactoryDeployed(ethers.provider);

  const existing = await getAllowanceHolderDeploymentStatus({
    provider: ethers.provider,
    chainId,
  });

  if (existing.deployed) {
    console.log(
      `AllowanceHolder already deployed on ${networkName} at ${existing.address} (${existing.variant})`,
    );
    const registryPath = await writeAllowanceHolderDeploymentRegistry({
      chainId,
      network: networkName,
      allowanceHolder: existing.address,
      variant: existing.variant,
      status: 'already_deployed',
      deployer: deployer.address,
      create3Salt: existing.create3Salt,
      create3SaltText: existing.create3SaltText,
      runtimeBytecodeHash: existing.runtimeBytecodeHash,
      updatedAt: new Date().toISOString(),
    });
    console.log('Deployment CSV:', registryPath);
    return;
  }

  const deployment = resolveAllowanceHolderDeploymentBytecode({ chainId });
  console.log('AllowanceHolder variant:', deployment.variant);
  console.log('CREATE3 salt text:      ', existing.create3SaltText ?? '<raw>');
  console.log('CREATE3 salt:           ', existing.create3Salt);
  console.log('Initcode hash:         ', deployment.initcodeHash);
  if (!deployment.expectedInitcodeHash) {
    console.warn(
      'No expected initcode hash was set; set ALLOWANCE_HOLDER_*_INITCODE_HASH for reproducible deployments.',
    );
  }

  console.log('Expected AllowanceHolder:', existing.address);
  assertAddressMatchesExpected({
    label: 'AllowanceHolder',
    actual: existing.address,
    expected: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  });

  const create3Factory = new ethers.Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    deployer,
  );

  const deployAddress = await create3Factory.deployCreate3.staticCall(
    existing.create3Salt,
    deployment.bytecode,
  );
  console.log('CREATE3 address:        ', deployAddress);

  if (deployAddress.toLowerCase() !== existing.address.toLowerCase()) {
    throw new Error(
      `CREATE3 staticCall returned ${deployAddress}, expected ${existing.address}`,
    );
  }

  await confirmCreate3Deployment({
    contractLabel: 'AllowanceHolder',
    networkName,
    chainId,
    deployerAddress: deployer.address,
    expectedAddress: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
    create3Address: deployAddress,
    extraLines: [
      `Variant:          ${deployment.variant}`,
      `Initcode hash:    ${deployment.initcodeHash}`,
      `CREATE3 salt:     ${existing.create3Salt}`,
    ],
  });

  console.log('Deploying AllowanceHolder via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    existing.create3Salt,
    deployment.bytecode,
  );
  console.log('Deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `AllowanceHolder CREATE3 deployment failed: ${create3Deployment.hash}`,
    );
  }

  const allowanceHolderAddress = decodeCreate3DeploymentFromTxReceipt({
    receipt,
  });
  if (
    !allowanceHolderAddress ||
    allowanceHolderAddress.toLowerCase() !== existing.address.toLowerCase()
  ) {
    throw new Error(
      `AllowanceHolder CREATE3 receipt address ${allowanceHolderAddress}, expected ${existing.address}`,
    );
  }

  const bytecode = await ethers.provider.getCode(existing.address);
  if (bytecode === '0x' || bytecode.length <= 2) {
    throw new Error(
      `AllowanceHolder deployment tx succeeded but no bytecode exists at ${existing.address}`,
    );
  }

  const registryPath = await writeAllowanceHolderDeploymentRegistry({
    chainId,
    network: networkName,
    allowanceHolder: existing.address,
    variant: deployment.variant,
    status: 'deployed',
    deployer: deployer.address,
    create3Salt: existing.create3Salt,
    create3SaltText: existing.create3SaltText,
    txHash: create3Deployment.hash,
    blockNumber: receipt.blockNumber,
    initcodeHash: deployment.initcodeHash,
    runtimeBytecodeHash: ethers.keccak256(bytecode),
    updatedAt: new Date().toISOString(),
  });

  console.log('\n=== Deployment Summary ===');
  console.log(`AllowanceHolder: ${existing.address}`);
  console.log(`Variant:         ${deployment.variant}`);
  console.log(`Deployment CSV:  ${registryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
