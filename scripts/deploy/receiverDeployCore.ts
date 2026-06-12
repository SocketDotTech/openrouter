import { Contract, JsonRpcProvider, Provider, Wallet, keccak256 } from 'ethers';
import { ethers } from 'hardhat';
import { allowanceHolderVariantForChain } from '../e2e/config';
import {
  BUNGEE_RECEIVER_CREATE3_SALT,
  BUNGEE_RECEIVER_CREATE3_SALT_TEXT,
  BUNGEE_RECEIVER_EXPECTED_ADDRESS,
  CALLDATA_EXECUTOR_CREATE3_SALT,
  CALLDATA_EXECUTOR_CREATE3_SALT_TEXT,
  CALLDATA_EXECUTOR_EXPECTED_ADDRESS,
  CREATE_X_FACTORY,
  Create3ABI,
  computeFinalAddress,
  decodeCreate3DeploymentFromTxReceipt,
  getBungeeReceiverDeploymentStatus,
  getCalldataExecutorDeploymentStatus,
  hasContractBytecode,
} from './create3';
import { DeploymentRegistryRowUpdate, upsertDeploymentRegistryRow } from './deploymentRegistry';
import { ReceiverDeployNetwork, resolveRpcUrl } from './networks';
import {
  DeploymentTransactionOverrides,
  getDeploymentTransactionOverrides,
} from './transactionOverrides';

const TX_WAIT_TIMEOUT_MS = Number(
  process.env.TX_WAIT_TIMEOUT_MS?.trim() || '10000',
);
const FORCE_EXPLICIT_NONCE_CHAINS = new Set(
  (process.env.FORCE_EXPLICIT_NONCE_CHAINS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);
const BYTECODE_RETRY_MS = 1_000;
const BYTECODE_RETRIES = 20;

export type ReceiverChainStatus = {
  network: ReceiverDeployNetwork;
  executorDeployed: boolean;
  receiverDeployed: boolean;
  executorBungeeReceiver?: string;
  receiverOwner?: string;
  receiverSolverSigner?: string;
  error?: string;
};

export type ReceiverDeployResult = {
  network: ReceiverDeployNetwork;
  skipped: boolean;
  executorDeployed: boolean;
  receiverDeployed: boolean;
  error?: string;
};

export function resolveDeployerPrivateKey(): string {
  const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error('DEPLOYER_PRIVATE_KEY is required');
  }

  return key.startsWith('0x') ? key : `0x${key}`;
}

export function resolveOwnerAddress(deployerAddress: string): string {
  return process.env.OWNER_ADDRESS?.trim() || deployerAddress;
}

export function resolveSolverSignerAddress(deployerAddress: string): string {
  return process.env.SOLVER_SIGNER_ADDRESS?.trim() || deployerAddress;
}

export function createNetworkProvider(network: ReceiverDeployNetwork): JsonRpcProvider {
  return new JsonRpcProvider(resolveRpcUrl(network), network.chainId, {
    staticNetwork: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForReceiptWithTimeout<T extends { wait: () => Promise<unknown>; hash: string }>(
  transaction: T,
  label: string,
): Promise<unknown> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      transaction.wait(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `${label} transaction ${transaction.hash} was not mined within ${TX_WAIT_TIMEOUT_MS}ms`,
              ),
            ),
          TX_WAIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForContractBytecode(params: {
  provider: Provider;
  address: string;
  label: string;
}): Promise<void> {
  const { provider, address, label } = params;
  for (let attempt = 0; attempt < BYTECODE_RETRIES; attempt += 1) {
    const bytecode = await provider.getCode(address);
    if (hasContractBytecode(bytecode)) {
      return;
    }

    await sleep(BYTECODE_RETRY_MS);
  }

  throw new Error(`${label} bytecode not visible at ${address}`);
}

async function resolveReceiverAddresses(params: {
  provider: Provider;
}): Promise<{ receiverAddress: string; executorAddress: string }> {
  const create3Factory = new Contract(CREATE_X_FACTORY, Create3ABI, params.provider);

  const receiverAddress = await computeFinalAddress(
    BUNGEE_RECEIVER_CREATE3_SALT,
    create3Factory,
  );
  const executorAddress = await computeFinalAddress(
    CALLDATA_EXECUTOR_CREATE3_SALT,
    create3Factory,
  );

  return { receiverAddress, executorAddress };
}

export async function writeReceiverDeploymentRegistry(params: {
  network: ReceiverDeployNetwork;
  provider: Provider;
  receiverAddress: string;
  executorAddress: string;
  receiverInitcodeHash?: string;
  executorInitcodeHash?: string;
}): Promise<string | null> {
  const {
    network,
    provider,
    receiverAddress,
    executorAddress,
    receiverInitcodeHash,
    executorInitcodeHash,
  } = params;

  const [receiverBytecode, executorBytecode] = await Promise.all([
    provider.getCode(receiverAddress),
    provider.getCode(executorAddress),
  ]);

  const update: DeploymentRegistryRowUpdate = {
    chainId: network.chainId,
    variant: allowanceHolderVariantForChain(network.chainId),
  };

  if (hasContractBytecode(receiverBytecode)) {
    update.bungeeReceiverAddress = receiverAddress;
    update.bungeeReceiverSalt = BUNGEE_RECEIVER_CREATE3_SALT;
    update.bungeeReceiverSaltText = BUNGEE_RECEIVER_CREATE3_SALT_TEXT;
    update.bungeeReceiverInitcodeHash = receiverInitcodeHash;
    update.bungeeReceiverRuntimeBytecodeHash = keccak256(receiverBytecode);
  }

  if (hasContractBytecode(executorBytecode)) {
    update.calldataExecutorAddress = executorAddress;
    update.calldataExecutorSalt = CALLDATA_EXECUTOR_CREATE3_SALT;
    update.calldataExecutorSaltText = CALLDATA_EXECUTOR_CREATE3_SALT_TEXT;
    update.calldataExecutorInitcodeHash = executorInitcodeHash;
    update.calldataExecutorRuntimeBytecodeHash = keccak256(executorBytecode);
  }

  if (!update.bungeeReceiverAddress && !update.calldataExecutorAddress) {
    return null;
  }

  return upsertDeploymentRegistryRow(update);
}

export async function writeReceiverDeploymentRegistryForNetwork(
  network: ReceiverDeployNetwork,
): Promise<string | null> {
  const provider = createNetworkProvider(network);
  const { receiverAddress, executorAddress } = await resolveReceiverAddresses({
    provider,
  });

  return writeReceiverDeploymentRegistry({
    network,
    provider,
    receiverAddress,
    executorAddress,
  });
}

/**
 * Reads CalldataExecutor + BungeeReceiver deployment status on a single chain.
 */
export async function getReceiverChainStatus(
  network: ReceiverDeployNetwork,
): Promise<ReceiverChainStatus> {
  try {
    const provider = createNetworkProvider(network);
    const { receiverAddress, executorAddress } = await resolveReceiverAddresses({
      provider,
    });

    const [executorStatus, receiverStatus] = await Promise.all([
      getCalldataExecutorDeploymentStatus({ provider, address: executorAddress }),
      getBungeeReceiverDeploymentStatus({ provider, address: receiverAddress }),
    ]);

    let receiverSolverSigner: string | undefined;
    if (receiverStatus.deployed) {
      try {
        const receiver = new Contract(
          receiverAddress,
          ['function SOLVER_SIGNER() view returns (address)'],
          provider,
        );
        receiverSolverSigner = (await receiver.SOLVER_SIGNER()) as string;
      } catch {
        receiverSolverSigner = undefined;
      }
    }

    return {
      network,
      executorDeployed: executorStatus.deployed,
      receiverDeployed: receiverStatus.deployed,
      executorBungeeReceiver: executorStatus.bungeeReceiver,
      receiverOwner: receiverStatus.owner,
      receiverSolverSigner,
    };
  } catch (err) {
    return {
      network,
      executorDeployed: false,
      receiverDeployed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Deploys CalldataExecutor and BungeeReceiver on one chain via CreateX CREATE3.
 * Skips contracts that are already deployed; idempotent per chain.
 */
export async function deployReceiverOnNetwork(params: {
  network: ReceiverDeployNetwork;
  deployerPrivateKey: string;
  owner: string;
  solverSigner: string;
}): Promise<ReceiverDeployResult> {
  const { network, deployerPrivateKey, owner, solverSigner } = params;

  try {
    const provider = createNetworkProvider(network);
    const wallet = new Wallet(deployerPrivateKey, provider);
    const create3Factory = new Contract(CREATE_X_FACTORY, Create3ABI, wallet);
    let executorInitcodeHash: string | undefined;
    let receiverInitcodeHash: string | undefined;
    const [latestNonce, pendingNonce] = await Promise.all([
      provider.getTransactionCount(wallet.address, 'latest'),
      provider.getTransactionCount(wallet.address, 'pending'),
    ]);
    let nextNonce: number | undefined;
    const transactionOverrides = await getDeploymentTransactionOverrides({
      network,
      provider,
    });
    const forceExplicitNonce = FORCE_EXPLICIT_NONCE_CHAINS.has(
      network.name.toLowerCase(),
    );
    if (pendingNonce < latestNonce || forceExplicitNonce) {
      nextNonce = latestNonce;
      console.warn(
        `  [${network.name}] using explicit nonces from latest (latest=${latestNonce}, pending=${pendingNonce})`,
      );
    }

    const nextOverrides = (): DeploymentTransactionOverrides =>
      nextNonce === undefined
        ? transactionOverrides
        : { ...transactionOverrides, nonce: nextNonce++ };

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
        `BungeeReceiver address mismatch: got ${receiverAddress}, expected ${BUNGEE_RECEIVER_EXPECTED_ADDRESS}`,
      );
    }
    if (executorAddress !== CALLDATA_EXECUTOR_EXPECTED_ADDRESS) {
      throw new Error(
        `CalldataExecutor address mismatch: got ${executorAddress}, expected ${CALLDATA_EXECUTOR_EXPECTED_ADDRESS}`,
      );
    }

    const executorStatus = await getCalldataExecutorDeploymentStatus({
      provider,
      address: executorAddress,
    });

    if (executorStatus.deployed) {
      if (
        executorStatus.bungeeReceiver?.toLowerCase() !== receiverAddress.toLowerCase()
      ) {
        throw new Error(
          `CalldataExecutor wiring mismatch: BUNGEE_RECEIVER=${executorStatus.bungeeReceiver}, expected ${receiverAddress}`,
        );
      }
      console.log(`  [${network.name}] CalldataExecutor already deployed`);
    } else {
      const executorFactory = await ethers.getContractFactory('CalldataExecutor', wallet);
      const executorDeployTx =
        await executorFactory.getDeployTransaction(receiverAddress);
      if (!executorDeployTx.data) {
        throw new Error('CalldataExecutor deploy transaction is missing data');
      }
      executorInitcodeHash = keccak256(executorDeployTx.data);

      console.log(`  [${network.name}] Deploying CalldataExecutor...`);
      const executorDeployment = await create3Factory.deployCreate3(
        CALLDATA_EXECUTOR_CREATE3_SALT,
        executorDeployTx.data,
        nextOverrides(),
      );
      console.log(`  [${network.name}] CalldataExecutor tx: ${executorDeployment.hash}`);

      const executorReceipt = await waitForReceiptWithTimeout(
        executorDeployment,
        'CalldataExecutor',
      );
      const deployedExecutorAddress = decodeCreate3DeploymentFromTxReceipt({
        receipt: executorReceipt as Awaited<ReturnType<typeof executorDeployment.wait>>,
      });
      if (!deployedExecutorAddress) {
        throw new Error('CalldataExecutor address not found in CREATE3 receipt');
      }
      console.log(`  [${network.name}] CalldataExecutor deployed`);
      await waitForContractBytecode({
        provider,
        address: executorAddress,
        label: 'CalldataExecutor',
      });
    }

    const executorRegistryPath = await writeReceiverDeploymentRegistry({
      network,
      provider,
      receiverAddress,
      executorAddress,
      executorInitcodeHash,
    });
    if (executorRegistryPath) {
      console.log(`  [${network.name}] Deployment CSV: ${executorRegistryPath}`);
    }

    const receiverStatus = await getBungeeReceiverDeploymentStatus({
      provider,
      address: receiverAddress,
    });

    if (receiverStatus.deployed) {
      console.log(
        `  [${network.name}] BungeeReceiver already deployed, owner=${receiverStatus.owner}`,
      );
      const registryPath = await writeReceiverDeploymentRegistry({
        network,
        provider,
        receiverAddress,
        executorAddress,
      });
      if (registryPath) {
        console.log(`  [${network.name}] Deployment CSV: ${registryPath}`);
      }
      return {
        network,
        skipped: true,
        executorDeployed: true,
        receiverDeployed: true,
      };
    }

    const receiverFactory = await ethers.getContractFactory('BungeeReceiver', wallet);
    const receiverDeployTx = await receiverFactory.getDeployTransaction(
      owner,
      solverSigner,
      executorAddress,
    );
    if (!receiverDeployTx.data) {
      throw new Error('BungeeReceiver deploy transaction is missing data');
    }
    receiverInitcodeHash = keccak256(receiverDeployTx.data);

    console.log(`  [${network.name}] Deploying BungeeReceiver...`);
    const receiverDeployment = await create3Factory.deployCreate3(
      BUNGEE_RECEIVER_CREATE3_SALT,
      receiverDeployTx.data,
      nextOverrides(),
    );
    console.log(`  [${network.name}] BungeeReceiver tx: ${receiverDeployment.hash}`);

    const receiverReceipt = await waitForReceiptWithTimeout(
      receiverDeployment,
      'BungeeReceiver',
    );
    const deployedReceiverAddress = decodeCreate3DeploymentFromTxReceipt({
      receipt: receiverReceipt as Awaited<ReturnType<typeof receiverDeployment.wait>>,
    });
    if (!deployedReceiverAddress) {
      throw new Error('BungeeReceiver address not found in CREATE3 receipt');
    }
    console.log(`  [${network.name}] BungeeReceiver deployed`);
    await waitForContractBytecode({
      provider,
      address: receiverAddress,
      label: 'BungeeReceiver',
    });

    const registryPath = await writeReceiverDeploymentRegistry({
      network,
      provider,
      receiverAddress,
      executorAddress,
      receiverInitcodeHash,
      executorInitcodeHash,
    });
    if (registryPath) {
      console.log(`  [${network.name}] Deployment CSV: ${registryPath}`);
    }

    return {
      network,
      skipped: false,
      executorDeployed: true,
      receiverDeployed: true,
    };
  } catch (err) {
    return {
      network,
      skipped: false,
      executorDeployed: false,
      receiverDeployed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
