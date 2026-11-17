import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressEncoder, type Address, type Instruction } from "@solana/kit";
import { concat, getAddress, getBytes, hashMessage, keccak256, recoverAddress, toBeHex } from "ethers";

export type SettlementAction =
  | { kind: "fulfil" | "refund"; recipient: Address; amount: bigint }
  | { kind: "markForRefund" }
  | {
      kind: "swapAndFulfil";
      recipient: Address;
      outputMint: Address;
      amount: bigint;
      minOutput: bigint;
      routeHash: string;
    };

const publicKey = getAddressEncoder();
const actionTag = { fulfil: 1, refund: 2, swapAndFulfil: 3, markForRefund: 4 };
const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function bytes32(value: string): Uint8Array {
  const bytes = getBytes(value);
  if (bytes.length !== 32) throw new Error("Expected 32 bytes");
  return bytes;
}

export function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

export function routeFlags(instruction: Instruction): Uint8Array {
  // Kit uses bit 0 for writable and bit 1 for signer. The RFQ program reverses them.
  return Uint8Array.from(instruction.accounts ?? [], ({ role }) =>
    ((role & 2) >> 1) | ((role & 1) << 1),
  );
}

export function routeHash(instruction: Instruction): string {
  const flags = routeFlags(instruction);
  return keccak256(concat([
    Uint8Array.from(publicKey.encode(instruction.programAddress)),
    keccak256(Uint8Array.from(instruction.data ?? [])),
    ...(instruction.accounts ?? []).map(({ address }, index) =>
      concat([Uint8Array.from(publicKey.encode(address)), Uint8Array.of(flags[index])]),
    ),
  ]));
}

export function actionDigest(params: {
  program: Address;
  vault: Address;
  quoteId: string;
  nonce: bigint;
  action: SettlementAction;
}): string {
  const { program, vault, quoteId, nonce, action } = params;
  let fields: Uint8Array[] = [];
  if (action.kind === "swapAndFulfil") {
    fields = [
      Uint8Array.from(publicKey.encode(action.recipient)),
      Uint8Array.from(publicKey.encode(action.outputMint)),
      u64(action.amount),
      u64(action.minOutput),
      bytes32(action.routeHash),
    ];
  } else if (action.kind !== "markForRefund") {
    fields = [Uint8Array.from(publicKey.encode(action.recipient)), u64(action.amount)];
  }
  return keccak256(concat([
    Buffer.from("BUNGEE_SOLANA_RFQ_V1", "ascii"),
    Uint8Array.from(publicKey.encode(program)),
    Uint8Array.from(publicKey.encode(vault)),
    Uint8Array.of(actionTag[action.kind]),
    bytes32(quoteId),
    u64(nonce),
    ...fields,
  ]));
}

export function settlementDigest(digest: string): string {
  return hashMessage(bytes32(digest));
}

export function recoverKmsSignature(der: Uint8Array, digest: string, signer: string): string {
  // Two positive secp256k1 scalars use short-form DER lengths.
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("Invalid KMS signature");
  let cursor = 2;
  const readScalar = () => {
    const type = der[cursor++];
    const length = der[cursor++];
    const bytes = der.subarray(cursor, cursor + length);
    cursor += length;
    if (type !== 2 || !length || length > 33 || bytes.length !== length ||
        bytes[0] > 0x7f || (length > 1 && bytes[0] === 0 && bytes[1] < 0x80)) {
      throw new Error("Invalid KMS signature scalar");
    }
    const scalar = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
    if (scalar === 0n || scalar >= secp256k1Order) throw new Error("Invalid KMS signature scalar");
    return scalar;
  };
  const r = toBeHex(readScalar(), 32);
  const rawS = readScalar();
  if (cursor !== der.length) throw new Error("Invalid KMS signature length");
  const s = toBeHex(rawS > secp256k1Order / 2n ? secp256k1Order - rawS : rawS, 32);
  const expected = getAddress(signer);
  for (const yParity of [0, 1] as const) {
    if (recoverAddress(digest, { r, s, yParity }) === expected) {
      return concat([r, s, Uint8Array.of(yParity)]);
    }
  }
  throw new Error("KMS signature does not match the configured signer");
}

export function signActionWithKms(params: {
  actionDigest: string;
  signer: string;
  profile: string;
  keyId: string;
  region?: string;
}): string {
  const digest = settlementDigest(params.actionDigest);
  const directory = mkdtempSync(join(tmpdir(), "rfq-kms-"));
  try {
    const file = join(directory, "digest.bin");
    writeFileSync(file, bytes32(digest), { mode: 0o600 });
    const signature = execFileSync("aws", [
      "--profile", params.profile,
      ...(params.region ? ["--region", params.region] : []),
      "kms", "sign", "--key-id", params.keyId,
      "--message", `fileb://${file}`, "--message-type", "DIGEST",
      "--signing-algorithm", "ECDSA_SHA_256", "--query", "Signature", "--output", "text",
    ], { encoding: "utf8" }).trim();
    return recoverKmsSignature(Buffer.from(signature, "base64"), digest, params.signer);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
