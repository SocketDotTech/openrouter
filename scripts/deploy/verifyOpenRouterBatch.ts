/**
 * Verifies deployed OpenRouter source code on block explorers.
 *
 * Usage:
 *   npm run verify:openrouter
 *   npm run verify:openrouter -- polygon base arbitrum
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { readDeploymentRegistrySync } from './deploymentRegistry';
import { networkForChainId } from './openRouterBuild';

interface OpenRouterDeploymentRecord {
  chainId: number;
  network: string;
  variant: string;
  openRouter: string;
}

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;
const SOURCIFY_CHAIN_IDS = new Set([5042]);

function rpcEnvName(network: string): string {
  return `${network.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_RPC`;
}

function verifyWithHardhat(record: OpenRouterDeploymentRecord): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(
    'npx',
    [
      'hardhat',
      'verify',
      '--network',
      record.network,
      record.openRouter,
    ],
    {
      env: {
        ...process.env,
        OPENROUTER_EVM_VERSION: record.variant,
      },
      encoding: 'utf8',
    },
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function verifyWithSourcify(record: OpenRouterDeploymentRecord): {
  status: number | null;
  output: string;
} {
  const args = [
    'verify-contract',
    '--chain',
    String(record.chainId),
    '--verifier',
    'sourcify',
    '--verifier-url',
    process.env.SOURCIFY_SERVER_URL ?? 'https://sourcify.dev/server',
    '--skip-is-verified-check',
    '--compiler-version',
    '0.8.34',
    '--num-of-optimizations',
    '2000',
    '--evm-version',
    record.variant,
    '--watch',
    record.openRouter,
    'src/OpenRouter.sol:OpenRouter',
  ];
  const rpcUrl = process.env[rpcEnvName(record.network)] ?? process.env.ETH_RPC_URL;
  if (rpcUrl) {
    args.push('--rpc-url', rpcUrl);
  }

  const result = spawnSync(
    'forge',
    args,
    {
      encoding: 'utf8',
    },
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function readDeploymentRecords(): OpenRouterDeploymentRecord[] {
  return readDeploymentRegistrySync()
    .filter((row) => row.openRouterAddress)
    .map((row) => {
      const network = networkForChainId(row.chainId);
      if (!network) {
        throw new Error(`Cannot infer network for chainId=${row.chainId}`);
      }

      if (!row.openRouterAddress || !ADDR_HEX_RE.test(row.openRouterAddress)) {
        throw new Error(
          `Invalid OpenRouter address in deployments.csv for chainId=${row.chainId}: ${row.openRouterAddress}`,
        );
      }

      return {
        chainId: row.chainId,
        network,
        variant: row.variant,
        openRouter: row.openRouterAddress,
      };
    })
    .sort((a, b) => a.network.localeCompare(b.network));
}

function isAlreadyVerified(output: string): boolean {
  return /already verified|already been verified|source code already verified|exact match already verified|similar match source code/i.test(
    output,
  );
}

function main() {
  const requestedNetworks = new Set(process.argv.slice(2));
  const records = readDeploymentRecords().filter(
    (record) =>
      requestedNetworks.size === 0 || requestedNetworks.has(record.network),
  );

  if (records.length === 0) {
    throw new Error('No OpenRouter deployment records selected for verification');
  }

  const verifyDir = resolve(process.cwd(), 'deployments', 'verify', 'openrouter');
  mkdirSync(verifyDir, { recursive: true });

  const summaryPath = join(
    verifyDir,
    `summary-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.tsv`,
  );
  const rows = ['network\tchainId\tstatus\taddress'];

  for (const record of records) {
    console.log(`Verifying ${record.network} (${record.chainId})`);
    const result = SOURCIFY_CHAIN_IDS.has(record.chainId)
      ? verifyWithSourcify(record)
      : verifyWithHardhat(record);
    const output = result.output;
    writeFileSync(join(verifyDir, `${record.network}.log`), output);

    let status = 'ok';
    if (result.status !== 0) {
      status = isAlreadyVerified(output) ? 'already_verified' : 'failed';
    }

    rows.push(
      `${record.network}\t${record.chainId}\t${status}\t${record.openRouter}`,
    );
    console.log(`${record.network}: ${status}`);
  }

  writeFileSync(summaryPath, `${rows.join('\n')}\n`);
  console.log(`Summary: ${summaryPath}`);

  if (rows.some((row) => row.includes('\tfailed\t'))) {
    process.exit(1);
  }
}

main();
