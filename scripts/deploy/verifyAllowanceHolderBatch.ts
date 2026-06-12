/**
 * Verifies deployed AllowanceHolder source code on block explorers.
 *
 * Usage:
 *   ETHERSCAN_API_KEY=... npm run verify:allowance-holder
 *   ETHERSCAN_API_KEY=... npm run verify:allowance-holder -- polygon base
 *
 * Plume and Tempo are submitted to Sourcify because Plume's legacy explorer API
 * blocks verification POSTs from this environment and Tempo does not expose an
 * Etherscan-compatible verification API.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { readDeploymentRegistrySync } from './deploymentRegistry';
import { networkForChainId } from './openRouterBuild';

interface AllowanceHolderDeploymentRecord {
  chainId: number;
  network: string;
  variant: string;
  allowanceHolder: string;
}

type ExplorerConfig =
  | { verifier: 'etherscan'; chainArg: string }
  | { verifier: 'custom'; chainArg: string; verifierUrl: string }
  | { verifier: 'sourcify'; chainArg: string };

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;
const CONTRACT_ID = 'src/allowanceholder/AllowanceHolder.sol:AllowanceHolder';
const SOURCE_ROOT = resolve(process.cwd(), 'verification', 'allowance-holder');

const EXPLORERS_BY_CHAIN_ID = new Map<number, ExplorerConfig>([
  [1, { verifier: 'etherscan', chainArg: '1' }],
  [10, { verifier: 'etherscan', chainArg: '10' }],
  [56, { verifier: 'etherscan', chainArg: '56' }],
  [100, { verifier: 'etherscan', chainArg: '100' }],
  [130, { verifier: 'etherscan', chainArg: '130' }],
  [137, { verifier: 'etherscan', chainArg: '137' }],
  [146, { verifier: 'etherscan', chainArg: '146' }],
  [480, { verifier: 'etherscan', chainArg: '480' }],
  [999, { verifier: 'etherscan', chainArg: '999' }],
  [5000, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=5000' }],
  [8453, { verifier: 'etherscan', chainArg: '8453' }],
  [42161, { verifier: 'etherscan', chainArg: '42161' }],
  [43114, { verifier: 'etherscan', chainArg: '43114' }],
  [59144, { verifier: 'etherscan', chainArg: '59144' }],
  [747474, { verifier: 'etherscan', chainArg: '747474' }],
  [80094, { verifier: 'etherscan', chainArg: '80094' }],
  [81457, { verifier: 'etherscan', chainArg: '81457' }],
  [534352, { verifier: 'custom', chainArg: '534352', verifierUrl: 'https://scrollscan.com/api' }],
  [34443, { verifier: 'custom', chainArg: '34443', verifierUrl: 'https://explorer.mode.network/api' }],
  [57073, { verifier: 'custom', chainArg: '57073', verifierUrl: 'https://explorer.inkonchain.com/api' }],
  [1868, { verifier: 'custom', chainArg: '1868', verifierUrl: 'https://soneium.blockscout.com/api' }],
  // Forge 1.4.4 recognizes these chains poorly or not at all; use Etherscan v2 directly.
  [143, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=143' }],
  [1329, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=1329' }],
  [4326, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=4326' }],
  [5042, { verifier: 'sourcify', chainArg: '5042' }],
  [9745, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=9745' }],
  [98866, { verifier: 'sourcify', chainArg: '98866' }],
  [4217, { verifier: 'sourcify', chainArg: '4217' }],
]);

function readDeploymentRecords(): AllowanceHolderDeploymentRecord[] {
  return readDeploymentRegistrySync()
    .filter((row) => row.allowanceHolderAddress)
    .map((row) => {
      const network = networkForChainId(row.chainId);
      if (!network) {
        throw new Error(`Cannot infer network for chainId=${row.chainId}`);
      }

      if (
        !row.allowanceHolderAddress ||
        !ADDR_HEX_RE.test(row.allowanceHolderAddress)
      ) {
        throw new Error(
          `Invalid AllowanceHolder address in deployments.csv for chainId=${row.chainId}: ${row.allowanceHolderAddress}`,
        );
      }

      return {
        chainId: row.chainId,
        network,
        variant: row.variant,
        allowanceHolder: row.allowanceHolderAddress,
      };
    })
    .sort((a, b) => a.network.localeCompare(b.network));
}

function isAlreadyVerified(output: string): boolean {
  return /already verified|already been verified|source code already verified/i.test(
    output,
  );
}

function isVerified(output: string): boolean {
  return /Contract successfully verified|Pass - Verified|partially matches the deployed version/i.test(
    output,
  );
}

function rpcEnvName(network: string): string {
  return `${network.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_RPC`;
}

function verifierArgs(
  config: ExplorerConfig,
  apiKey: string,
  network: string,
): string[] {
  const args = [
    '--chain',
    config.chainArg,
    '--verifier',
    config.verifier,
  ];

  if (config.verifier === 'sourcify') {
    args.push(
      '--verifier-url',
      process.env.SOURCIFY_SERVER_URL ?? 'https://sourcify.dev/server',
      '--skip-is-verified-check',
    );
    const rpcUrl = process.env[rpcEnvName(network)] ?? process.env.ETH_RPC_URL;
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
  }

  if (config.verifier === 'custom') {
    args.push('--verifier-url', config.verifierUrl, '--verifier-api-key', apiKey);
  } else if (config.verifier === 'etherscan') {
    args.push('--etherscan-api-key', apiKey);
  }

  if (config.verifier === 'custom' && config.chainArg === '1') {
    args.push('--skip-is-verified-check');
  }

  return args;
}

function main() {
  if (!existsSync(SOURCE_ROOT)) {
    throw new Error(`AllowanceHolder verification source root not found: ${SOURCE_ROOT}`);
  }

  const apiKey = process.env.ETHERSCAN_API_KEY ?? '';
  const requestedNetworks = new Set(process.argv.slice(2));
  const records = readDeploymentRecords().filter(
    (record) =>
      requestedNetworks.size === 0 || requestedNetworks.has(record.network),
  );

  if (records.length === 0) {
    throw new Error('No AllowanceHolder deployment records selected for verification');
  }

  const verifyDir = resolve(process.cwd(), 'deployments', 'verify', 'allowance-holder');
  mkdirSync(verifyDir, { recursive: true });

  const summaryPath = join(
    verifyDir,
    `summary-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.tsv`,
  );
  const rows = ['network\tchainId\tstatus\tverifier\taddress'];

  for (const record of records) {
    const explorer = EXPLORERS_BY_CHAIN_ID.get(record.chainId);
    if (!explorer) {
      rows.push(
        `${record.network}\t${record.chainId}\tunsupported\t\t${record.allowanceHolder}`,
      );
      continue;
    }
    if (explorer.verifier !== 'sourcify' && !apiKey) {
      throw new Error('ETHERSCAN_API_KEY is required for non-Sourcify verification');
    }

    console.log(`Verifying ${record.network} (${record.chainId}) via ${explorer.verifier}`);
    const result = spawnSync(
      'forge',
      [
        'verify-contract',
        '--root',
        SOURCE_ROOT,
        ...verifierArgs(explorer, apiKey, record.network),
        '--compiler-version',
        '0.8.25',
        '--num-of-optimizations',
        '1000000',
        '--evm-version',
        record.variant,
        '--watch',
        record.allowanceHolder,
        CONTRACT_ID,
      ],
      {
        cwd: SOURCE_ROOT,
        encoding: 'utf8',
      },
    );

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    writeFileSync(join(verifyDir, `${record.network}.log`), output);

    let status = 'ok';
    if (result.status !== 0) {
      status =
        isAlreadyVerified(output) || isVerified(output)
          ? 'already_verified'
          : 'failed';
    } else if (isAlreadyVerified(output)) {
      status = 'already_verified';
    }

    rows.push(
      `${record.network}\t${record.chainId}\t${status}\t${explorer.verifier}\t${record.allowanceHolder}`,
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
