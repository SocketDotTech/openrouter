import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AccountRole, address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports,
  type Address, type Instruction, type TransactionSigner,
} from "@solana/kit";
import { SigningKey, computeAddress, concat, toBeHex } from "ethers";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { actionDigest, routeHash, settlementDigest, u64, type SettlementAction } from "./authorization.ts";
import { signV1Transaction } from "./client.ts";
import {
  RFQ_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, deposit, deriveQuoteState, deriveTokenAccount,
  deriveVaultAccounts, fulfil, initialize, markForRefund, refund, rescueFunds, setSolver, swapAndDeposit, swapAndFulfil,
} from "./instructions.ts";

const FIXTURE_SWAP = address("5oEzAP4izB65uRm2yDAEf9oALGwHpWkDfyKb8zBY3euC");
const TEST_SOLVER = new SigningKey(toBeHex(7, 32));

function sign(vault: Address, quoteId: string, action: SettlementAction, key = TEST_SOLVER) {
  const digest = actionDigest({ program: RFQ_PROGRAM, vault, quoteId, nonce: 1n, action });
  const { r, s, yParity } = key.sign(settlementDigest(digest));
  return concat([r, s, toBeHex(yParity, 1)]);
}

function localBank() {
  const svm = new LiteSVM();
  const program = fileURLToPath(new URL("../target/deploy/solana_rfq_vault.so", import.meta.url));
  svm.addProgramFromFile(RFQ_PROGRAM, program);
  const addressEncoder = getAddressEncoder();

  function setAccount(address: Address, data: Buffer) {
    svm.setAccount({
      address, data, executable: false, lamports: lamports(3_000_000n),
      programAddress: TOKEN_PROGRAM, space: BigInt(data.length),
    });
  }

  function setMint(address: Address) {
    const data = Buffer.alloc(82);
    data[44] = 6;
    data[45] = 1;
    setAccount(address, data);
  }

  async function setTokenAccount(owner: Address, mint: Address, amount: bigint) {
    const ata = await deriveTokenAccount(owner, mint);
    const data = Buffer.alloc(165);
    data.set(addressEncoder.encode(mint), 0);
    data.set(addressEncoder.encode(owner), 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    setAccount(ata, data);
    return ata;
  }

  function accountData(address: Address) {
    const account = svm.getAccount(address);
    assert.ok(account.exists);
    return Buffer.from(account.data);
  }

  async function send(feePayer: TransactionSigner, instructions: Instruction[], expectedFailure?: RegExp) {
    const tx = await signV1Transaction({
      feePayer, instructions,
      lifetime: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n },
      computeUnitLimit: 400_000,
      loadedAccountsDataSizeLimit: 8 * 1024 * 1024,
      priorityFeeLamports: 0n,
    });
    const result = svm.sendTransaction(tx);
    if (expectedFailure) {
      assert.ok(result instanceof FailedTransactionMetadata);
      assert.match(result.meta().logs().join("\n"), expectedFailure);
    } else if (result instanceof FailedTransactionMetadata) {
      assert.fail(result.meta().logs().join("\n"));
    }
  }

  return {
    svm, send, setMint, setTokenAccount, accountData,
    balance: (account: Address) => accountData(account).readBigUInt64LE(64),
  };
}

async function initializeVaults(
  bank: ReturnType<typeof localBank>,
  owners: readonly TransactionSigner[],
  usdcMint: Address,
  swapProgram: Address,
) {
  const solver = computeAddress(TEST_SOLVER.publicKey);
  return Promise.all(owners.map(async (owner) => {
    const vault = await deriveVaultAccounts({ owner: owner.address, usdcMint, swapProgram });
    await bank.send(owner, [initialize(vault, solver)]);
    return vault;
  }));
}

test("Solana v1 pays once or marks the destination before refunding the origin", async () => {
  const bank = localBank();
  const { svm, send, balance } = bank;
  const [sourceOwner, destinationOwner, payer, secondPayer, receiver, mint] = await Promise.all(
    Array.from({ length: 6 }, () => generateKeyPairSigner()),
  );
  for (const wallet of [sourceOwner, destinationOwner, payer, secondPayer]) {
    assert.ok(!(svm.airdrop(wallet.address, lamports(500_000_000n)) instanceof FailedTransactionMetadata));
  }
  bank.setMint(mint.address);
  const [source, destination] = await initializeVaults(bank, [sourceOwner, destinationOwner], mint.address, SYSTEM_PROGRAM);
  const sourceUsdc = await bank.setTokenAccount(sourceOwner.address, mint.address, 1_000n);
  await bank.setTokenAccount(destinationOwner.address, mint.address, 1_000n);
  const receiverUsdc = await bank.setTokenAccount(receiver.address, mint.address, 0n);

  const paidQuote = toBeHex(1, 32);
  const cancelledQuote = toBeHex(2, 32);
  const user = sourceOwner.address;
  const repeatedDeposit = await deposit(source, { user, quoteId: toBeHex(4, 32), amount: 20n });
  await send(sourceOwner, [repeatedDeposit]);
  svm.expireBlockhash();
  await send(sourceOwner, [repeatedDeposit]);
  assert.equal(balance(sourceUsdc), 960n);
  assert.equal(balance(source.vaultUsdc), 40n);

  await send(sourceOwner, [await deposit(source, { user, quoteId: paidQuote, amount: 100n })]);
  await send(sourceOwner, [await deposit(source, { user, quoteId: cancelledQuote, amount: 100n })]);
  await send(destinationOwner, [await deposit(destination, { user: destinationOwner.address, quoteId: toBeHex(3, 32), amount: 500n })]);

  const fill = { kind: "fulfil", recipient: receiver.address, amount: 80n } as const;
  const paid = {
    quoteId: paidQuote, nonce: 1n, recipient: fill.recipient, amount: fill.amount,
    signature: sign(destination.vault, paidQuote, fill),
  };
  await send(payer, [await fulfil(destination, { ...paid, payer: payer.address, amount: 81n })], /InvalidSignature/);
  assert.equal(svm.getAccount(await deriveQuoteState(destination, paidQuote)).exists, false);
  assert.equal(balance(destination.vaultUsdc), 500n);
  assert.equal(balance(receiverUsdc), 0n);
  await send(payer, [await fulfil(destination, { ...paid, payer: payer.address })]);
  await send(secondPayer, [await fulfil(destination, { ...paid, payer: secondPayer.address })], /already in use/);
  await send(secondPayer, [await markForRefund(destination, {
    quoteId: paidQuote, nonce: 1n, payer: secondPayer.address,
    signature: sign(destination.vault, paidQuote, { kind: "markForRefund" }),
  })], /already in use/);

  const cancelled = { quoteId: cancelledQuote, nonce: 1n, payer: payer.address };
  await send(payer, [await markForRefund(destination, {
    ...cancelled, signature: sign(destination.vault, cancelledQuote, { kind: "markForRefund" }),
  })]);
  await send(payer, [await fulfil(destination, {
    ...cancelled, recipient: fill.recipient, amount: fill.amount,
    signature: sign(destination.vault, cancelledQuote, fill),
  })], /already in use/);
  const originRefund = { kind: "refund", recipient: sourceOwner.address, amount: 100n } as const;
  const refundPayment = {
    ...cancelled, recipient: originRefund.recipient, amount: originRefund.amount,
    signature: sign(source.vault, cancelledQuote, originRefund),
  };
  await send(payer, [await refund(source, refundPayment)]);
  await send(secondPayer, [await refund(source, { ...refundPayment, payer: secondPayer.address })], /already in use/);

  assert.equal(balance(receiverUsdc), 80n);
  assert.equal(balance(sourceUsdc), 860n);
  assert.equal(balance(source.vaultUsdc), 140n);
  assert.equal(balance(destination.vaultUsdc), 420n);
  assert.equal(bank.accountData(await deriveQuoteState(destination, paidQuote))[8], 1);
  assert.equal(bank.accountData(await deriveQuoteState(destination, cancelledQuote))[8], 4);
  assert.equal(bank.accountData(await deriveQuoteState(source, cancelledQuote))[8], 2);

  const rotatedKey = new SigningKey(toBeHex(8, 32));
  const rotatedSolver = computeAddress(rotatedKey.publicKey);
  const unprivileged = { ...destination, owner: payer.address };
  const rescue = { recipient: receiver.address, amount: 10n };
  await send(payer, [setSolver(unprivileged, rotatedSolver)], /ConstraintHasOne/);
  await send(payer, [await rescueFunds(unprivileged, rescue)], /ConstraintHasOne/);
  assert.equal(balance(receiverUsdc), 80n);
  assert.equal(balance(destination.vaultUsdc), 420n);
  await send(destinationOwner, [setSolver(destination, rotatedSolver)]);
  await send(destinationOwner, [await rescueFunds(destination, rescue)]);
  assert.equal(balance(receiverUsdc), 90n);
  assert.equal(balance(destination.vaultUsdc), 410n);

  const rotateQuote = toBeHex(5, 32);
  const mark = { kind: "markForRefund" } as const;
  const markParams = { payer: secondPayer.address, quoteId: rotateQuote, nonce: 1n };
  await send(secondPayer, [await markForRefund(destination, {
    ...markParams, signature: sign(destination.vault, rotateQuote, mark),
  })], /InvalidSignature/);
  assert.equal(svm.getAccount(await deriveQuoteState(destination, rotateQuote)).exists, false);
  await send(secondPayer, [await markForRefund(destination, {
    ...markParams, signature: sign(destination.vault, rotateQuote, mark, rotatedKey),
  })]);
  assert.equal(bank.accountData(await deriveQuoteState(destination, rotateQuote))[8], 4);
});

test("Solana v1 swaps deposits and settlements, rolling back below either minimum", async () => {
  const bank = localBank();
  const { svm, send, balance } = bank;
  svm.addProgramFromFile(FIXTURE_SWAP, fileURLToPath(new URL("fixtures/swap-program/target/deploy/rfq_fixture_swap.so", import.meta.url)));
  const [sourceOwner, destinationOwner, recipient, stable, other] = await Promise.all(
    Array.from({ length: 5 }, () => generateKeyPairSigner()),
  );
  for (const wallet of [sourceOwner, destinationOwner, recipient]) {
    assert.ok(!(svm.airdrop(wallet.address, lamports(500_000_000n)) instanceof FailedTransactionMetadata));
  }
  const usdc = stable.address;
  const outputMint = other.address;
  bank.setMint(usdc);
  bank.setMint(outputMint);
  const [source, destination] = await initializeVaults(bank, [sourceOwner, destinationOwner], usdc, FIXTURE_SWAP);
  const [pool] = await getProgramDerivedAddress({ programAddress: FIXTURE_SWAP, seeds: ["pool"] });
  const poolUsdc = await bank.setTokenAccount(pool, usdc, 1000n);
  const poolOther = await bank.setTokenAccount(pool, outputMint, 1000n);
  const userOther = await bank.setTokenAccount(sourceOwner.address, outputMint, 100n);
  const receiverOther = await bank.setTokenAccount(recipient.address, outputMint, 0n);
  await bank.setTokenAccount(destinationOwner.address, usdc, 1000n);
  await send(destinationOwner, [await deposit(destination, { user: destinationOwner.address, quoteId: toBeHex(9, 32), amount: 500n })]);

  function swap(authority: Address, inputMint: Address, input: Address, poolInput: Address,
    targetMint: Address, poolOutput: Address, output: Address, amountIn: bigint, amountOut: bigint): Instruction {
    const { READONLY, READONLY_SIGNER, WRITABLE } = AccountRole;
    return {
      programAddress: FIXTURE_SWAP,
      accounts: [
        { address: authority, role: READONLY_SIGNER },
        { address: inputMint, role: READONLY },
        { address: input, role: WRITABLE },
        { address: poolInput, role: WRITABLE },
        { address: targetMint, role: READONLY },
        { address: poolOutput, role: WRITABLE },
        { address: output, role: WRITABLE },
        { address: pool, role: READONLY },
        { address: TOKEN_PROGRAM, role: READONLY },
      ],
      data: Buffer.concat([u64(amountIn), u64(amountOut)]),
    };
  }

  const quoteId = toBeHex(10, 32);
  const origin = {
    user: sourceOwner.address, quoteId,
    swap: swap(sourceOwner.address, outputMint, userOther, poolOther, usdc, poolUsdc, source.vaultUsdc, 60n, 200n),
  };
  await send(sourceOwner, [swapAndDeposit(source, { ...origin, minUsdc: 201n })], /InsufficientOutput/);
  assert.equal(balance(userOther), 100n);
  assert.equal(balance(source.vaultUsdc), 0n);
  assert.equal(balance(poolUsdc), 1000n);
  await send(sourceOwner, [swapAndDeposit(source, { ...origin, minUsdc: 190n })]);
  assert.equal(balance(userOther), 40n);
  assert.equal(balance(source.vaultUsdc), 200n);

  const destinationSwap = swap(destination.swapAuthority, usdc, destination.swapUsdc, poolUsdc,
    outputMint, poolOther, receiverOther, 180n, 45n);
  const settlement = {
    payer: destinationOwner.address, nonce: 1n, quoteId, recipient: recipient.address,
    recipientOutput: receiverOther, amount: 180n, outputMint, swap: destinationSwap,
  };
  const action = { kind: "swapAndFulfil", recipient: recipient.address, amount: 180n, outputMint, routeHash: routeHash(destinationSwap) } as const;
  await send(destinationOwner, [await swapAndFulfil(destination, {
    ...settlement, minOutput: 46n, signature: sign(destination.vault, quoteId, { ...action, minOutput: 46n }),
  })], /InsufficientOutput/);
  assert.equal(svm.getAccount(await deriveQuoteState(destination, quoteId)).exists, false);
  assert.equal(balance(destination.vaultUsdc), 500n);
  assert.equal(balance(destination.swapUsdc), 0n);
  assert.equal(balance(receiverOther), 0n);
  assert.equal(balance(poolUsdc), 800n);
  assert.equal(balance(poolOther), 1060n);

  await send(destinationOwner, [await swapAndFulfil(destination, {
    ...settlement, minOutput: 45n, signature: sign(destination.vault, quoteId, { ...action, minOutput: 45n }),
  })]);
  assert.equal(balance(destination.vaultUsdc), 320n);
  assert.equal(balance(destination.swapUsdc), 0n);
  assert.equal(balance(receiverOther), 45n);
  assert.equal(bank.accountData(await deriveQuoteState(destination, quoteId))[8], 1);
});
