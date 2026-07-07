import { execFileSync } from 'child_process';
import { createPublicKey } from 'crypto';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { blake2b } from '@noble/hashes/blake2b';
import { keccak256 } from 'ethers';

dotenvConfig({ path: resolve(__dirname, '../../.env') });

type AwsKmsPublicKeyResponse = {
  KeyId?: string;
  KeySpec?: string;
  PublicKey?: string;
  SigningAlgorithms?: string[];
};

type ParsedArgs = {
  keyId?: string;
  region?: string;
};

const SUI_SECP256K1_SCHEME_FLAG = 0x01;

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--key-id') {
      args.keyId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--key-id=')) {
      args.keyId = arg.slice('--key-id='.length);
      continue;
    }
    if (arg === '--region') {
      args.region = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--region=')) {
      args.region = arg.slice('--region='.length);
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printUsage(): void {
  console.log(`Usage:
  AWS_KMS_KEY_ID=<key-id-or-arn> AWS_KMS_REGION=<region> yarn sui:rfq-vault:kms-solver
  yarn sui:rfq-vault:kms-solver -- --key-id <key-id-or-arn> --region <region>

Prints the compressed secp256k1 public key for SUI_RFQ_VAULT_SOLVER_PUBLIC_KEY
and the Sui secp256k1 address derived from the same AWS KMS key.`);
}

function requireValue(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function getKmsPublicKey(keyId: string, region: string): AwsKmsPublicKeyResponse {
  try {
    const stdout = execFileSync(
      'aws',
      [
        'kms',
        'get-public-key',
        '--key-id',
        keyId,
        '--region',
        region,
        '--output',
        'json',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    return JSON.parse(stdout) as AwsKmsPublicKeyResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to read AWS KMS public key. Ensure the AWS CLI is installed, authenticated, and allowed to call kms:GetPublicKey. ${message}`,
    );
  }
}

function compressSecp256k1PublicKey(spkiDer: Buffer): {
  compressedPublicKey: Buffer;
  uncompressedPublicKey: Buffer;
} {
  const key = createPublicKey({
    key: spkiDer,
    format: 'der',
    type: 'spki',
  });
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`KMS public key must be elliptic curve; got ${key.asymmetricKeyType}`);
  }
  if (details?.namedCurve && details.namedCurve !== 'secp256k1') {
    throw new Error(`KMS public key must use secp256k1; got ${details.namedCurve}`);
  }

  const jwk = key.export({ format: 'jwk' }) as {
    crv?: string;
    x?: string;
    y?: string;
  };
  if (!jwk.x || !jwk.y) {
    throw new Error('KMS public key did not export x/y coordinates');
  }

  const x = leftPad32(base64UrlToBuffer(jwk.x));
  const y = leftPad32(base64UrlToBuffer(jwk.y));
  const yIsOdd = (y[y.length - 1] & 1) === 1;
  const compressedPublicKey = Buffer.concat([
    Buffer.from([yIsOdd ? 0x03 : 0x02]),
    x,
  ]);

  return {
    compressedPublicKey,
    uncompressedPublicKey: Buffer.concat([x, y]),
  };
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

function toHex(value: Uint8Array | Buffer): string {
  return `0x${Buffer.from(value).toString('hex')}`;
}

function deriveSuiSecp256k1Address(compressedPublicKey: Buffer): string {
  const digest = blake2b(
    Buffer.concat([
      Buffer.from([SUI_SECP256K1_SCHEME_FLAG]),
      compressedPublicKey,
    ]),
    { dkLen: 32 },
  );
  return toHex(digest);
}

function deriveEvmAddress(uncompressedPublicKey: Buffer): string {
  return `0x${keccak256(uncompressedPublicKey).slice(-40)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keyId = requireValue('AWS_KMS_KEY_ID or --key-id', args.keyId ?? process.env.AWS_KMS_KEY_ID);
  const region = requireValue('AWS_KMS_REGION or --region', args.region ?? process.env.AWS_KMS_REGION);
  const response = getKmsPublicKey(keyId, region);

  if (response.KeySpec !== 'ECC_SECG_P256K1') {
    throw new Error(`KMS key must be ECC_SECG_P256K1; got ${response.KeySpec ?? 'unknown'}`);
  }
  if (!response.PublicKey) {
    throw new Error('KMS response did not include PublicKey');
  }

  const { compressedPublicKey, uncompressedPublicKey } =
    compressSecp256k1PublicKey(Buffer.from(response.PublicKey, 'base64'));

  console.log('AWS KMS solver key');
  console.log(`KeySpec: ${response.KeySpec}`);
  console.log(`SigningAlgorithms: ${(response.SigningAlgorithms ?? []).join(', ') || 'unknown'}`);
  console.log('');
  console.log(`SUI_RFQ_VAULT_SOLVER_PUBLIC_KEY=${toHex(compressedPublicKey)}`);
  console.log(`Sui secp256k1 address: ${deriveSuiSecp256k1Address(compressedPublicKey)}`);
  console.log(`EVM address from same key: ${deriveEvmAddress(uncompressedPublicKey)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
