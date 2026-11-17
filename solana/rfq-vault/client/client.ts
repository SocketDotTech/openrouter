import { createHash } from "node:crypto";
import {
  AccountRole,
  addSignersToTransactionMessage,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  lamports,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountMeta,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { routeFlags, routeHash } from "./authorization.ts";

type DflowInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

type DflowInstructions = {
  transactionVersion: "v0" | "v1";
  addressLookupTableAddresses: string[];
  setupInstructions: DflowInstruction[];
  swapInstruction: DflowInstruction;
  cleanupInstructions: DflowInstruction[];
  otherInstructions: DflowInstruction[];
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  prioritizationFeeLamports: number;
};

type DflowQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
};

function decodeInstruction(raw: DflowInstruction): Instruction {
  const data = Buffer.from(raw.data, "base64");
  if (data.toString("base64") !== raw.data) throw new Error("Invalid DFlow instruction data");
  return {
    programAddress: address(raw.programId),
    accounts: raw.accounts.map((account) => {
      if (typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") {
        throw new Error("Invalid DFlow account flags");
      }
      return {
        address: address(account.pubkey),
        role: account.isWritable
          ? (account.isSigner ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE)
          : (account.isSigner ? AccountRole.READONLY_SIGNER : AccountRole.READONLY),
      };
    }),
    data,
  };
}

export async function fetchDflowSwap(params: {
  apiKey?: string;
  apiUrl?: string;
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  slippageBps: number;
  swapAuthority: Address;
  destinationTokenAccount?: Address;
  maxRouteLength?: number;
  wrapAndUnwrapSol?: boolean;
}) {
  const base = params.apiUrl ?? "https://quote-api.dflow.net";
  if (params.amount <= 0n || !Number.isInteger(params.slippageBps) ||
      params.slippageBps < 0 || params.slippageBps > 10_000) {
    throw new Error("Invalid DFlow amount or slippage");
  }
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: params.slippageBps.toString(),
    transactionVersion: "v1",
    destinationSwap: String(Boolean(params.destinationTokenAccount)),
  });
  if (params.maxRouteLength !== undefined) {
    query.set("maxRouteLength", params.maxRouteLength.toString());
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (params.apiKey) headers["x-api-key"] = params.apiKey;
  const quoteResponse = await fetch(new URL(`/quote?${query}`, base), {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!quoteResponse.ok) throw new Error(`DFlow quote failed (HTTP ${quoteResponse.status})`);
  const quote = await quoteResponse.json() as DflowQuote;
  if (quote.inputMint !== params.inputMint || quote.outputMint !== params.outputMint ||
      BigInt(quote.inAmount) !== params.amount || BigInt(quote.otherAmountThreshold) <= 0n ||
      BigInt(quote.outAmount) < BigInt(quote.otherAmountThreshold)) {
    throw new Error("DFlow returned an invalid exact-input quote");
  }
  const response = await fetch(new URL("/swap-instructions", base), {
    method: "POST",
    headers,
    body: JSON.stringify({
      quoteResponse: quote,
      transactionVersion: "v1",
      userPublicKey: params.swapAuthority,
      destinationTokenAccount: params.destinationTokenAccount,
      // DFlow cannot simulate RFQ account creation or vault funding that occurs in our caller.
      dynamicComputeUnitLimit: false,
      wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`DFlow instructions failed (HTTP ${response.status})`);
  return { quote, ...decodeDflowInstructions(await response.json() as DflowInstructions) };
}

export function decodeDflowInstructions(raw: DflowInstructions) {
  if (raw.transactionVersion !== "v1" || raw.addressLookupTableAddresses.length > 0) {
    throw new Error("DFlow did not return instructions for a v1 transaction");
  }
  return {
    setup: raw.setupInstructions.map(decodeInstruction),
    swap: decodeInstruction(raw.swapInstruction),
    cleanup: raw.cleanupInstructions.map(decodeInstruction),
    other: raw.otherInstructions.map(decodeInstruction),
    suggestedComputeUnitLimit: raw.computeUnitLimit,
    suggestedLoadedAccountsDataSizeLimit: raw.loadedAccountsDataSizeLimit,
    suggestedPriorityFeeLamports: BigInt(raw.prioritizationFeeLamports),
  };
}

export function formatSwapRoute(swap: Instruction, swapAuthority: Address) {
  const accounts = (swap.accounts ?? []).map(({ address, role }): AccountMeta => {
    if (!(role & 2)) return { address, role };
    if (address !== swapAuthority) throw new Error(`Unexpected swap signer ${address}`);
    // The RFQ instruction declares the user or supplies the swap PDA signature.
    return { address, role: role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : AccountRole.READONLY };
  });
  return {
    target: swap.programAddress,
    data: Uint8Array.from(swap.data ?? []),
    flags: routeFlags(swap),
    remainingAccounts: accounts,
    hash: routeHash(swap),
  };
}

export function anchorInstruction(params: {
  program: Address;
  name: string;
  accounts: readonly AccountMeta[];
  args: Uint8Array;
}): Instruction {
  const discriminator = createHash("sha256")
    .update(`global:${params.name}`)
    .digest()
    .subarray(0, 8);
  return {
    programAddress: params.program,
    accounts: params.accounts,
    data: Buffer.concat([discriminator, params.args]),
  };
}

export async function signV1Transaction(params: {
  feePayer: TransactionSigner;
  signers?: readonly TransactionSigner[];
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  instructions: readonly Instruction[];
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  priorityFeeLamports: bigint;
}) {
  const { feePayer, lifetime, instructions, signers = [] } = params;
  const { computeUnitLimit, loadedAccountsDataSizeLimit, priorityFeeLamports } = params;
  return signTransactionMessageWithSigners(pipe(
    createTransactionMessage({ version: 1 }),
    (message) => setTransactionMessageFeePayerSigner(feePayer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
    (message) => appendTransactionMessageInstructions(instructions, message),
    (message) => addSignersToTransactionMessage([...signers], message),
    (message) => setTransactionMessageConfig({
      computeUnitLimit,
      loadedAccountsDataSizeLimit,
      priorityFeeLamports: lamports(priorityFeeLamports),
    }, message),
  ));
}
