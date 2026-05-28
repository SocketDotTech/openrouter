import { Contract, Log, Provider, TransactionReceipt, keccak256, toUtf8Bytes } from 'ethers';

// CreateX factory — https://createx.rocks/
export const CREATE_X_FACTORY = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';

/** CREATE3 salt label used by `deployOpenRouter.ts`. */
export const OPEN_ROUTER_CREATE3_SALT_TEXT = 'OpenRouter' + '000';

/** CREATE3 salt label used by `deployReceiverAndExecutor.ts`. */
export const BUNGEE_RECEIVER_CREATE3_SALT_TEXT = 'BungeeReceiver' + '000';

/** CREATE3 salt label used by `deployReceiverAndExecutor.ts`. */
export const CALLDATA_EXECUTOR_CREATE3_SALT_TEXT = 'CalldataExecutor' + '000';

/** Keccak256 salt for deterministic OpenRouter CREATE3 deployments. */
export const OPEN_ROUTER_CREATE3_SALT = keccak256(
  toUtf8Bytes(OPEN_ROUTER_CREATE3_SALT_TEXT),
);

/** Keccak256 salt for deterministic BungeeReceiver CREATE3 deployments. */
export const BUNGEE_RECEIVER_CREATE3_SALT = keccak256(
  toUtf8Bytes(BUNGEE_RECEIVER_CREATE3_SALT_TEXT),
);

/** Keccak256 salt for deterministic CalldataExecutor CREATE3 deployments. */
export const CALLDATA_EXECUTOR_CREATE3_SALT = keccak256(
  toUtf8Bytes(CALLDATA_EXECUTOR_CREATE3_SALT_TEXT),
);

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;

/** Observed OpenRouter CREATE3 address for salt `OpenRouter000` via canonical CreateX. */
export const OPEN_ROUTER_EXPECTED_ADDRESS =
  '0x1Cb8E88afDe521aaA0108F2b788D467C286ABAe7';

/**
 * Resolves the OpenRouter contract address for deployment checks.
 *
 * Priority: `OPENROUTER_ADDRESS` env → {@link OPEN_ROUTER_EXPECTED_ADDRESS}.
 * The default matches CreateX CREATE3 salt `OpenRouter000` used by `deployOpenRouter.ts`.
 */
export function resolveOpenRouterAddress(): string {
  const envAddress = process.env.OPENROUTER_ADDRESS?.trim();
  if (envAddress && ADDR_HEX_RE.test(envAddress)) {
    return envAddress;
  }

  return OPEN_ROUTER_EXPECTED_ADDRESS;
}

/** Returns true when `code` looks like a deployed contract (non-empty bytecode). */
export function hasContractBytecode(code: string): boolean {
  return code !== '0x' && code.length > 2;
}

/**
 * Checks whether OpenRouter bytecode is present at the resolved CREATE3 address.
 * When deployed, also reads `owner()` to confirm the contract responds.
 */
export async function getOpenRouterDeploymentStatus(params: {
  provider: Provider;
}): Promise<{ address: string; deployed: boolean; owner?: string }> {
  const address = resolveOpenRouterAddress();
  const bytecode = await params.provider.getCode(address);

  if (!hasContractBytecode(bytecode)) {
    return { address, deployed: false };
  }

  try {
    const router = new Contract(
      address,
      ['function owner() view returns (address)'],
      params.provider,
    );
    const owner = (await router.owner()) as string;

    return { address, deployed: true, owner };
  } catch {
    // Bytecode exists but does not look like OpenRouter — proceed with deployment.
    return { address, deployed: false };
  }
}

export const Create3ABI = [
  'function computeCreate2Address(bytes32,bytes32,address) view returns (address)',
  'function deployCreate2(bytes32,bytes) payable returns (address)',
  'function computeCreate3Address(bytes32,address) view returns (address)',
  'function deployCreate3(bytes32,bytes) payable returns (address)',
];

const Create3ContractCreationEvent = 'ContractCreation(address)';
const Create3ContractCreationEventTopicHash = keccak256(
  toUtf8Bytes(Create3ContractCreationEvent),
);

/**
 * Reads the deployed contract address from a CreateX CREATE3 deployment receipt.
 */
export function decodeCreate3DeploymentFromTxReceipt(params: {
  receipt: TransactionReceipt;
}): string | null {
  const { receipt } = params;
  const filteredLogs: Log[] = receipt.logs.filter((log: Log) =>
    log.topics.includes(Create3ContractCreationEventTopicHash),
  );

  if (filteredLogs.length === 0) {
    return null;
  }

  const eventData = filteredLogs[0].topics[1];
  if (!eventData) {
    return null;
  }

  return '0x' + eventData.slice(26);
}

/**
 * Checks whether BungeeReceiver bytecode is present at the given address.
 * When deployed, reads `owner()` to confirm the contract responds.
 */
export async function getBungeeReceiverDeploymentStatus(params: {
  provider: Provider;
  address: string;
}): Promise<{ address: string; deployed: boolean; owner?: string }> {
  const { provider, address } = params;
  const bytecode = await provider.getCode(address);

  if (!hasContractBytecode(bytecode)) {
    return { address, deployed: false };
  }

  try {
    const contract = new Contract(
      address,
      ['function owner() view returns (address)'],
      provider,
    );
    const owner = (await contract.owner()) as string;
    return { address, deployed: true, owner };
  } catch {
    return { address, deployed: false };
  }
}

/**
 * Checks whether CalldataExecutor bytecode is present at the given address.
 * When deployed, reads `BUNGEE_RECEIVER()` to confirm the contract responds.
 */
export async function getCalldataExecutorDeploymentStatus(params: {
  provider: Provider;
  address: string;
}): Promise<{ address: string; deployed: boolean; bungeeReceiver?: string }> {
  const { provider, address } = params;
  const bytecode = await provider.getCode(address);

  if (!hasContractBytecode(bytecode)) {
    return { address, deployed: false };
  }

  try {
    const contract = new Contract(
      address,
      ['function BUNGEE_RECEIVER() view returns (address)'],
      provider,
    );
    const bungeeReceiver = (await contract.BUNGEE_RECEIVER()) as string;
    return { address, deployed: true, bungeeReceiver };
  } catch {
    return { address, deployed: false };
  }
}
