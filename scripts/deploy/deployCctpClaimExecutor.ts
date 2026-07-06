/**
 * Deployment script for CctpClaimExecutor via CreateX CREATE3.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deployCctpClaimExecutor.ts --network <network>
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY
 *   SOLVER_SIGNER_ADDRESS
 *
 * Optional env vars:
 *   OWNER_ADDRESS — defaults to DEFAULT_OWNER_ADDRESS or deployer
 */

import hre, { ethers } from 'hardhat';
import {
  CREATE_X_FACTORY,
  Create3ABI,
  CCTP_CLAIM_EXECUTOR_CREATE3_SALT,
  CCTP_CLAIM_EXECUTOR_CREATE3_SALT_TEXT,
  decodeCreate3DeploymentFromTxReceipt,
  hasContractBytecode,
} from './create3';
import { writeCctpClaimExecutorAddress } from './cctpClaimExecutorAddresses';
import { CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG } from './cctpClaimExecutorConfig';

const DEFAULT_OWNER_ADDRESS = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

function resolveSolverSignerAddress(): string {
  const envSolverSigner = process.env.SOLVER_SIGNER_ADDRESS?.trim();
  if (!envSolverSigner) {
    throw new Error('SOLVER_SIGNER_ADDRESS is required');
  }

  if (!ADDR_HEX_RE.test(envSolverSigner)) {
    throw new Error(`Invalid SOLVER_SIGNER_ADDRESS: ${envSolverSigner}`);
  }

  if (envSolverSigner.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('SOLVER_SIGNER_ADDRESS cannot be zero');
  }

  return envSolverSigner;
}

async function getCctpClaimExecutorInitcode(params: {
  owner: string;
  messageTransmitter: string;
  solverSigner: string;
  usdcAddress: string;
}): Promise<string> {
  const factory = await ethers.getContractFactory('CctpClaimExecutor');
  const deployTransaction = await factory.getDeployTransaction(
    params.owner,
    params.messageTransmitter,
    params.solverSigner,
    params.usdcAddress,
  );

  if (!deployTransaction.data) {
    throw new Error('CctpClaimExecutor deploy transaction data is empty');
  }

  return deployTransaction.data;
}

async function assertCctpClaimExecutorDeployment(params: {
  address: string;
  owner: string;
  messageTransmitter: string;
  solverSigner: string;
  usdcAddress: string;
}): Promise<void> {
  const contract = new ethers.Contract(
    params.address,
    [
      'function owner() view returns (address)',
      'function SOLVER_SIGNER() view returns (address)',
      'function MESSAGE_TRANSMITTER() view returns (address)',
      'function USDC() view returns (address)',
    ],
    ethers.provider,
  );

  const [owner, solverSigner, messageTransmitter, usdc] = await Promise.all([
    contract.owner() as Promise<string>,
    contract.SOLVER_SIGNER() as Promise<string>,
    contract.MESSAGE_TRANSMITTER() as Promise<string>,
    contract.USDC() as Promise<string>,
  ]);

  if (owner.toLowerCase() !== params.owner.toLowerCase()) {
    throw new Error(`CctpClaimExecutor owner mismatch: expected ${params.owner}, got ${owner}`);
  }

  if (solverSigner.toLowerCase() !== params.solverSigner.toLowerCase()) {
    throw new Error(
      `CctpClaimExecutor SOLVER_SIGNER mismatch: expected ${params.solverSigner}, got ${solverSigner}`,
    );
  }

  if (messageTransmitter.toLowerCase() !== params.messageTransmitter.toLowerCase()) {
    throw new Error(
      `CctpClaimExecutor MESSAGE_TRANSMITTER mismatch: expected ${params.messageTransmitter}, got ${messageTransmitter}`,
    );
  }

  if (usdc.toLowerCase() !== params.usdcAddress.toLowerCase()) {
    throw new Error(`CctpClaimExecutor USDC mismatch: expected ${params.usdcAddress}, got ${usdc}`);
  }
}

function printBackendConfigSnippet(chainId: number, address: string): void {
  console.log('\n=== bungee-backend / transmitter config snippet ===');
  console.log(`  [${chainId}]: '${address}',`);
}

async function persistCctpClaimExecutorAddress(params: {
  network: string;
  chainId: number;
  address: string;
}): Promise<void> {
  const filePath = await writeCctpClaimExecutorAddress(params.network, params.address);
  console.log('Deployment JSON:', filePath);
  printBackendConfigSnippet(params.chainId, params.address);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const networkName = hre.network.name;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const chainConfig = CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG[chainId];
  if (!chainConfig) {
    throw new Error(`Chain ${chainId} is not configured for CctpClaimExecutor deployment`);
  }

  console.log('Deployer:     ', deployer.address);
  console.log('Network:      ', networkName);
  console.log('Chain ID:     ', chainId);
  console.log('CREATE3 salt: ', CCTP_CLAIM_EXECUTOR_CREATE3_SALT_TEXT);
  console.log('');

  const owner = resolveOwnerAddress(deployer.address);
  const solverSigner = resolveSolverSignerAddress();

  console.log('Owner:              ', owner);
  console.log('SolverSigner:       ', solverSigner);
  console.log('MessageTransmitter: ', chainConfig.messageTransmitter);
  console.log('USDC:               ', chainConfig.usdcAddress);
  console.log('');

  const initcode = await getCctpClaimExecutorInitcode({
    owner,
    messageTransmitter: chainConfig.messageTransmitter,
    solverSigner,
    usdcAddress: chainConfig.usdcAddress,
  });

  const create3Factory = new ethers.Contract(CREATE_X_FACTORY, Create3ABI, deployer);

  const expectedAddress = (await create3Factory.deployCreate3.staticCall(
    CCTP_CLAIM_EXECUTOR_CREATE3_SALT,
    initcode,
  )) as string;

  console.log('Expected address:', expectedAddress);

  const existingBytecode = await ethers.provider.getCode(expectedAddress);
  if (hasContractBytecode(existingBytecode)) {
    console.log(`CctpClaimExecutor already deployed at ${expectedAddress}`);
    await assertCctpClaimExecutorDeployment({
      address: expectedAddress,
      owner,
      messageTransmitter: chainConfig.messageTransmitter,
      solverSigner,
      usdcAddress: chainConfig.usdcAddress,
    });
    await persistCctpClaimExecutorAddress({
      network: networkName,
      chainId,
      address: expectedAddress,
    });
    return;
  }

  console.log('Deploying CctpClaimExecutor via CREATE3...');
  const create3Deployment = await create3Factory.deployCreate3(
    CCTP_CLAIM_EXECUTOR_CREATE3_SALT,
    initcode,
  );
  console.log('CREATE3 deployment tx:', create3Deployment.hash);

  const receipt = await create3Deployment.wait();
  const executorAddress = decodeCreate3DeploymentFromTxReceipt({ receipt });
  if (!executorAddress) {
    throw new Error('CctpClaimExecutor address not found in CREATE3 deployment receipt');
  }

  if (executorAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Deployed address ${executorAddress} does not match staticCall ${expectedAddress}`,
    );
  }

  await assertCctpClaimExecutorDeployment({
    address: executorAddress,
    owner,
    messageTransmitter: chainConfig.messageTransmitter,
    solverSigner,
    usdcAddress: chainConfig.usdcAddress,
  });

  console.log('\n=== Deployment Summary ===');
  console.log(`CctpClaimExecutor (${networkName}): ${executorAddress}`);
  await persistCctpClaimExecutorAddress({
    network: networkName,
    chainId,
    address: executorAddress,
  });

  if (networkName === 'arc') {
    console.log(
      'Skipping post-deploy Hardhat verification for arc; run `npm run verify:cctp-claim-executor -- arc` to submit via Sourcify.',
    );
  } else if (chainId !== 31337) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      await hre.run('verify:verify', {
        address: executorAddress,
        constructorArguments: [
          owner,
          chainConfig.messageTransmitter,
          solverSigner,
          chainConfig.usdcAddress,
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
