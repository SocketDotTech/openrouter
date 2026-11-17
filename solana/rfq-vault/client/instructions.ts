import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getBytes } from "ethers";
import { u64 } from "./authorization.ts";
import { anchorInstruction, formatSwapRoute } from "./client.ts";

export const RFQ_PROGRAM = address("8gS67TJgSWTnExQZxwLmnsv1EBocZgUTqMGvTzbzLYZS");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

const { READONLY, WRITABLE, READONLY_SIGNER, WRITABLE_SIGNER } = AccountRole;
const addressEncoder = getAddressEncoder();
const key = (value: Address) => Uint8Array.from(addressEncoder.encode(value));
const account = (address: Address, role = READONLY): AccountMeta => ({ address, role });

function fixed(value: string, length: number): Uint8Array {
  const bytes = getBytes(value);
  if (bytes.length !== length) throw new Error(`Expected ${length} bytes`);
  return bytes;
}

function vector(data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([length, data]);
}

export async function deriveTokenAccount(owner: Address, mint: Address, tokenProgram = TOKEN_PROGRAM) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [key(owner), key(tokenProgram), key(mint)],
  });
  return ata;
}

export async function deriveVaultAccounts(params: {
  owner: Address;
  usdcMint: Address;
  swapProgram: Address;
  program?: Address;
}) {
  const { owner, usdcMint, swapProgram, program = RFQ_PROGRAM } = params;
  const [vault] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: ["vault", key(owner)],
  });
  const [swapAuthority] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: ["swap", key(vault)],
  });
  const [vaultUsdc, swapUsdc] = await Promise.all([
    deriveTokenAccount(vault, usdcMint),
    deriveTokenAccount(swapAuthority, usdcMint),
  ]);
  return { owner, usdcMint, swapProgram, program, vault, swapAuthority, vaultUsdc, swapUsdc };
}

type VaultAccounts = Awaited<ReturnType<typeof deriveVaultAccounts>>;
type Settlement = {
  payer: Address;
  quoteId: string;
  nonce: bigint;
  /** Exclusive Unix timestamp in seconds, signed by the solver. */
  validUntil: bigint;
  signature: string;
};

export async function deriveQuoteState(config: VaultAccounts, quoteId: string) {
  const [quote] = await getProgramDerivedAddress({
    programAddress: config.program,
    seeds: ["quote", key(config.vault), fixed(quoteId, 32)],
  });
  return quote;
}

function instruction(
  config: VaultAccounts,
  name: string,
  accounts: AccountMeta[],
  ...args: Uint8Array[]
): Instruction {
  return anchorInstruction({ program: config.program, name, accounts, args: Buffer.concat(args) });
}

export function initialize(config: VaultAccounts, solver: string) {
  return instruction(config, "initialize", [
    account(config.owner, WRITABLE_SIGNER),
    account(config.vault, WRITABLE),
    account(config.swapAuthority),
    account(config.usdcMint),
    account(config.vaultUsdc, WRITABLE),
    account(config.swapUsdc, WRITABLE),
    account(config.swapProgram),
    account(TOKEN_PROGRAM),
    account(ASSOCIATED_TOKEN_PROGRAM),
    account(SYSTEM_PROGRAM),
  ], fixed(solver, 20));
}

export async function deposit(config: VaultAccounts, params: {
  user: Address;
  userUsdc?: Address;
  quoteId: string;
  amount: bigint;
}) {
  const source = params.userUsdc ?? await deriveTokenAccount(params.user, config.usdcMint);
  return instruction(config, "deposit", [
    account(params.user, READONLY_SIGNER),
    account(config.vault),
    account(config.usdcMint),
    account(source, WRITABLE),
    account(config.vaultUsdc, WRITABLE),
    account(TOKEN_PROGRAM),
  ], fixed(params.quoteId, 32), u64(params.amount));
}

export function swapAndDeposit(config: VaultAccounts, params: {
  user: Address;
  quoteId: string;
  minUsdc: bigint;
  swap: Instruction;
}) {
  const route = formatSwapRoute(params.swap, params.user);
  if (route.target !== config.swapProgram) throw new Error("Incorrect swap program");
  return instruction(config, "swap_and_deposit", [
    account(params.user, READONLY_SIGNER),
    account(config.vault),
    account(config.usdcMint),
    account(config.vaultUsdc, WRITABLE),
    account(config.swapProgram),
    ...route.remainingAccounts,
  ], fixed(params.quoteId, 32), u64(params.minUsdc), vector(route.data), vector(route.flags));
}

async function payUsdc(config: VaultAccounts, action: "fulfil" | "refund", params: Settlement & {
  recipient: Address;
  recipientUsdc?: Address;
  amount: bigint;
}) {
  const [quote, recipientUsdc] = await Promise.all([
    deriveQuoteState(config, params.quoteId),
    params.recipientUsdc ?? deriveTokenAccount(params.recipient, config.usdcMint),
  ]);
  return instruction(config, action, [
    account(params.payer, WRITABLE_SIGNER),
    account(config.vault),
    account(quote, WRITABLE),
    account(config.usdcMint),
    account(config.vaultUsdc, WRITABLE),
    account(recipientUsdc, WRITABLE),
    account(TOKEN_PROGRAM),
    account(SYSTEM_PROGRAM),
  ], fixed(params.quoteId, 32), u64(params.nonce), u64(params.validUntil),
  key(params.recipient), u64(params.amount), fixed(params.signature, 65));
}

export function fulfil(config: VaultAccounts, params: Parameters<typeof payUsdc>[2]) {
  return payUsdc(config, "fulfil", params);
}

export function refund(config: VaultAccounts, params: Parameters<typeof payUsdc>[2]) {
  return payUsdc(config, "refund", params);
}

export async function markForRefund(config: VaultAccounts, params: Settlement) {
  const quote = await deriveQuoteState(config, params.quoteId);
  return instruction(config, "mark_for_refund", [
    account(params.payer, WRITABLE_SIGNER),
    account(config.vault),
    account(quote, WRITABLE),
    account(SYSTEM_PROGRAM),
  ], fixed(params.quoteId, 32), u64(params.nonce), u64(params.validUntil), fixed(params.signature, 65));
}

export async function swapAndFulfil(config: VaultAccounts, params: Settlement & {
  recipient: Address;
  recipientOutput: Address;
  outputMint: Address;
  amount: bigint;
  minOutput: bigint;
  swap: Instruction;
}) {
  const quote = await deriveQuoteState(config, params.quoteId);
  const route = formatSwapRoute(params.swap, config.swapAuthority);
  if (route.target !== config.swapProgram) throw new Error("Incorrect swap program");
  return instruction(config, "swap_and_fulfil", [
    account(params.payer, WRITABLE_SIGNER),
    account(config.vault),
    account(quote, WRITABLE),
    account(config.usdcMint),
    account(config.vaultUsdc, WRITABLE),
    account(config.swapAuthority),
    account(config.swapUsdc, WRITABLE),
    account(params.recipient),
    account(params.recipientOutput, WRITABLE),
    account(config.swapProgram),
    account(TOKEN_PROGRAM),
    account(SYSTEM_PROGRAM),
    ...route.remainingAccounts,
  ], fixed(params.quoteId, 32), u64(params.nonce), u64(params.validUntil), key(params.outputMint), u64(params.amount),
  u64(params.minOutput), vector(route.data), vector(route.flags), fixed(params.signature, 65));
}

export function setSolver(config: VaultAccounts, solver: string) {
  return instruction(config, "set_solver", [
    account(config.owner, READONLY_SIGNER),
    account(config.vault, WRITABLE),
  ], fixed(solver, 20));
}

export async function rescueFunds(config: VaultAccounts, params: {
  recipient: Address;
  recipientUsdc?: Address;
  amount: bigint;
}) {
  const recipientUsdc = params.recipientUsdc ?? await deriveTokenAccount(params.recipient, config.usdcMint);
  return instruction(config, "rescue_funds", [
    account(config.owner, READONLY_SIGNER),
    account(config.vault),
    account(config.usdcMint),
    account(config.vaultUsdc, WRITABLE),
    account(recipientUsdc, WRITABLE),
    account(TOKEN_PROGRAM),
  ], u64(params.amount));
}
