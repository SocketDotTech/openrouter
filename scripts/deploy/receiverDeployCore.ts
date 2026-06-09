import { Contract, JsonRpcProvider, Wallet } from 'ethers';
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
import { ReceiverDeployNetwork, resolveRpcUrl } from './networks';

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

/**
 * Reads CalldataExecutor + BungeeReceiver deployment status on a single chain.
 */
export async function getReceiverChainStatus(
  network: ReceiverDeployNetwork,
): Promise<ReceiverChainStatus> {
  try {
    const provider = createNetworkProvider(network);
    const create3Factory = new Contract(CREATE_X_FACTORY, Create3ABI, provider);

    const receiverAddress = await computeFinalAddress(
      BUNGEE_RECEIVER_CREATE3_SALT,
      create3Factory,
    );
    const executorAddress = await computeFinalAddress(
      CALLDATA_EXECUTOR_CREATE3_SALT,
      create3Factory,
    );

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

      console.log(`  [${network.name}] Deploying CalldataExecutor...`);
      const executorDeployment = await create3Factory.deployCreate3(
        CALLDATA_EXECUTOR_CREATE3_SALT,
        executorDeployTx.data,
      );
      console.log(`  [${network.name}] CalldataExecutor tx: ${executorDeployment.hash}`);

      const executorReceipt = await executorDeployment.wait();
      const deployedExecutorAddress = decodeCreate3DeploymentFromTxReceipt({
        receipt: executorReceipt,
      });
      if (!deployedExecutorAddress) {
        throw new Error('CalldataExecutor address not found in CREATE3 receipt');
      }
      console.log(`  [${network.name}] CalldataExecutor deployed`);
    }

    const receiverStatus = await getBungeeReceiverDeploymentStatus({
      provider,
      address: receiverAddress,
    });

    if (receiverStatus.deployed) {
      console.log(
        `  [${network.name}] BungeeReceiver already deployed, owner=${receiverStatus.owner}`,
      );
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

    console.log(`  [${network.name}] Deploying BungeeReceiver...`);
    const receiverDeployment = await create3Factory.deployCreate3(
      BUNGEE_RECEIVER_CREATE3_SALT,
      receiverDeployTx.data,
    );
    console.log(`  [${network.name}] BungeeReceiver tx: ${receiverDeployment.hash}`);

    const receiverReceipt = await receiverDeployment.wait();
    const deployedReceiverAddress = decodeCreate3DeploymentFromTxReceipt({
      receipt: receiverReceipt,
    });
    if (!deployedReceiverAddress) {
      throw new Error('BungeeReceiver address not found in CREATE3 receipt');
    }
    console.log(`  [${network.name}] BungeeReceiver deployed`);

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
