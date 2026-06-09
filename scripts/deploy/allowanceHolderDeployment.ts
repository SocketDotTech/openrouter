import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { Contract, Provider, keccak256, toUtf8Bytes } from 'ethers';
import { allowanceHolderVariantForChain } from '../e2e/config';
import type { AllowanceHolderVariant } from '../e2e/config';
import {
  ALLOWANCE_HOLDER_CREATE3_SALT,
  ALLOWANCE_HOLDER_CREATE3_SALT_TEXT,
  CREATE_X_FACTORY,
  Create3ABI,
  computeFinalAddress,
  hasContractBytecode,
} from './create3';

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;
const BYTECODE_HEX_RE = /^0x(?:[a-fA-F0-9]{2})+$/;
const BYTES32_HEX_RE = /^0x[a-fA-F0-9]{64}$/;

export const ALLOWANCE_HOLDER_DEPLOYMENT_BYTECODE_ENV =
  'ALLOWANCE_HOLDER_DEPLOYMENT_BYTECODE';
export const ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE_ENV =
  'ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE';
export const ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE_ENV =
  'ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE';
export const DEFAULT_ALLOWANCE_HOLDER_CREATE3_SALT_TEXT =
  ALLOWANCE_HOLDER_CREATE3_SALT_TEXT;
export const DEFAULT_ALLOWANCE_HOLDER_CREATE3_SALT =
  ALLOWANCE_HOLDER_CREATE3_SALT;

function explicitAllowanceHolderAddress(chainId: number): string | undefined {
  const envSpecific = process.env[`ALLOWANCE_HOLDER_CHAIN_${chainId}`]?.trim();
  if (envSpecific && ADDR_HEX_RE.test(envSpecific)) {
    return envSpecific;
  }

  const envGlobal = process.env.ALLOWANCE_HOLDER_ADDRESS?.trim();
  if (envGlobal && ADDR_HEX_RE.test(envGlobal)) {
    return envGlobal;
  }

  return undefined;
}

export function resolveAllowanceHolderCreate3Salt(): {
  salt: string;
  saltText?: string;
} {
  const salt = process.env.ALLOWANCE_HOLDER_CREATE3_SALT?.trim();
  if (salt) {
    if (!BYTES32_HEX_RE.test(salt)) {
      throw new Error('ALLOWANCE_HOLDER_CREATE3_SALT must be a 0x-prefixed bytes32');
    }

    return { salt };
  }

  const saltText =
    process.env.ALLOWANCE_HOLDER_CREATE3_SALT_TEXT?.trim() ??
    DEFAULT_ALLOWANCE_HOLDER_CREATE3_SALT_TEXT;

  return {
    salt: keccak256(toUtf8Bytes(saltText)),
    saltText,
  };
}

export async function computeAllowanceHolderCreate3Address(params: {
  provider: Provider;
}): Promise<{ address: string; salt: string; saltText?: string }> {
  const { salt, saltText } = resolveAllowanceHolderCreate3Salt();
  const create3Factory = new Contract(
    CREATE_X_FACTORY,
    Create3ABI,
    params.provider,
  );

  return {
    address: await computeFinalAddress(salt, create3Factory),
    salt,
    saltText,
  };
}

export async function resolveAllowanceHolderDeploymentAddress(params: {
  provider: Provider;
  chainId: number;
}): Promise<{
  address: string;
  create3Salt: string;
  create3SaltText?: string;
}> {
  const computed = await computeAllowanceHolderCreate3Address({
    provider: params.provider,
  });
  const explicit = explicitAllowanceHolderAddress(params.chainId);

  if (explicit && explicit.toLowerCase() !== computed.address.toLowerCase()) {
    throw new Error(
      [
        'Configured AllowanceHolder address does not match CREATE3 address.',
        `configured=${explicit}`,
        `computed=${computed.address}`,
        `salt=${computed.salt}`,
      ].join(' '),
    );
  }

  return {
    address: computed.address,
    create3Salt: computed.salt,
    create3SaltText: computed.saltText,
  };
}

export function resolveAllowanceHolderVariant(
  chainId: number,
): AllowanceHolderVariant {
  return allowanceHolderVariantForChain(chainId);
}

function bytecodeEnvForVariant(variant: AllowanceHolderVariant): string {
  return variant === 'cancun'
    ? ALLOWANCE_HOLDER_CANCUN_DEPLOYMENT_BYTECODE_ENV
    : ALLOWANCE_HOLDER_SHANGHAI_DEPLOYMENT_BYTECODE_ENV;
}

function initcodeHashEnvForVariant(variant: AllowanceHolderVariant): string {
  return variant === 'cancun'
    ? 'ALLOWANCE_HOLDER_CANCUN_INITCODE_HASH'
    : 'ALLOWANCE_HOLDER_SHANGHAI_INITCODE_HASH';
}

export function resolveAllowanceHolderDeploymentBytecode(params: {
  chainId: number;
}): {
  variant: AllowanceHolderVariant;
  bytecode: string;
  initcodeHash: string;
  expectedInitcodeHash?: string;
} {
  const variant = resolveAllowanceHolderVariant(params.chainId);
  const variantEnv = bytecodeEnvForVariant(variant);
  const bytecode =
    process.env[variantEnv]?.trim() ??
    process.env[ALLOWANCE_HOLDER_DEPLOYMENT_BYTECODE_ENV]?.trim();

  if (!bytecode) {
    throw new Error(
      `${variantEnv} is required to deploy the ${variant} AllowanceHolder variant`,
    );
  }

  if (!BYTECODE_HEX_RE.test(bytecode)) {
    throw new Error(
      `${variantEnv} must be 0x-prefixed hex deployment bytecode`,
    );
  }

  const expectedInitcodeHash =
    process.env[initcodeHashEnvForVariant(variant)]?.trim() ??
    process.env.ALLOWANCE_HOLDER_INITCODE_HASH?.trim();

  const initcodeHash = keccak256(bytecode);
  if (expectedInitcodeHash) {
    if (!BYTES32_HEX_RE.test(expectedInitcodeHash)) {
      throw new Error(
        `${initcodeHashEnvForVariant(variant)} must be a 0x-prefixed bytes32 hash`,
      );
    }

    if (initcodeHash.toLowerCase() !== expectedInitcodeHash.toLowerCase()) {
      throw new Error(
        `Unexpected ${variant} AllowanceHolder initcode hash: got ${initcodeHash}, expected ${expectedInitcodeHash}`,
      );
    }
  }

  return {
    variant,
    bytecode,
    initcodeHash,
    expectedInitcodeHash,
  };
}

export async function getAllowanceHolderDeploymentStatus(params: {
  provider: Provider;
  chainId: number;
}): Promise<{
  address: string;
  deployed: boolean;
  variant: AllowanceHolderVariant;
  create3Salt: string;
  create3SaltText?: string;
  runtimeBytecodeHash?: string;
}> {
  const deploymentAddress = await resolveAllowanceHolderDeploymentAddress(params);
  const variant = resolveAllowanceHolderVariant(params.chainId);
  const bytecode = await params.provider.getCode(deploymentAddress.address);
  const deployed = hasContractBytecode(bytecode);

  return {
    address: deploymentAddress.address,
    deployed,
    variant,
    create3Salt: deploymentAddress.create3Salt,
    create3SaltText: deploymentAddress.create3SaltText,
    runtimeBytecodeHash: deployed ? keccak256(bytecode) : undefined,
  };
}

export const AllowanceHolderABI = [
  'function exec(address operator,address token,uint256 amount,address target,bytes data) payable returns (bytes result)',
  'function transferFrom(address token,address owner,address recipient,uint256 amount) returns (bool)',
] as const;

export function getAllowanceHolderContract(
  address: string,
  provider: Provider,
): Contract {
  return new Contract(address, AllowanceHolderABI, provider);
}

export interface AllowanceHolderDeploymentManifest {
  chainId: number;
  network: string;
  allowanceHolder: string;
  variant: AllowanceHolderVariant;
  status: 'deployed' | 'already_deployed' | 'checked';
  deployer?: string;
  create3Salt: string;
  create3SaltText?: string;
  txHash?: string;
  blockNumber?: number;
  initcodeHash?: string;
  runtimeBytecodeHash?: string;
  updatedAt: string;
}

export function allowanceHolderManifestPath(chainId: number): string {
  return resolve(
    process.cwd(),
    'deployments',
    'allowance-holder',
    `${chainId}.json`,
  );
}

export async function writeAllowanceHolderDeploymentManifest(
  manifest: AllowanceHolderDeploymentManifest,
): Promise<string> {
  const filePath = allowanceHolderManifestPath(manifest.chainId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}
