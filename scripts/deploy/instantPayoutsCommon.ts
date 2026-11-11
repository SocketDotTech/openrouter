/** Shared checks for standalone scripts. Do not import Hardhat or dotenv here. */
import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import { execFileSync } from 'child_process';
import {
  getAddress, isHexString, MaxUint256, parseUnits, TypedDataEncoder,
} from 'ethers';

export const CHAIN_ID = 8453;
export const OWNER = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';
export const SIGNER = '0x9486019cb42bBB69313f5cd0BC69625b9192e2e0';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const NAME = 'DTF Instant Payouts';
export const VERSION = '1';
export const PAYOUT_ABI = [
  'function owner() view returns (address)',
  'function payoutSigner() view returns (address)',
  'function setPayoutSigner(address)',
  'function rescueNative(address,uint256)',
  'event PayoutSignerChanged(address indexed previousSigner,address indexed newSigner)',
  'event NativeRescued(address indexed recipient,uint256 amount)',
  'function USDC() view returns (address)',
  'function used(bytes32) view returns (bool)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
  'function payout(bytes32,address,uint256,uint256,bytes)',
];
export const PAYOUT_TYPES = { Payout: [
  { name: 'payoutId', type: 'bytes32' },
  { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] };
const DOMAIN_TYPES = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];

export class InputError extends Error {}
export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InputError(message);
}
export function address(value: string, field: string): string {
  try {
    const result = getAddress(value);
    requireValue(BigInt(result) !== 0n, `${field} must be nonzero.`);
    return result;
  } catch { throw new InputError(`${field} must be a valid nonzero address.`); }
}
export function amountUnits(value: string): string {
  requireValue(/^[0-9]+(?:\.[0-9]{1,6})?$/.test(value), 'Amount must use at most six decimal places; exponents and signs are not accepted.');
  const units = parseUnits(value, 6);
  requireValue(units > 0n && units <= MaxUint256, 'Amount is outside the positive uint256 range.');
  return units.toString();
}
export function positiveInteger(value: string, field: string): string {
  requireValue(/^[0-9]+$/.test(value), `${field} must be a positive integer.`);
  const number = BigInt(value);
  requireValue(number > 0n && number <= MaxUint256, `${field} is outside the positive uint256 range.`);
  return number.toString();
}
export function typedData(contract: string, payoutId: string, recipient: string, amount: string, deadline: string) {
  const verifyingContract = address(contract, 'Contract');
  const to = address(recipient, 'Recipient');
  requireValue(to !== verifyingContract && to !== USDC, 'Recipient cannot be the payout contract or USDC token.');
  requireValue(isHexString(payoutId, 32) && BigInt(payoutId) !== 0n, 'Payout ID must be a nonzero bytes32 value.');
  return {
    types: { EIP712Domain: DOMAIN_TYPES, ...PAYOUT_TYPES }, primaryType: 'Payout',
    domain: { name: NAME, version: VERSION, chainId: CHAIN_ID, verifyingContract },
    message: { payoutId: payoutId.toLowerCase(), recipient: to,
      amount: positiveInteger(amount, 'Amount units'), deadline: positiveInteger(deadline, 'Deadline') },
  };
}
export type Authorization = ReturnType<typeof typedData>;
export function validateTypedData(input: any): Authorization {
  requireValue(input && input.domain && input.message, 'Invalid typed authorization.');
  const result = typedData(input.domain.verifyingContract, input.message.payoutId,
    input.message.recipient, input.message.amount, input.message.deadline);
  requireValue(JSON.stringify(input) === JSON.stringify(result), 'Authorization must have the exact approved domain, fields, types, and order.');
  return result;
}
export function digest(data: Authorization): string {
  return TypedDataEncoder.hash(data.domain, PAYOUT_TYPES, data.message);
}
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function noEnvFile(path: string): void {
  requireValue(!basename(path).startsWith('.env'), '.env files are not supported.');
}
export function readJson(path: string): any {
  noEnvFile(path);
  try { noEnvFile(realpathSync(path)); return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error instanceof InputError) throw error; throw new InputError('Cannot read the JSON input.'); }
}
export function writeJson(path: string, value: unknown): void {
  noEnvFile(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function projectRoot(): string {
  const root = resolve(process.env.INSTANT_PAYOUTS_ROOT || resolve(__dirname, '../../instant-payouts'));
  requireValue(existsSync(resolve(root, 'foundry.toml')), 'The dedicated Instant Payouts root must have foundry.toml.');
  try {
    lstatSync(resolve(root, '.env'));
    throw new InputError('The dedicated root contains .env. Foundry execution is refused without reading it.');
  } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  return root;
}
export function foundry(binary: 'cast' | 'forge', args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const root = projectRoot();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:FOUNDRY_|DAPP_|ETH_)/.test(key)) delete env[key];
  }
  env.FOUNDRY_PROFILE = 'default';
  env.RUST_LOG = 'off';
  Object.assign(env, extraEnv);
  try {
    return execFileSync(binary, args, { cwd: root, env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
  } catch { throw new InputError(`${binary} failed. Provider and credential details are withheld.`); }
}
export function cast(args: string[], kmsKeyId?: string): string {
  return foundry('cast', args, kmsKeyId ? { AWS_KMS_KEY_ID: kmsKeyId } : {});
}
export function parseArgs(args: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireValue(flag.startsWith('--') && !result[flag], 'Use unique --option arguments.');
    result[flag] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return result;
}
export function option(args: Record<string, string | true>, flag: string): string {
  requireValue(typeof args[flag] === 'string', `${flag} requires a value.`);
  return args[flag] as string;
}
export async function safeMain(main: () => Promise<void>): Promise<void> {
  try { await main(); }
  catch (error) {
    console.error(error instanceof InputError ? error.message
      : 'Operation did not complete. Inspect the local record before a retry. Provider and credential details are withheld.');
    process.exitCode = 1;
  }
}
