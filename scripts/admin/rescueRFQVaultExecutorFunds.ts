/**
 * Rescue native or ERC20 funds from RFQVaultExecutor using its AWS KMS owner.
 *
 * Usage:
 *   npx hardhat run scripts/admin/rescueRFQVaultExecutorFunds.ts --network <network> -- \
 *     --amount <wei|all> \
 *     [--token <token|native>] \
 *     [--to <recipient>] \
 *     [--executor <rfq-vault-executor>] \
 *     [--yes]
 *
 * Required env:
 *   SOLVER_KMS — AWS KMS key id or ARN for the RFQVaultExecutor owner
 *
 * Optional env:
 *   SOLVER_KMS_REGION | SOLVER_AWS_KMS_REGION | AWS_KMS_REGION | AWS_REGION
 *   RFQ_VAULT_EXECUTOR_ADDRESS
 *   RFQ_VAULT_RESCUE_TOKEN
 *   RFQ_VAULT_RESCUE_TO
 *   RFQ_VAULT_RESCUE_AMOUNT
 */

import { execFileSync } from 'child_process';
import { createPublicKey } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import hre from 'hardhat';
import {
  Contract,
  Signature,
  Transaction,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  recoverAddress,
} from 'ethers';
import type { Provider } from 'ethers';

import { readRFQVaultExecutorAddress } from '../deploy/rfqVaultExecutorAddresses';
import { confirm } from '../utils';

const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const DEFAULT_USDG_TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const DEFAULT_RESCUE_TO = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_N = SECP256K1_N / 2n;

const RFQ_VAULT_EXECUTOR_ABI = [
  'function owner() view returns (address)',
  'function rescueFunds(address token, address rescueTo, uint256 amount)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

type AwsKmsPublicKeyResponse = {
  KeySpec?: string;
  PublicKey?: string;
};

type AwsKmsSignResponse = {
  Signature?: string;
};

type ParsedArgs = {
  amount?: string;
  dryRun: boolean;
  executor?: string;
  kmsKeyId?: string;
  kmsRegion?: string;
  token?: string;
  to?: string;
  waitConfirmations?: number;
  yes: boolean;
};

type RescueBalance = {
  amount: bigint;
  display: string;
  symbol: string;
};

type KmsSigner = {
  address: string;
  keyId: string;
  region?: string;
};

type DerInteger = {
  nextOffset: number;
  value: bigint;
};

type UnsignedTransaction = {
  chainId: bigint;
  data: string;
  gasLimit: bigint;
  gasPrice: bigint;
  nonce: number;
  to: string;
  type: number;
  value: bigint;
};

function getProvider(): Provider {
  return (hre as unknown as { ethers: { provider: Provider } }).ethers.provider;
}

function printUsage(): void {
  console.log(`Usage:
  npx hardhat run scripts/admin/rescueRFQVaultExecutorFunds.ts --network <network> -- \\
    --amount <wei|all> \\
    [--token <token|native>] \\
    [--to <recipient>] \\
    [--executor <rfq-vault-executor>] \\
    [--yes]

Defaults:
  --token defaults to USDG on Robinhood: ${DEFAULT_USDG_TOKEN}
  --to defaults to: ${DEFAULT_RESCUE_TO}
  --executor defaults to deployments/prod/addresses/<network>.json.
  --amount, --token, --to, and --executor can also be supplied as:
    RFQ_VAULT_RESCUE_TOKEN
    RFQ_VAULT_RESCUE_TO
    RFQ_VAULT_RESCUE_AMOUNT
    RFQ_VAULT_EXECUTOR_ADDRESS`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    dryRun: false,
    yes: false,
  };

  const knownArgPrefixes = [
    '--amount',
    '--dry-run',
    '--executor',
    '--help',
    '--kms-key-id',
    '--kms-region',
    '--recipient',
    '--token',
    '--to',
    '--wait',
    '--yes',
    '-h',
    '-y',
  ];
  const firstKnownArg = argv.findIndex((arg) =>
    knownArgPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`)),
  );
  const scriptArgs = argv.includes('--')
    ? argv.slice(argv.lastIndexOf('--') + 1)
    : firstKnownArg === -1
      ? []
      : argv.slice(firstKnownArg);

  for (let index = 0; index < scriptArgs.length; index += 1) {
    const arg = scriptArgs[index];
    const [key, inlineValue] = arg.split('=', 2);
    const nextValue = () => {
      const value = inlineValue ?? scriptArgs[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${key}`);
      }
      if (inlineValue === undefined) {
        index += 1;
      }
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      args.yes = true;
      continue;
    }
    if (key === '--amount') {
      args.amount = nextValue();
      continue;
    }
    if (key === '--executor') {
      args.executor = nextValue();
      continue;
    }
    if (key === '--kms-key-id') {
      args.kmsKeyId = nextValue();
      continue;
    }
    if (key === '--kms-region') {
      args.kmsRegion = nextValue();
      continue;
    }
    if (key === '--token') {
      args.token = nextValue();
      continue;
    }
    if (key === '--to' || key === '--recipient') {
      args.to = nextValue();
      continue;
    }
    if (key === '--wait') {
      const parsed = Number(nextValue());
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--wait must be a non-negative integer');
      }
      args.waitConfirmations = parsed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function requireValue(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function normalizeAddress(name: string, value: string): string {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  const checksummed = getAddress(value);
  if (checksummed.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${name} cannot be zero`);
  }

  return checksummed;
}

function normalizeToken(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower === 'native' ||
    lower === 'eth' ||
    lower === 'gas' ||
    lower === NATIVE_TOKEN_ADDRESS.toLowerCase()
  ) {
    return NATIVE_TOKEN_ADDRESS;
  }

  return normalizeAddress('token', trimmed);
}

function parseArnRegion(keyId: string): string | undefined {
  const arnParts = keyId.split(':');
  if (arnParts.length >= 4 && arnParts[0] === 'arn' && arnParts[2] === 'kms') {
    return arnParts[3] || undefined;
  }
  return undefined;
}

function resolveKmsConfig(args: ParsedArgs): { keyId: string; region?: string } {
  const keyId = requireValue(
    'SOLVER_KMS or --kms-key-id',
    args.kmsKeyId ?? process.env.SOLVER_KMS,
  );
  const region =
    args.kmsRegion ??
    process.env.SOLVER_KMS_REGION?.trim() ??
    process.env.SOLVER_AWS_KMS_REGION?.trim() ??
    process.env.AWS_KMS_REGION?.trim() ??
    process.env.AWS_REGION?.trim() ??
    parseArnRegion(keyId);

  return { keyId, region };
}

async function resolveExecutorAddress(args: ParsedArgs): Promise<string> {
  const explicit =
    args.executor?.trim() ?? process.env.RFQ_VAULT_EXECUTOR_ADDRESS?.trim();
  if (explicit) {
    return normalizeAddress('executor', explicit);
  }

  const deployed = await readRFQVaultExecutorAddress(hre.network.name);
  if (!deployed) {
    throw new Error(
      `RFQVaultExecutor address not found for ${hre.network.name}; pass --executor or RFQ_VAULT_EXECUTOR_ADDRESS`,
    );
  }

  return normalizeAddress('RFQVaultExecutor deployment', deployed);
}

function awsArgs(region: string | undefined, args: string[]): string[] {
  return region ? [...args, '--region', region] : args;
}

function execAwsJson<T>(args: string[]): T {
  try {
    const stdout = execFileSync('aws', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AWS CLI command failed: ${message}`);
  }
}

function getKmsPublicKey(keyId: string, region: string | undefined): Buffer {
  const response = execAwsJson<AwsKmsPublicKeyResponse>(
    awsArgs(region, [
      'kms',
      'get-public-key',
      '--key-id',
      keyId,
      '--output',
      'json',
    ]),
  );

  if (response.KeySpec !== 'ECC_SECG_P256K1') {
    throw new Error(
      `KMS key must be ECC_SECG_P256K1; got ${response.KeySpec ?? 'unknown'}`,
    );
  }
  if (!response.PublicKey) {
    throw new Error('KMS get-public-key response did not include PublicKey');
  }

  return Buffer.from(response.PublicKey, 'base64');
}

function signDigestWithKms(params: {
  digest: string;
  keyId: string;
  region?: string;
}): Buffer {
  const digestBytes = Buffer.from(params.digest.slice(2), 'hex');
  const tempDir = mkdtempSync(join(tmpdir(), 'rfq-kms-sign-'));
  const digestPath = join(tempDir, 'digest.bin');

  let response: AwsKmsSignResponse;
  try {
    writeFileSync(digestPath, digestBytes);
    response = execAwsJson<AwsKmsSignResponse>(
      awsArgs(params.region, [
        'kms',
        'sign',
        '--key-id',
        params.keyId,
        '--message',
        `fileb://${digestPath}`,
        '--message-type',
        'DIGEST',
        '--signing-algorithm',
        'ECDSA_SHA_256',
        '--output',
        'json',
      ]),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }

  if (!response.Signature) {
    throw new Error('KMS sign response did not include Signature');
  }

  return Buffer.from(response.Signature, 'base64');
}

function base64UrlToBuffer(value: string): Buffer {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(base64, 'base64');
}

function leftPad32(value: Buffer): Buffer {
  if (value.length > 32) {
    throw new Error('Invalid secp256k1 coordinate length');
  }
  if (value.length === 32) {
    return value;
  }
  return Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

function uncompressedPublicKeyFromSpki(spkiDer: Buffer): Buffer {
  const key = createPublicKey({
    key: spkiDer,
    format: 'der',
    type: 'spki',
  });
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `KMS public key must be elliptic curve; got ${key.asymmetricKeyType}`,
    );
  }
  if (details?.namedCurve && details.namedCurve !== 'secp256k1') {
    throw new Error(
      `KMS public key must use secp256k1; got ${details.namedCurve}`,
    );
  }

  const jwk = key.export({ format: 'jwk' }) as {
    crv?: string;
    x?: string;
    y?: string;
  };
  if (!jwk.x || !jwk.y) {
    throw new Error('KMS public key did not export x/y coordinates');
  }

  return Buffer.concat([
    leftPad32(base64UrlToBuffer(jwk.x)),
    leftPad32(base64UrlToBuffer(jwk.y)),
  ]);
}

function evmAddressFromUncompressedPublicKey(publicKey: Buffer): string {
  return getAddress(`0x${keccak256(publicKey).slice(-40)}`);
}

function readDerLength(data: Buffer, offset: number): {
  length: number;
  nextOffset: number;
} {
  const first = data[offset];
  if (first === undefined) {
    throw new Error('Invalid DER signature length');
  }

  if ((first & 0x80) === 0) {
    return { length: first, nextOffset: offset + 1 };
  }

  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 2) {
    throw new Error('Unsupported DER length encoding');
  }

  const lengthBytes = data.subarray(offset + 1, offset + 1 + byteCount);
  if (lengthBytes.length !== byteCount) {
    throw new Error('Truncated DER length');
  }

  return {
    length: Number(BigInt(`0x${lengthBytes.toString('hex')}`)),
    nextOffset: offset + 1 + byteCount,
  };
}

function readDerInteger(data: Buffer, offset: number): DerInteger {
  if (data[offset] !== 0x02) {
    throw new Error('Invalid DER signature integer');
  }

  const { length, nextOffset } = readDerLength(data, offset + 1);
  const valueBytes = data.subarray(nextOffset, nextOffset + length);
  if (valueBytes.length !== length) {
    throw new Error('Truncated DER integer');
  }

  let stripped = Buffer.from(valueBytes);
  while (stripped.length > 1 && stripped[0] === 0) {
    stripped = stripped.subarray(1);
  }

  return {
    nextOffset: nextOffset + length,
    value: BigInt(`0x${stripped.toString('hex')}`),
  };
}

function parseDerSignature(signature: Buffer): { r: bigint; s: bigint } {
  if (signature[0] !== 0x30) {
    throw new Error('Invalid DER signature sequence');
  }

  const { length, nextOffset } = readDerLength(signature, 1);
  const endOffset = nextOffset + length;
  if (endOffset !== signature.length) {
    throw new Error('Invalid DER signature size');
  }

  const r = readDerInteger(signature, nextOffset);
  const s = readDerInteger(signature, r.nextOffset);
  if (s.nextOffset !== endOffset) {
    throw new Error('Invalid DER signature trailing bytes');
  }

  return { r: r.value, s: s.value };
}

function toUint256Hex(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error('uint256 value out of range');
  }
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function recoverYParity(params: {
  digest: string;
  expectedAddress: string;
  r: bigint;
  s: bigint;
}): 0 | 1 {
  for (const yParity of [0, 1] as const) {
    const recovered = recoverAddress(params.digest, {
      r: toUint256Hex(params.r),
      s: toUint256Hex(params.s),
      yParity,
    });
    if (recovered.toLowerCase() === params.expectedAddress.toLowerCase()) {
      return yParity;
    }
  }

  throw new Error('KMS signature did not recover to the KMS public key address');
}

function initializeKmsSigner(args: ParsedArgs): KmsSigner {
  const { keyId, region } = resolveKmsConfig(args);
  const publicKey = getKmsPublicKey(keyId, region);
  const address = evmAddressFromUncompressedPublicKey(
    uncompressedPublicKeyFromSpki(publicKey),
  );

  return { address, keyId, region };
}

function signTransactionWithKms(params: {
  kmsSigner: KmsSigner;
  unsignedTransaction: UnsignedTransaction;
}): { hash: string; serialized: string } {
  const transaction = Transaction.from(params.unsignedTransaction);
  const digest = transaction.unsignedHash;
  const derSignature = signDigestWithKms({
    digest,
    keyId: params.kmsSigner.keyId,
    region: params.kmsSigner.region,
  });
  const { r, s } = parseDerSignature(derSignature);
  const canonicalS = s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
  const yParity = recoverYParity({
    digest,
    expectedAddress: params.kmsSigner.address,
    r,
    s: canonicalS,
  });

  transaction.signature = Signature.from({
    r: toUint256Hex(r),
    s: toUint256Hex(canonicalS),
    yParity,
  });

  if (
    !transaction.from ||
    transaction.from.toLowerCase() !== params.kmsSigner.address.toLowerCase()
  ) {
    throw new Error(
      `Signed transaction sender mismatch: expected ${params.kmsSigner.address}, got ${transaction.from}`,
    );
  }
  if (!transaction.hash) {
    throw new Error('Signed transaction hash is empty');
  }

  return {
    hash: transaction.hash,
    serialized: transaction.serialized,
  };
}

async function readRescueBalance(params: {
  executorAddress: string;
  token: string;
}): Promise<RescueBalance> {
  if (params.token.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    const amount = await getProvider().getBalance(params.executorAddress);
    return {
      amount,
      display: `${formatUnits(amount, 18)} native`,
      symbol: 'native',
    };
  }

  const code = await getProvider().getCode(params.token);
  if (code === '0x') {
    throw new Error(`Token has no bytecode: ${params.token}`);
  }

  const erc20 = new Contract(params.token, ERC20_ABI, getProvider());
  const amount = (await erc20.balanceOf(params.executorAddress)) as bigint;

  let decimals = 18;
  try {
    decimals = Number((await erc20.decimals()) as bigint | number);
  } catch {
    decimals = 18;
  }

  let symbol = params.token;
  try {
    symbol = String(await erc20.symbol());
  } catch {
    symbol = params.token;
  }

  return {
    amount,
    display: `${formatUnits(amount, decimals)} ${symbol}`,
    symbol,
  };
}

function resolveRescueAmount(rawAmount: string | undefined, balance: bigint): bigint {
  const amount = rawAmount?.trim();
  if (!amount || amount.toLowerCase() === 'all') {
    return balance;
  }

  if (!/^\d+$/.test(amount)) {
    throw new Error('--amount must be an integer wei amount or all');
  }

  return BigInt(amount);
}

function bump(value: bigint, numerator = 115n, denominator = 100n): bigint {
  return (value * numerator) / denominator;
}

async function buildUnsignedTransaction(params: {
  data: string;
  from: string;
  to: string;
}): Promise<UnsignedTransaction> {
  const provider = getProvider();
  const network = await provider.getNetwork();
  const nonce = await provider.getTransactionCount(params.from, 'pending');
  const estimatedGas = await provider.estimateGas({
    from: params.from,
    to: params.to,
    data: params.data,
    value: 0n,
  });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPrice) {
    throw new Error('Provider did not return gasPrice or maxFeePerGas');
  }

  return {
    chainId: network.chainId,
    data: params.data,
    gasLimit: bump(estimatedGas),
    gasPrice: bump(gasPrice),
    nonce,
    to: params.to,
    type: 0,
    value: 0n,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tokenInput = args.token ?? process.env.RFQ_VAULT_RESCUE_TOKEN;
  if (!tokenInput && hre.network.name !== 'robinhood') {
    throw new Error(
      `Default USDG rescue token is only intended for --network robinhood; current network is ${hre.network.name}. Pass --token to override.`,
    );
  }

  const token = normalizeToken(tokenInput ?? DEFAULT_USDG_TOKEN);
  const rescueTo = normalizeAddress(
    'rescue recipient',
    args.to ?? process.env.RFQ_VAULT_RESCUE_TO ?? DEFAULT_RESCUE_TO,
  );
  const requestedAmount = requireValue(
    'RFQ_VAULT_RESCUE_AMOUNT or --amount',
    args.amount ?? process.env.RFQ_VAULT_RESCUE_AMOUNT?.trim(),
  );
  const executorAddress = await resolveExecutorAddress(args);
  const kmsSigner = initializeKmsSigner(args);

  const vault = new Contract(
    executorAddress,
    RFQ_VAULT_EXECUTOR_ABI,
    getProvider(),
  );
  const owner = getAddress((await vault.owner()) as string);
  if (owner.toLowerCase() !== kmsSigner.address.toLowerCase()) {
    throw new Error(
      `KMS signer is not RFQVaultExecutor owner\nOwner: ${owner}\nKMS:   ${kmsSigner.address}`,
    );
  }

  const balance = await readRescueBalance({ executorAddress, token });
  const rescueAmount = resolveRescueAmount(requestedAmount, balance.amount);
  if (rescueAmount === 0n) {
    console.log('Selected token balance is zero; nothing to rescue.');
    return;
  }
  if (rescueAmount > balance.amount) {
    throw new Error(
      `Requested amount ${rescueAmount} exceeds executor balance ${balance.amount}`,
    );
  }

  const data = vault.interface.encodeFunctionData('rescueFunds', [
    token,
    rescueTo,
    rescueAmount,
  ]);

  await getProvider().call({
    from: kmsSigner.address,
    to: executorAddress,
    data,
    value: 0n,
  });

  const unsignedTransaction = await buildUnsignedTransaction({
    data,
    from: kmsSigner.address,
    to: executorAddress,
  });
  const gasBalance = await getProvider().getBalance(kmsSigner.address);
  const maxGasCost =
    unsignedTransaction.gasLimit * unsignedTransaction.gasPrice;
  if (gasBalance < maxGasCost) {
    throw new Error(
      `KMS owner has insufficient gas balance: balance=${gasBalance}, maxCost=${maxGasCost}`,
    );
  }

  console.log('Network:       ', hre.network.name);
  console.log('Executor:      ', executorAddress);
  console.log('Owner/KMS:     ', kmsSigner.address);
  console.log('Token:         ', token);
  console.log('Balance:       ', balance.display);
  console.log('Rescue amount: ', rescueAmount.toString(), balance.symbol);
  console.log('Rescue to:     ', rescueTo);
  console.log('Nonce:         ', unsignedTransaction.nonce);
  console.log('Gas limit:     ', unsignedTransaction.gasLimit.toString());
  console.log('Gas price:     ', unsignedTransaction.gasPrice.toString());
  console.log('Max gas cost:  ', formatUnits(maxGasCost, 18));

  if (args.dryRun) {
    console.log('Dry run enabled; transaction was not signed or broadcast.');
    return;
  }

  if (!args.yes) {
    await confirm('Send rescueFunds transaction? y/n ');
  }

  const signed = signTransactionWithKms({
    kmsSigner,
    unsignedTransaction,
  });
  console.log(`Signed transaction hash: ${signed.hash}`);

  const sent = await getProvider().broadcastTransaction(signed.serialized);
  console.log(`Broadcast transaction hash: ${sent.hash}`);

  const waitConfirmations = args.waitConfirmations ?? 2;
  const receipt = await sent.wait(waitConfirmations);
  if (!receipt || receipt.status !== 1) {
    throw new Error('rescueFunds transaction failed');
  }

  console.log(
    `Rescue complete in block ${receipt.blockNumber} after ${waitConfirmations} confirmation(s).`,
  );
}

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
