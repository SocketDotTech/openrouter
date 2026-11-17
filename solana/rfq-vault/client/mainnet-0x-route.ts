import { AccountRole, address, getAddressDecoder, type Address, type Instruction } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, deriveTokenAccount } from "./instructions.ts";

export const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const TRUMP = address("6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN");
export const SETTLER = address("Sett1erwx2eqT5A8uvu8GBxDFT2W5TNnhirL7hLmb8m");

type RawInstruction = {
  program_id: number[];
  accounts: { pubkey: number[]; is_signer: boolean; is_writable: boolean }[];
  data: number[];
};

const { READONLY, WRITABLE, READONLY_SIGNER, WRITABLE_SIGNER } = AccountRole;
const decoder = getAddressDecoder();

function bytes(value: unknown, length?: number) {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length) ||
      !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("Invalid 0x instruction bytes");
  }
  return Uint8Array.from(value);
}

function decodeInstruction(raw: RawInstruction) {
  if (!raw || !Array.isArray(raw.accounts)) throw new Error("Invalid 0x instruction accounts");
  return {
    programAddress: decoder.decode(bytes(raw.program_id, 32)),
    accounts: raw.accounts.map((account) => {
      if (!account || typeof account.is_signer !== "boolean" || typeof account.is_writable !== "boolean") {
        throw new Error("Invalid 0x instruction account flags");
      }
      return {
        address: decoder.decode(bytes(account.pubkey, 32)),
        role: account.is_writable
          ? (account.is_signer ? WRITABLE_SIGNER : WRITABLE)
          : (account.is_signer ? READONLY_SIGNER : READONLY),
      };
    }),
    data: bytes(raw.data),
  } satisfies Instruction;
}

export async function fetchZeroXRoute(params: {
  apiKey: string;
  taker: Address;
  feePayer: Address;
  recipientOwner: Address;
  outputAccount: Address;
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  inputAccount?: Address;
  disabledSources?: readonly string[];
}) {
  const { apiKey, taker, feePayer, recipientOwner, outputAccount, inputMint, outputMint, amount, disabledSources } = params;
  if (!apiKey || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER) || inputMint === outputMint) {
    throw new Error("Invalid 0x exact-input request");
  }
  const [inputAccount, recipientAta] = await Promise.all([
    params.inputAccount ?? deriveTokenAccount(taker, inputMint),
    deriveTokenAccount(recipientOwner, outputMint),
  ]);
  if (outputAccount !== recipientAta) throw new Error("0x recipient token account does not match its owner and mint");

  const response = await fetch("https://api.0x.org/solana/swap-instructions", {
    method: "POST",
    headers: { "0x-api-key": apiKey, "0x-version": "v2", "Content-Type": "application/json" },
    body: JSON.stringify({
      amount_in: Number(amount),
      token_in: inputMint,
      token_out: outputMint,
      taker,
      recipient: { associatedTokenAccount: { owner: recipientOwner } },
      slippage_bps: 75,
      transaction_version: "v1",
      reserve_transaction_accounts: 12,
      disabled_sources: disabledSources,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`0x Solana instructions failed (HTTP ${response.status})`);
  const raw = await response.json() as {
    address_lookup_tables: string[];
    amount_out: number;
    min_amount_out: number;
    instructions: RawInstruction[];
    route_plan: { dex_label: string }[];
  };
  if (!raw || !Array.isArray(raw.address_lookup_tables) || raw.address_lookup_tables.length ||
      !Number.isSafeInteger(raw.amount_out) || !Number.isSafeInteger(raw.min_amount_out) ||
      raw.min_amount_out <= 0 || raw.amount_out < raw.min_amount_out ||
      !Array.isArray(raw.instructions) || !Array.isArray(raw.route_plan) || !raw.route_plan.length ||
      !raw.route_plan.every((leg) => typeof leg?.dex_label === "string" && leg.dex_label.length > 0)) {
    throw new Error("Invalid 0x v1 swap response");
  }

  const instructions = raw.instructions.map(decodeInstruction);
  const swap = instructions.pop();
  if (swap?.programAddress !== SETTLER || !swap.data.length) throw new Error("Expected a final 0x Settler instruction");
  const signers = swap.accounts.filter(({ role }) => role === READONLY_SIGNER || role === WRITABLE_SIGNER);
  const writable = new Set(swap.accounts.filter(({ role }) => role === WRITABLE || role === WRITABLE_SIGNER)
    .map(({ address }) => address));
  if (!signers.length || signers.some(({ address }) => address !== taker) ||
      !writable.has(inputAccount) || !writable.has(outputAccount)) {
    throw new Error("Unexpected 0x swap signer or token accounts");
  }

  const setup = await Promise.all(instructions.map(async (instruction) => {
    const [payer, account, owner, mint, systemProgram, tokenProgram] = instruction.accounts;
    if (instruction.programAddress !== ASSOCIATED_TOKEN_PROGRAM || instruction.accounts.length !== 6 ||
        instruction.data.length !== 1 || instruction.data[0] !== 1 || payer.address !== taker ||
        payer.role !== WRITABLE_SIGNER || account.role !== WRITABLE ||
        !instruction.accounts.slice(2).every(({ role }) => role === READONLY) ||
        systemProgram.address !== SYSTEM_PROGRAM || tokenProgram.address !== TOKEN_PROGRAM ||
        !writable.has(account.address) || account.address !== await deriveTokenAccount(owner.address, mint.address)) {
      throw new Error("Unexpected 0x token account setup");
    }
    return { ...instruction, accounts: [{ address: feePayer, role: WRITABLE_SIGNER }, ...instruction.accounts.slice(1)] };
  }));
  return {
    setup,
    swap,
    minimumOutput: BigInt(raw.min_amount_out),
    expectedOutput: BigInt(raw.amount_out),
    dexes: raw.route_plan.map(({ dex_label }) => dex_label),
  };
}
