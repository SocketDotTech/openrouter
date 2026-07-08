/**
 * Citrea CREATE3 deployment dry run — validates addresses, bytecode, gas, and
 * staticCalls without broadcasting or prompting for confirmation.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/dryRunCitreaDeployment.ts --network citrea
 *   npx ts-node --transpile-only scripts/deploy/dryRunCitreaDeployment.ts
 *
 * Optional env:
 *   DRY_RUN_REFERENCE_CHAIN_ID — Cancun chain with live AH+OR (default: 1 / Ethereum)
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
dotenvConfig({ path: resolve(process.cwd(), '.env') });

import { ethers } from 'ethers';
import hre from 'hardhat';
import { CHAIN_IDS } from '../e2e/config';
import {
  ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  CREATE_X_FACTORY,
  Create3ABI,
  OPEN_ROUTER_CREATE3_SALT,
  OPEN_ROUTER_EXPECTED_ADDRESS,
  assertAddressMatchesExpected,
  assertCreateXFactoryDeployed,
  computeFinalAddress,
  hasContractBytecode,
} from './create3';
import {
  getAllowanceHolderDeploymentStatus,
  resolveAllowanceHolderDeploymentBytecode,
} from './allowanceHolderDeployment';
import {
  findDeploymentRegistryRow,
  type DeploymentRegistryRow,
} from './deploymentRegistry';
import { RECEIVER_DEPLOY_NETWORKS, resolveRpcUrl } from './networks';
import { prepareOpenRouterBuild } from './openRouterBuild';

const EXPECTED_DEPLOYER = '0x9d2e39976F405a4ca2E52eF9271b2C4090EE59b6';
const CHAIN_ID = 4114;
const DEFAULT_REFERENCE_CHAIN_ID = CHAIN_IDS.ETHEREUM;

/**
 * Ensures `actual` equals the hash recorded in `deployments.csv` for the
 * reference Cancun chain.
 */
function assertHashMatchesRegistry(params: {
  label: string;
  actual: string;
  expected?: string;
  referenceChainId: number;
}): void {
  if (!params.expected) {
    throw new Error(
      `${params.label} hash missing in deployments.csv for reference chainId=${params.referenceChainId}`,
    );
  }

  if (params.actual.toLowerCase() !== params.expected.toLowerCase()) {
    throw new Error(
      [
        `${params.label} hash mismatch vs deployments.csv reference chain ${params.referenceChainId}.`,
        `actual=${params.actual}`,
        `expected=${params.expected}`,
      ].join(' '),
    );
  }
}

/**
 * Loads live runtime bytecode from a deployed Cancun chain and verifies it
 * matches the registry hash at the canonical CREATE3 address.
 */
async function verifyReferenceChainRuntimeBytecode(params: {
  referenceChainId: number;
  registry: DeploymentRegistryRow;
}): Promise<void> {
  const referenceNetwork = RECEIVER_DEPLOY_NETWORKS.find(
    (network) => network.chainId === params.referenceChainId,
  );
  if (!referenceNetwork) {
    throw new Error(
      `No RPC config for reference chainId=${params.referenceChainId}`,
    );
  }

  const referenceRpc = resolveRpcUrl(referenceNetwork);
  const referenceProvider = new ethers.JsonRpcProvider(
    referenceRpc,
    params.referenceChainId,
  );

  console.log(
    `\n--- Cross-chain reference (chainId=${params.referenceChainId}, ${referenceNetwork.name}) ---`,
  );
  console.log('Reference RPC:', referenceRpc);

  if (params.registry.allowanceHolderAddress) {
    assertAddressMatchesExpected({
      label: 'Reference AllowanceHolder registry address',
      actual: params.registry.allowanceHolderAddress,
      expected: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
    });
  }

  if (params.registry.openRouterAddress) {
    assertAddressMatchesExpected({
      label: 'Reference OpenRouter registry address',
      actual: params.registry.openRouterAddress,
      expected: OPEN_ROUTER_EXPECTED_ADDRESS,
    });
  }

  const ahCode = await referenceProvider.getCode(
    ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  );
  if (!hasContractBytecode(ahCode)) {
    throw new Error(
      `Reference chain ${params.referenceChainId} has no AllowanceHolder bytecode at ${ALLOWANCE_HOLDER_EXPECTED_ADDRESS}`,
    );
  }

  const ahRuntimeHash = ethers.keccak256(ahCode);
  assertHashMatchesRegistry({
    label: 'Reference AllowanceHolder runtime bytecode',
    actual: ahRuntimeHash,
    expected: params.registry.allowanceHolderRuntimeBytecodeHash,
    referenceChainId: params.referenceChainId,
  });
  console.log('AllowanceHolder runtime hash:', ahRuntimeHash, 'OK');

  const orCode = await referenceProvider.getCode(OPEN_ROUTER_EXPECTED_ADDRESS);
  if (!hasContractBytecode(orCode)) {
    throw new Error(
      `Reference chain ${params.referenceChainId} has no OpenRouter bytecode at ${OPEN_ROUTER_EXPECTED_ADDRESS}`,
    );
  }

  const orRuntimeHash = ethers.keccak256(orCode);
  assertHashMatchesRegistry({
    label: 'Reference OpenRouter runtime bytecode',
    actual: orRuntimeHash,
    expected: params.registry.openRouterRuntimeBytecodeHash,
    referenceChainId: params.referenceChainId,
  });
  console.log('OpenRouter runtime hash:   ', orRuntimeHash, 'OK');
}

/**
 * Verifies Citrea deploy artifacts use the same initcode hashes recorded for
 * the reference Cancun deployment.
 */
function verifyCitreaArtifactsMatchReferenceRegistry(params: {
  referenceChainId: number;
  registry: DeploymentRegistryRow;
  ahInitcodeHash: string;
  orInitcodeHash: string;
}): void {
  console.log('\n--- Citrea artifact parity vs reference registry ---');

  assertHashMatchesRegistry({
    label: 'Citrea AllowanceHolder initcode',
    actual: params.ahInitcodeHash,
    expected: params.registry.allowanceHolderInitcodeHash,
    referenceChainId: params.referenceChainId,
  });
  console.log('AllowanceHolder initcode hash:', params.ahInitcodeHash, 'OK');

  assertHashMatchesRegistry({
    label: 'Citrea OpenRouter initcode',
    actual: params.orInitcodeHash,
    expected: params.registry.openRouterInitcodeHash,
    referenceChainId: params.referenceChainId,
  });
  console.log('OpenRouter initcode hash:   ', params.orInitcodeHash, 'OK');
}

async function main() {
  const rpc =
    process.env.CITREA_RPC ??
    hre.network.config.url ??
    'https://rpc.mainnet.citrea.xyz';
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID);
  const caller = ethers.Wallet.createRandom().connect(provider);
  const hasDeployerKey = Boolean(process.env.DEPLOYER_PRIVATE_KEY?.trim());

  console.log('=== Citrea deployment dry run ===');
  console.log('RPC:      ', rpc);
  console.log('Chain ID: ', CHAIN_ID);
  console.log('Deployer: ', EXPECTED_DEPLOYER);
  console.log('DEPLOYER_PRIVATE_KEY:', hasDeployerKey ? 'set' : 'MISSING');

  const balance = await provider.getBalance(EXPECTED_DEPLOYER);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  console.log('Balance:  ', ethers.formatEther(balance), 'cBTC');
  console.log('Gas price:', gasPrice.toString(), 'wei');

  await assertCreateXFactoryDeployed(provider);
  console.log('CreateX:  ', CREATE_X_FACTORY, 'OK');

  for (const [label, address] of [
    ['AllowanceHolder', ALLOWANCE_HOLDER_EXPECTED_ADDRESS],
    ['OpenRouter', OPEN_ROUTER_EXPECTED_ADDRESS],
  ] as const) {
    const code = await provider.getCode(address);
    const empty = code === '0x' || code.length <= 2;
    console.log(`${label} slot empty at ${address}:`, empty);
    if (!empty) {
      throw new Error(`${label} already deployed at canonical address`);
    }
  }

  const create3 = new ethers.Contract(CREATE_X_FACTORY, Create3ABI, caller);

  console.log('\n--- AllowanceHolder ---');
  const ahStatus = await getAllowanceHolderDeploymentStatus({
    provider,
    chainId: CHAIN_ID,
  });
  const ahDeployment = resolveAllowanceHolderDeploymentBytecode({
    chainId: CHAIN_ID,
  });
  assertAddressMatchesExpected({
    label: 'AllowanceHolder target',
    actual: ahStatus.address,
    expected: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  });
  console.log('Variant:  ', ahDeployment.variant);
  console.log('Initcode: ', ahDeployment.initcodeHash);
  if (
    ahDeployment.expectedInitcodeHash &&
    ahDeployment.initcodeHash.toLowerCase() !==
      ahDeployment.expectedInitcodeHash.toLowerCase()
  ) {
    throw new Error('AllowanceHolder initcode hash mismatch vs env');
  }

  const ahLocal = await computeFinalAddress(ahStatus.create3Salt, create3);
  assertAddressMatchesExpected({
    label: 'AllowanceHolder local CREATE3',
    actual: ahLocal,
    expected: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  });
  const ahStatic = await create3.deployCreate3.staticCall(
    ahStatus.create3Salt,
    ahDeployment.bytecode,
  );
  assertAddressMatchesExpected({
    label: 'AllowanceHolder staticCall',
    actual: ahStatic,
    expected: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  });
  console.log('staticCall:', ahStatic);

  const ahData = create3.interface.encodeFunctionData('deployCreate3', [
    ahStatus.create3Salt,
    ahDeployment.bytecode,
  ]);
  const ahGas = await provider.estimateGas({
    from: EXPECTED_DEPLOYER,
    to: CREATE_X_FACTORY,
    data: ahData,
  });
  const ahCost = ahGas * gasPrice;
  console.log('estimateGas:', ahGas.toString());
  console.log('cost:     ', ethers.formatEther(ahCost), 'cBTC');

  console.log('\n--- OpenRouter ---');
  const { config } = await prepareOpenRouterBuild('citrea');
  assertAddressMatchesExpected({
    label: 'OpenRouter build AllowanceHolder',
    actual: config.allowanceHolder,
    expected: ALLOWANCE_HOLDER_EXPECTED_ADDRESS,
  });
  console.log('Build EVM:', config.evmVersion);

  await hre.run('compile', { quiet: true });
  const factory = await hre.ethers.getContractFactory('OpenRouter');
  const deployTx = await factory.getDeployTransaction();
  if (!deployTx.data) {
    throw new Error('OpenRouter deploy transaction data missing');
  }

  const orLocal = await computeFinalAddress(OPEN_ROUTER_CREATE3_SALT, create3);
  assertAddressMatchesExpected({
    label: 'OpenRouter local CREATE3',
    actual: orLocal,
    expected: OPEN_ROUTER_EXPECTED_ADDRESS,
  });
  const orStatic = await create3.deployCreate3.staticCall(
    OPEN_ROUTER_CREATE3_SALT,
    deployTx.data,
  );
  assertAddressMatchesExpected({
    label: 'OpenRouter staticCall',
    actual: orStatic,
    expected: OPEN_ROUTER_EXPECTED_ADDRESS,
  });
  const orInitcodeHash = ethers.keccak256(deployTx.data);
  console.log('staticCall:', orStatic);
  console.log('initcode: ', orInitcodeHash);

  const referenceChainId = Number(
    process.env.DRY_RUN_REFERENCE_CHAIN_ID ?? DEFAULT_REFERENCE_CHAIN_ID,
  );
  const referenceRegistry = findDeploymentRegistryRow(referenceChainId);
  if (!referenceRegistry) {
    throw new Error(
      `No deployments.csv row for reference chainId=${referenceChainId}`,
    );
  }

  verifyCitreaArtifactsMatchReferenceRegistry({
    referenceChainId,
    registry: referenceRegistry,
    ahInitcodeHash: ahDeployment.initcodeHash,
    orInitcodeHash,
  });
  await verifyReferenceChainRuntimeBytecode({
    referenceChainId,
    registry: referenceRegistry,
  });

  const orData = create3.interface.encodeFunctionData('deployCreate3', [
    OPEN_ROUTER_CREATE3_SALT,
    deployTx.data,
  ]);
  const orGas = await provider.estimateGas({
    from: EXPECTED_DEPLOYER,
    to: CREATE_X_FACTORY,
    data: orData,
  });
  const orCost = orGas * gasPrice;
  console.log('estimateGas:', orGas.toString());
  console.log('cost:     ', ethers.formatEther(orCost), 'cBTC');

  const total = ahCost + orCost;
  const buffered = (total * 120n) / 100n;
  console.log('\n--- Totals ---');
  console.log('AH + OR cost:   ', ethers.formatEther(total), 'cBTC');
  console.log('+20% buffer:    ', ethers.formatEther(buffered), 'cBTC');
  if (balance < buffered) {
    throw new Error(
      `Insufficient balance: need ~${ethers.formatEther(buffered)} cBTC, have ${ethers.formatEther(balance)} cBTC`,
    );
  }

  if (!hasDeployerKey) {
    console.warn(
      '\nBLOCKER: set DEPLOYER_PRIVATE_KEY in .env for 0x9d2e39976F405a4ca2E52eF9271b2C4090EE59b6 before live deploy.',
    );
  }

  console.log('\n=== Dry run passed ===');
  console.log('AllowanceHolder ->', ALLOWANCE_HOLDER_EXPECTED_ADDRESS);
  console.log('OpenRouter        ->', OPEN_ROUTER_EXPECTED_ADDRESS);
  console.log('No transactions broadcast.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
