import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountRole,
  address,
  blockhash,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { SigningKey, computeAddress, getBytes, solidityPackedKeccak256, toBeHex } from "ethers";
import { actionDigest, recoverKmsSignature, settlementDigest } from "./authorization.ts";
import { anchorInstruction, fetchDflowSwap, formatSwapRoute, signV1Transaction } from "./client.ts";

const program = address("11111111111111111111111111111111");
const vault = address("11111111111111111111111111111112");
const mint = address("11111111111111111111111111111113");
const zero = toBeHex(0, 32);
const one = toBeHex(1, 32);
const two = toBeHex(2, 32);

test("settlement encoding and DER recovery match the Solana program format", () => {
  const digest = actionDigest({
    program,
    vault,
    quoteId: two,
    nonce: 2n,
    action: { kind: "refund", recipient: mint, amount: 3n },
  });
  assert.equal(digest, solidityPackedKeccak256(
    ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes8", "bytes32", "bytes8"],
    ["BUNGEE_SOLANA_RFQ_V1", zero, one, 2, two, "0x0200000000000000", two, "0x0300000000000000"],
  ));
  const messageHash = settlementDigest(digest);
  const key = new SigningKey(one);
  const signature = key.sign(messageHash);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const integer = (value: bigint) => {
    const bytes = getBytes(toBeHex(value));
    const sign = bytes[0] >= 0x80 ? [0] : [];
    return [2, sign.length + bytes.length, ...sign, ...bytes];
  };
  const derBody = [...integer(BigInt(signature.r)), ...integer(order - BigInt(signature.s))];
  const der = Uint8Array.of(0x30, derBody.length, ...derBody);
  assert.equal(recoverKmsSignature(der, messageHash, computeAddress(key.publicKey)), signature.serialized.slice(0, -2) + toBeHex(signature.yParity).slice(2));
});

test("DFlow v1 instructions retain CPI roles and compile into a signed v1 transaction", async (t) => {
  const quote = { inputMint: vault, outputMint: mint, inAmount: "2", outAmount: "4", otherAmountThreshold: "3" };
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    if (url.pathname === "/quote") {
      assert.equal(url.searchParams.get("transactionVersion"), "v1");
      assert.equal(url.searchParams.get("destinationSwap"), "true");
      return Response.json(quote);
    }
    assert.equal(url.pathname, "/swap-instructions");
    assert.equal(JSON.parse(String(options.body)).destinationTokenAccount, mint);
    return Response.json({
      transactionVersion: "v1",
      addressLookupTableAddresses: [],
      setupInstructions: [],
      swapInstruction: {
        programId: program,
        accounts: [{ pubkey: vault, isSigner: true, isWritable: false }],
        data: "AQID",
      },
      cleanupInstructions: [],
      otherInstructions: [],
      computeUnitLimit: 150_000,
      loadedAccountsDataSizeLimit: 65_536,
      prioritizationFeeLamports: 1,
    });
  });
  const dflow = await fetchDflowSwap({
    inputMint: vault,
    outputMint: mint,
    amount: 2n,
    slippageBps: 50,
    swapAuthority: vault,
    destinationTokenAccount: mint,
  });
  assert.equal(fetch.mock.callCount(), 2);
  const route = formatSwapRoute(dflow.swap, vault);
  assert.deepEqual(route.flags, Uint8Array.of(1));
  assert.deepEqual(route.remainingAccounts, [{ address: vault, role: AccountRole.READONLY }]);
  assert.equal(route.hash, solidityPackedKeccak256(
    ["bytes32", "bytes32", "bytes32", "uint8"],
    [zero, solidityPackedKeccak256(["bytes"], ["0x010203"]), one, 1],
  ));
  const feePayer = await generateKeyPairSigner();
  const transaction = await signV1Transaction({
    feePayer,
    lifetime: { blockhash: blockhash(program), lastValidBlockHeight: 1n },
    instructions: [anchorInstruction({ program, name: "deposit", accounts: [], args: route.data })],
    computeUnitLimit: dflow.suggestedComputeUnitLimit,
    loadedAccountsDataSizeLimit: dflow.suggestedLoadedAccountsDataSizeLimit,
    priorityFeeLamports: dflow.suggestedPriorityFeeLamports,
  });
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  assert.equal(message.version, 1);
  assert.ok(transaction.signatures[feePayer.address]);
});
