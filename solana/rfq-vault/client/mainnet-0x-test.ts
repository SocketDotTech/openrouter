import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AccountRole, blockhash, createKeyPairSignerFromBytes, getAddressDecoder,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, type Address, type Instruction,
} from "@solana/kit";
import { Signature, Wallet } from "ethers";
import { actionDigest, routeHash, settlementDigest, u64, type SettlementAction } from "./authorization.ts";
import { signV1Transaction } from "./client.ts";
import {
  RFQ_PROGRAM, TOKEN_PROGRAM, deriveQuoteState, deriveTokenAccount, deriveVaultAccounts,
  initialize, refund, swapAndDeposit, swapAndFulfil,
} from "./instructions.ts";
import { SETTLER, TRUMP, USDC, fetchZeroXRoute } from "./mainnet-0x-route.ts";

const { values } = parseArgs({
  options: {
    wallet: { type: "string" },
    state: { type: "string" },
    rpc: { type: "string" },
    "aws-profile": { type: "string" },
    send: { type: "boolean" },
  },
});
assert(values.wallet, "Pass --wallet with the isolated Solana keypair file");
const wallet = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(values.wallet, "utf8"))));
const vault = await deriveVaultAccounts({ owner: wallet.address, usdcMint: USDC, swapProgram: SETTLER });
const walletUsdc = await deriveTokenAccount(wallet.address, USDC);
const walletTrump = await deriveTokenAccount(wallet.address, TRUMP);
const rpcUrl = values.rpc ?? "https://api.mainnet-beta.solana.com";
const commitment = "finalized";
const oneUsdc = 1_000_000n;
const failureSwapAmount = 250_000n;

type RpcAccount = { data: [string, string]; executable: boolean; owner: string };
type Simulation = { err: unknown; logs: string[] | null };
type Confirmed = { slot: number; version: number; meta: { err: unknown; logMessages: string[] | null; fee: number; computeUnitsConsumed?: number } };
type Snapshot = { walletUsdc: string; walletTrump: string; vaultUsdc: string; swapUsdc: string; quoteStatus: number | null };
type CaseName = "initialize" | "swap-and-deposit" | "seed" | "swap-and-fulfil" | "refund-after-fulfil" | "swap-failure" | "deposit-failure";
type Stage = { signature: string; wire: string; lastValidBlockHeight: number; before: Snapshot; complete?: boolean; minimum?: string };
type Journal = { wallet: Address; program: Address; solverKey: string; depositQuote: string; fulfilQuote: string; cases: Partial<Record<CaseName, Stage>> };
type Check = (logs: string[], before: Snapshot, after: Snapshot, stage: Stage) => void;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(rpcUrl, {
      method: "POST", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.status === 429 && attempt < 3) {
      await sleep(1_500 * (attempt + 1));
      continue;
    }
    const body = await response.json() as { result?: T; error?: { code: number; message: string } };
    if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
    return body.result;
  }
}

async function accounts(addresses: Address[], minContextSlot?: number) {
  const { value } = await rpc<{ value: (RpcAccount | null)[] }>("getMultipleAccounts", [
    addresses, { encoding: "base64", commitment, minContextSlot },
  ]);
  return value;
}

function tokenAmount(account: RpcAccount | null) {
  if (!account) return 0n;
  assert.equal(account.owner, TOKEN_PROGRAM);
  return Buffer.from(account.data[0], "base64").readBigUInt64LE(64);
}

function realEvents(logs: string[]) {
  const stack: string[] = [];
  const events: Buffer[] = [];
  for (const line of logs) {
    const invoked = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoked) {
      stack.push(invoked[1]);
    } else if (/^Program \w+ (?:success$|failed:)/.test(line)) {
      stack.pop();
    } else if (line.startsWith("Program data: ") && stack.at(-1) === RFQ_PROGRAM) {
      events.push(Buffer.from(line.slice(14), "base64"));
    }
  }
  return events;
}

const decodeAddress = getAddressDecoder();
function verifyEvent(logs: string[], name: "Deposited" | "Fulfilled", quote: string, amount: bigint) {
  const [event, ...extra] = realEvents(logs);
  assert(event && extra.length === 0 && event.length === 112, `Expected one RFQ ${name} event`);
  const discriminator = createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
  assert(event.subarray(0, 8).equals(discriminator));
  assert.equal(`0x${event.subarray(8, 40).toString("hex")}`, quote);
  if (name === "Deposited") {
    assert.equal(decodeAddress.decode(event.subarray(40, 72)), wallet.address);
    assert.equal(decodeAddress.decode(event.subarray(72, 104)), USDC);
    assert.equal(event.readBigUInt64LE(104), amount);
  } else {
    assert.equal(decodeAddress.decode(event.subarray(40, 72)), TRUMP);
    assert.equal(event.readBigUInt64LE(72), amount);
    assert.equal(decodeAddress.decode(event.subarray(80, 112)), wallet.address);
  }
}

function unchanged(logs: string[], before: Snapshot, after: Snapshot) {
  assert.deepEqual(after, before, "An expected failure changed a token balance or quote state");
  assert(!logs.includes("Log truncated"), "Cannot check the event when the log is incomplete");
  assert.deepEqual(realEvents(logs), [], "An expected failure emitted an RFQ event");
}

function expectedError(name: CaseName, logs: string[]) {
  const lines = logs.join("\n");
  if (name === "refund-after-fulfil") assert.match(lines, /Instruction: Refund[\s\S]*already in use/);
  if (name === "swap-failure") {
    assert(logs.some(line => line.startsWith(`Program ${SETTLER} failed:`)));
    assert(
      logs.includes(`Program ${SETTLER} failed: custom program error: 0x1b59`) ||
      /insufficient funds|Tokenkeg\w+ failed: custom program error: 0x1\b/i.test(lines),
      "Expected the oversized swap to fail in 0x or SPL Token",
    );
  }
  if (name === "deposit-failure") {
    assert(logs.includes(`Program ${SETTLER} success`), "The swap must succeed before the deposit rejects");
    assert.match(lines, /Error Code: InsufficientOutput/);
  }
  assert.deepEqual(realEvents(logs), []);
}

const [program, userUsdc, userTrump] = await accounts([RFQ_PROGRAM, walletUsdc, walletTrump]);
const balance = await rpc<{ value: number }>("getBalance", [wallet.address, { commitment }]);
console.log(JSON.stringify({
  wallet: wallet.address, program: RFQ_PROGRAM, deployed: program?.executable === true,
  solLamports: balance.value, usdcBaseUnits: String(tokenAmount(userUsdc)), trumpBaseUnits: String(tokenAmount(userTrump)),
}));
if (!values.send) process.exit(0);
assert(program?.executable, "Deploy the isolated RFQ binary first");
assert(values.state && values["aws-profile"], "Pass --state and --aws-profile with --send");
const statePath = values.state;
const newQuote = () => `0x${randomBytes(32).toString("hex")}`;
const state: Journal = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {
  wallet: wallet.address, program: RFQ_PROGRAM, solverKey: Wallet.createRandom().privateKey,
  depositQuote: newQuote(), fulfilQuote: newQuote(), cases: {},
};
assert.equal(state.wallet, wallet.address);
assert.equal(state.program, RFQ_PROGRAM);
function save() {
  writeFileSync(statePath + ".new", JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(statePath + ".new", statePath);
}
save();
const solver = new Wallet(state.solverKey);
const quoteState = await deriveQuoteState(vault, state.fulfilQuote);
const failureCases = new Set<CaseName>(["refund-after-fulfil", "swap-failure", "deposit-failure"]);
const sign = (quoteId: string, action: SettlementAction) => {
  const nonce = 1n;
  const validUntil = BigInt(Math.floor(Date.now() / 1000)) + 300n;
  const digest = settlementDigest(actionDigest({ program: RFQ_PROGRAM, vault: vault.vault, quoteId, nonce, validUntil, action }));
  const { r, s, yParity } = Signature.from(solver.signingKey.sign(digest));
  return { nonce, validUntil, signature: r + s.slice(2) + (yParity ? "01" : "00") };
};

async function snapshot(minContextSlot?: number): Promise<Snapshot> {
  const [userUsdc, userTrump, vaultUsdc, swapUsdc, quote] = await accounts([
    walletUsdc, walletTrump, vault.vaultUsdc, vault.swapUsdc, quoteState,
  ], minContextSlot);
  return {
    walletUsdc: String(tokenAmount(userUsdc)), walletTrump: String(tokenAmount(userTrump)),
    vaultUsdc: String(tokenAmount(vaultUsdc)), swapUsdc: String(tokenAmount(swapUsdc)),
    quoteStatus: quote ? Buffer.from(quote.data[0], "base64")[8] : null,
  };
}

async function confirm(signature: string): Promise<Confirmed> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const result = await rpc<Confirmed | null>("getTransaction", [
      signature, { commitment, encoding: "base64", maxSupportedTransactionVersion: 1 },
    ]);
    if (result) return result;
    await sleep(2_000);
  }
  throw new Error(`Finalized transaction not found. Check ${signature} before retrying.`);
}

async function hasSignature(signature: string) {
  const { value } = await rpc<{ value: (object | null)[] }>("getSignatureStatuses", [
    [signature], { searchTransactionHistory: true },
  ]);
  return value[0] !== null;
}

async function runCase(
  name: CaseName,
  build: (before: Snapshot) => Promise<{ instructions: Instruction[]; minimum?: bigint }>,
  verify: Check,
) {
  const shouldFail = failureCases.has(name);
  let stage = state.cases[name];
  if (stage?.complete) return;
  if (stage && await rpc<number>("getBlockHeight", [{ commitment }]) > stage.lastValidBlockHeight
      && !await hasSignature(stage.signature)) {
    delete state.cases[name];
    save();
    stage = undefined;
  }
  if (!stage) {
    const before = await snapshot();
    const { instructions, minimum } = await build(before);
    const { value: recent } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash", [{ commitment: "confirmed" }],
    );
    const tx = await signV1Transaction({
      feePayer: wallet, lifetime: { blockhash: blockhash(recent.blockhash), lastValidBlockHeight: BigInt(recent.lastValidBlockHeight) },
      instructions, computeUnitLimit: 600_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024, priorityFeeLamports: 20_000n,
    });
    const wire = getBase64EncodedWireTransaction(tx);
    const { value: simulated } = await rpc<{ value: Simulation }>("simulateTransaction", [
      wire, { encoding: "base64", commitment: "confirmed", sigVerify: true },
    ]);
    assert.equal(Boolean(simulated.err), shouldFail, `Unexpected ${name} simulation: ${JSON.stringify(simulated)}`);
    if (shouldFail) expectedError(name, simulated.logs ?? []);
    stage = {
      signature: getSignatureFromTransaction(tx), wire, lastValidBlockHeight: recent.lastValidBlockHeight,
      before, minimum: minimum?.toString(),
    };
    state.cases[name] = stage;
    save();
  }
  if (!await hasSignature(stage.signature)) {
    console.log(JSON.stringify({ name, submittedSignature: stage.signature }));
    const sent = await rpc<string>("sendTransaction", [
      stage.wire, { encoding: "base64", skipPreflight: shouldFail, preflightCommitment: "confirmed", maxRetries: 3 },
    ]);
    assert.equal(sent, stage.signature);
  }
  const tx = await confirm(stage.signature);
  const logs = tx.meta.logMessages ?? [];
  assert.equal(tx.version, 1);
  assert.equal(Boolean(tx.meta.err), shouldFail, JSON.stringify(tx.meta.err));
  if (shouldFail) expectedError(name, logs);
  const after = await snapshot(tx.slot);
  verify(logs, stage.before, after, stage);
  stage.complete = true;
  save();
  console.log(JSON.stringify({ name, signature: stage.signature, before: stage.before, after, fee: tx.meta.fee, computeUnits: tx.meta.computeUnitsConsumed }));
}

function zeroXKey() {
  try {
    const raw = execFileSync("aws", [
      "--profile", values["aws-profile"]!, "--region", "us-east-1", "--no-cli-pager",
      "secretsmanager", "get-secret-value", "--secret-id", "backend/prod/bungee-backend",
      "--query", "SecretString", "--output", "text",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    const key: unknown = JSON.parse(raw).ZEROX_API_KEY;
    assert(typeof key === "string" && key.length > 0);
    return key;
  } catch {
    throw new Error("Could not load the configured 0x API key");
  }
}

const apiKey = zeroXKey();
const sourceRoute = (amount: bigint) => fetchZeroXRoute({
  apiKey, amount, inputMint: TRUMP, outputMint: USDC, taker: wallet.address, feePayer: wallet.address,
  inputAccount: walletTrump, recipientOwner: vault.vault, outputAccount: vault.vaultUsdc, disabledSources: ["BisonFi"],
});

function seedInstruction(): Instruction {
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: walletUsdc, role: AccountRole.WRITABLE },
      { address: USDC, role: AccountRole.READONLY },
      { address: vault.vaultUsdc, role: AccountRole.WRITABLE },
      { address: wallet.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: Buffer.concat([Buffer.from([12]), u64(oneUsdc), Buffer.from([6])]),
  };
}

await runCase("initialize", async () => {
  const [current] = await accounts([vault.vault]);
  assert(!current, "Use the original test journal for this vault");
  assert(balance.value >= 20_000_000, "Test wallet needs SOL for top-level fees and token accounts");
  assert(tokenAmount(userUsdc) >= oneUsdc && tokenAmount(userTrump) >= 2_000_000n, "Fund the test wallet with 1 USDC and 2 TRUMP");
  return { instructions: [initialize(vault, solver.address)] };
}, (_, __, after) => assert.equal(after.vaultUsdc, "0"));

await runCase("swap-and-deposit", async before => {
  const initial = await sourceRoute(1_000_000n);
  const amount = oneUsdc * 1_000_000n / initial.expectedOutput;
  assert(amount > 0n && amount + failureSwapAmount <= BigInt(before.walletTrump), "Insufficient TRUMP for deposit and rollback test");
  const route = await sourceRoute(amount);
  assert(route.expectedOutput >= 900_000n && route.expectedOutput <= 1_100_000n, "Deposit quote is outside the roughly 1 USDC test range");
  return { instructions: [...route.setup, swapAndDeposit(vault, {
    user: wallet.address, quoteId: state.depositQuote, minUsdc: route.minimumOutput, swap: route.swap,
  })], minimum: route.minimumOutput };
}, (logs, before, after, stage) => {
  const credited = BigInt(after.vaultUsdc) - BigInt(before.vaultUsdc);
  assert(credited >= BigInt(stage.minimum!) && BigInt(after.walletTrump) < BigInt(before.walletTrump));
  verifyEvent(logs, "Deposited", state.depositQuote, credited);
});

await runCase("seed", async () => ({ instructions: [seedInstruction()] }), (logs, before, after) => {
  assert.equal(BigInt(after.vaultUsdc) - BigInt(before.vaultUsdc), oneUsdc);
  assert.equal(BigInt(before.walletUsdc) - BigInt(after.walletUsdc), oneUsdc);
  assert.deepEqual(realEvents(logs), []);
});

await runCase("swap-and-fulfil", async before => {
  assert.equal(before.quoteStatus, null);
  const route = await fetchZeroXRoute({
    apiKey, amount: oneUsdc, inputMint: USDC, outputMint: TRUMP, taker: vault.swapAuthority, feePayer: wallet.address,
    inputAccount: vault.swapUsdc, recipientOwner: wallet.address, outputAccount: walletTrump, disabledSources: ["BisonFi"],
  });
  const action = { kind: "swapAndFulfil", amount: oneUsdc, outputMint: TRUMP, recipient: wallet.address,
    minOutput: route.minimumOutput, routeHash: routeHash(route.swap) } as const;
  return { instructions: [...route.setup, await swapAndFulfil(vault, {
    ...action, payer: wallet.address, recipientOutput: walletTrump, swap: route.swap, quoteId: state.fulfilQuote,
    ...sign(state.fulfilQuote, action),
  })], minimum: route.minimumOutput };
}, (logs, before, after, stage) => {
  assert.equal(BigInt(before.vaultUsdc) - BigInt(after.vaultUsdc), oneUsdc);
  assert.equal(after.swapUsdc, before.swapUsdc);
  assert.equal(after.quoteStatus, 1);
  const paid = BigInt(after.walletTrump) - BigInt(before.walletTrump);
  assert(paid >= BigInt(stage.minimum!));
  verifyEvent(logs, "Fulfilled", state.fulfilQuote, paid);
});

await runCase("refund-after-fulfil", async before => {
  assert.equal(before.quoteStatus, 1);
  const action = { kind: "refund", recipient: wallet.address, amount: 1n } as const;
  return { instructions: [await refund(vault, {
    ...action, payer: wallet.address, quoteId: state.fulfilQuote, ...sign(state.fulfilQuote, action),
  })] };
}, unchanged);

async function failedDeposit(amount: bigint, minimum?: bigint) {
  const route = await sourceRoute(amount);
  return { instructions: [...route.setup, swapAndDeposit(vault, {
    user: wallet.address, quoteId: newQuote(), minUsdc: minimum ?? route.minimumOutput, swap: route.swap,
  })] };
}

await runCase("swap-failure", before => failedDeposit(BigInt(before.walletTrump) + 1_000_000n), unchanged);
await runCase("deposit-failure", before => {
  assert(BigInt(before.walletTrump) >= failureSwapAmount);
  return failedDeposit(failureSwapAmount, (1n << 64n) - 1n);
}, unchanged);
