/**
 * Verifies deployed CctpClaimExecutor source code on block explorers.
 *
 * Usage:
 *   SOLVER_SIGNER_ADDRESS=0x... npm run verify:cctp-claim-executor
 *   SOLVER_SIGNER_ADDRESS=0x... npm run verify:cctp-claim-executor -- polygon base
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { request } from 'https';
import { URL } from 'url';
import { AbiCoder, ZeroAddress, isAddress } from 'ethers';
import { RECEIVER_DEPLOY_NETWORKS } from './networks';
import { readCctpClaimExecutorAddress } from './cctpClaimExecutorAddresses';
import {
  CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG,
  CCTP_CLAIM_EXECUTOR_CHAIN_IDS,
  CCTP_MESSAGE_TRANSMITTER,
} from './cctpClaimExecutorConfig';

type ExplorerConfig =
  | { verifier: 'etherscan'; chainArg: string }
  | { verifier: 'custom'; chainArg: string; verifierUrl: string }
  | { verifier: 'sourcify'; chainArg: string };

interface CctpClaimExecutorDeploymentRecord {
  chainId: number;
  network: string;
  address: string;
  constructorArgs: string;
}

const ADDR_HEX_RE = /^0x[a-fA-F0-9]{40}$/;
const CONTRACT_ID = 'src/executors/CctpClaimExecutor.sol:CctpClaimExecutor';
const DEFAULT_OWNER_ADDRESS = '0x0E1B5AB67aF1c99F8c7Ebc71f41f75D4D6211e53';
const ETHERSCAN_V2_HOST = 'api.etherscan.io';
const ETHERSCAN_V2_IPS = [
  '23.92.68.154',
  '23.111.175.138',
  '162.252.84.9',
  '217.79.240.58',
  '217.79.243.34',
];

const EXPLORERS_BY_CHAIN_ID = new Map<number, ExplorerConfig>([
  [1, { verifier: 'etherscan', chainArg: '1' }],
  [10, { verifier: 'etherscan', chainArg: '10' }],
  [130, { verifier: 'etherscan', chainArg: '130' }],
  [137, { verifier: 'etherscan', chainArg: '137' }],
  [143, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=143' }],
  [146, { verifier: 'etherscan', chainArg: '146' }],
  [480, { verifier: 'etherscan', chainArg: '480' }],
  [999, { verifier: 'etherscan', chainArg: '999' }],
  [1329, { verifier: 'custom', chainArg: '1', verifierUrl: 'https://api.etherscan.io/v2/api?chainid=1329' }],
  [8453, { verifier: 'etherscan', chainArg: '8453' }],
  [98866, { verifier: 'sourcify', chainArg: '98866' }],
  [42161, { verifier: 'etherscan', chainArg: '42161' }],
  [43114, { verifier: 'etherscan', chainArg: '43114' }],
  [57073, { verifier: 'custom', chainArg: '57073', verifierUrl: 'https://explorer.inkonchain.com/api' }],
  [59144, { verifier: 'etherscan', chainArg: '59144' }],
]);

function isAlreadyVerified(output: string): boolean {
  return /already verified|already been verified|source code already verified|exact match already verified|similar match source code/i.test(
    output,
  );
}

function isVerified(output: string): boolean {
  return /Contract successfully verified|Pass - Verified|Submitted contract for verification|partially matches the deployed version/i.test(
    output,
  );
}

function rpcEnvName(network: string): string {
  return `${network.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_RPC`;
}

function resolveAddressEnv(name: string, fallback?: string): string {
  const address = process.env[name]?.trim() ?? fallback?.trim();
  if (!address) {
    throw new Error(`${name} is required`);
  }
  if (!isAddress(address)) {
    throw new Error(`Invalid ${name}: ${address}`);
  }
  if (address.toLowerCase() === ZeroAddress.toLowerCase()) {
    throw new Error(`${name} cannot be zero`);
  }

  return address;
}

function resolveEtherscanApiKey(): string {
  return (
    process.env.ETHERSCAN_API_KEY?.trim() ||
    process.env.MAINNET_ETHERSCAN_KEY?.trim() ||
    ''
  );
}

function encodeConstructorArgs(params: {
  owner: string;
  messageTransmitter: string;
  solverSigner: string;
  usdcAddress: string;
}): string {
  return AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address'],
    [
      params.owner,
      params.messageTransmitter,
      params.solverSigner,
      params.usdcAddress,
    ],
  );
}

function verifierArgs(
  config: ExplorerConfig,
  apiKey: string,
  network: string,
): string[] {
  const args = ['--chain', config.chainArg, '--verifier', config.verifier];

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
  if (config.verifier === 'etherscan') {
    args.push('--skip-is-verified-check');
  }

  return args;
}

function isEtherscanV2Config(config: ExplorerConfig): boolean {
  return (
    config.verifier === 'etherscan' ||
    (config.verifier === 'custom' &&
      config.verifierUrl.startsWith('https://api.etherscan.io/v2/api'))
  );
}

function isSourcifyConfig(config: ExplorerConfig): boolean {
  return config.verifier === 'sourcify';
}

function etherscanV2Url(config: ExplorerConfig): string {
  if (config.verifier === 'etherscan') {
    return `https://${ETHERSCAN_V2_HOST}/v2/api?chainid=${config.chainArg}`;
  }

  if (config.verifier === 'custom') {
    return config.verifierUrl;
  }

  throw new Error('Sourcify does not use Etherscan v2');
}

function loadStandardJsonInput(): string {
  const artifact = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        'out',
        'CctpClaimExecutor.sol',
        'CctpClaimExecutor.json',
      ),
      'utf8',
    ),
  ) as { rawMetadata: string };
  const metadata = JSON.parse(artifact.rawMetadata) as {
    settings: Record<string, unknown>;
    sources: Record<string, unknown>;
  };

  const sources: Record<string, { content: string }> = {};
  for (const sourcePath of Object.keys(metadata.sources)) {
    sources[sourcePath] = {
      content: readFileSync(resolve(process.cwd(), sourcePath), 'utf8'),
    };
  }

  const settings = { ...metadata.settings } as Record<string, unknown>;
  delete settings.compilationTarget;

  return JSON.stringify({
    language: 'Solidity',
    sources,
    settings,
  });
}

function compilerVersion(): string {
  const artifact = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        'out',
        'CctpClaimExecutor.sol',
        'CctpClaimExecutor.json',
      ),
      'utf8',
    ),
  ) as { rawMetadata: string };
  const metadata = JSON.parse(artifact.rawMetadata) as {
    compiler: { version: string };
  };

  return `v${metadata.compiler.version}`;
}

function postForm(params: {
  url: string;
  form: URLSearchParams;
}): Promise<string> {
  const parsed = new URL(params.url);
  const body = params.form.toString();
  let ipIndex = 0;

  return new Promise((resolvePost, rejectPost) => {
    const req = request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
        lookup: (hostname, options, callback) => {
          if (hostname === ETHERSCAN_V2_HOST) {
            const ip = ETHERSCAN_V2_IPS[ipIndex % ETHERSCAN_V2_IPS.length];
            ipIndex += 1;
            if (typeof options === 'object' && options.all) {
              callback(
                null,
                ETHERSCAN_V2_IPS.map((address) => ({ address, family: 4 })),
              );
              return;
            }
            callback(null, ip, 4);
            return;
          }

          callback(new Error(`No custom lookup for ${hostname}`), '', 4);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolvePost(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );

    req.on('error', rejectPost);
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function verifyWithEtherscanV2Direct(params: {
  config: ExplorerConfig;
  apiKey: string;
  address: string;
  constructorArgs: string;
  standardJsonInput: string;
  compilerVersion: string;
}): Promise<{ status: number; output: string }> {
  const url = etherscanV2Url(params.config);
  const constructorArgs = params.constructorArgs.startsWith('0x')
    ? params.constructorArgs.slice(2)
    : params.constructorArgs;
  const submission = new URLSearchParams({
    apikey: params.apiKey,
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: params.address,
    sourceCode: params.standardJsonInput,
    codeformat: 'solidity-standard-json-input',
    contractname: CONTRACT_ID,
    compilerversion: params.compilerVersion,
    optimizationUsed: '1',
    runs: '2000',
    constructorArguements: constructorArgs,
    constructorArguments: constructorArgs,
    evmversion: 'cancun',
    licenseType: '13',
  });

  const submitRaw = await postForm({ url, form: submission });
  let output = `submit: ${submitRaw}\n`;
  const submit = JSON.parse(submitRaw) as {
    status?: string;
    message?: string;
    result?: string;
  };

  if (submit.status !== '1') {
    return {
      status:
        isAlreadyVerified(`${submit.message ?? ''} ${submit.result ?? ''}`)
          ? 0
          : 1,
      output,
    };
  }

  const guid = submit.result ?? '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(5_000);
    const check = new URLSearchParams({
      apikey: params.apiKey,
      module: 'contract',
      action: 'checkverifystatus',
      guid,
    });
    const checkRaw = await postForm({ url, form: check });
    output += `check ${attempt + 1}: ${checkRaw}\n`;
    const status = JSON.parse(checkRaw) as {
      status?: string;
      message?: string;
      result?: string;
    };
    const result = status.result ?? '';
    if (status.status === '1' || isVerified(result) || isAlreadyVerified(result)) {
      return { status: 0, output };
    }
    if (!/pending|in queue|already verified/i.test(result)) {
      return { status: 1, output };
    }
  }

  return { status: 1, output: `${output}timed out waiting for verification\n` };
}

async function verifyWithSourcifyV2Direct(params: {
  chainId: number;
  address: string;
  standardJsonInput: string;
  compilerVersion: string;
}): Promise<{ status: number; output: string }> {
  const baseUrl = process.env.SOURCIFY_SERVER_URL ?? 'https://sourcify.dev/server';
  const submitUrl = `${baseUrl.replace(/\/$/, '')}/v2/verify/${params.chainId}/${params.address}`;
  const submitResponse = await fetch(submitUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput: JSON.parse(params.standardJsonInput),
      compilerVersion: params.compilerVersion.replace(/^v/, ''),
      contractIdentifier: CONTRACT_ID,
    }),
  });
  const submitRaw = await submitResponse.text();
  let output = `submit ${submitResponse.status}: ${submitRaw}\n`;

  if (!submitResponse.ok) {
    return { status: 1, output };
  }

  const submit = JSON.parse(submitRaw) as { verificationId?: string };
  const verificationId = submit.verificationId;
  if (!verificationId) {
    return { status: 1, output: `${output}missing verificationId\n` };
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(5_000);
    const checkResponse = await fetch(
      `${baseUrl.replace(/\/$/, '')}/v2/verify/${verificationId}`,
    );
    const checkRaw = await checkResponse.text();
    output += `check ${attempt + 1} ${checkResponse.status}: ${checkRaw}\n`;
    if (!checkResponse.ok) {
      return { status: 1, output };
    }

    const check = JSON.parse(checkRaw) as {
      isJobCompleted?: boolean;
      contract?: {
        match?: string | null;
        creationMatch?: string | null;
        runtimeMatch?: string | null;
      };
      error?: { message?: string };
    };
    if (!check.isJobCompleted) {
      continue;
    }

    if (
      check.contract?.match ||
      check.contract?.creationMatch ||
      check.contract?.runtimeMatch
    ) {
      return { status: 0, output };
    }

    return { status: 1, output };
  }

  return { status: 1, output: `${output}timed out waiting for verification\n` };
}

async function readDeploymentRecords(params: {
  owner: string;
  solverSigner: string;
}): Promise<CctpClaimExecutorDeploymentRecord[]> {
  const records: CctpClaimExecutorDeploymentRecord[] = [];
  const requestedNetworks = new Set(process.argv.slice(2));

  for (const network of RECEIVER_DEPLOY_NETWORKS) {
    if (!CCTP_CLAIM_EXECUTOR_CHAIN_IDS.includes(network.chainId)) {
      continue;
    }

    if (
      requestedNetworks.size > 0 &&
      !requestedNetworks.has(network.name)
    ) {
      continue;
    }

    const chainConfig = CCTP_CLAIM_EXECUTOR_CHAIN_CONFIG[network.chainId];
    if (!chainConfig) {
      continue;
    }

    const address = await readCctpClaimExecutorAddress(network.name);
    if (!address) {
      throw new Error(`Missing CctpClaimExecutor address for ${network.name}`);
    }
    if (!ADDR_HEX_RE.test(address)) {
      throw new Error(
        `Invalid CctpClaimExecutor address for ${network.name}: ${address}`,
      );
    }

    records.push({
      chainId: network.chainId,
      network: network.name,
      address,
      constructorArgs: encodeConstructorArgs({
        owner: params.owner,
        messageTransmitter: chainConfig.messageTransmitter ?? CCTP_MESSAGE_TRANSMITTER,
        solverSigner: params.solverSigner,
        usdcAddress: chainConfig.usdcAddress,
      }),
    });
  }

  return records.sort((a, b) => a.network.localeCompare(b.network));
}

async function main() {
  const owner = resolveAddressEnv('OWNER_ADDRESS', DEFAULT_OWNER_ADDRESS);
  const solverSigner = resolveAddressEnv('SOLVER_SIGNER_ADDRESS');
  const standardJsonInput = loadStandardJsonInput();
  const solcVersion = compilerVersion();
  const apiKey = resolveEtherscanApiKey();
  const records = await readDeploymentRecords({ owner, solverSigner });

  if (records.length === 0) {
    throw new Error('No CctpClaimExecutor deployment records selected');
  }

  const verifyDir = resolve(
    process.cwd(),
    'deployments',
    'verify',
    'cctp-claim-executor',
  );
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
        `${record.network}\t${record.chainId}\tunsupported\t\t${record.address}`,
      );
      continue;
    }
    if (explorer.verifier !== 'sourcify' && !apiKey) {
      throw new Error('ETHERSCAN_API_KEY or MAINNET_ETHERSCAN_KEY is required');
    }

    console.log(
      `Verifying ${record.network} (${record.chainId}) via ${explorer.verifier}`,
    );
    const result = isEtherscanV2Config(explorer)
      ? await verifyWithEtherscanV2Direct({
          config: explorer,
          apiKey,
          address: record.address,
          constructorArgs: record.constructorArgs,
          standardJsonInput,
          compilerVersion: solcVersion,
        })
      : isSourcifyConfig(explorer)
        ? await verifyWithSourcifyV2Direct({
            chainId: record.chainId,
            address: record.address,
            standardJsonInput,
            compilerVersion: solcVersion,
          })
        : (() => {
            const spawned = spawnSync(
              'forge',
              [
                'verify-contract',
                ...verifierArgs(explorer, apiKey, record.network),
                '--compiler-version',
                '0.8.34',
                '--num-of-optimizations',
                '2000',
                '--evm-version',
                'cancun',
                '--constructor-args',
                record.constructorArgs,
                '--watch',
                record.address,
                CONTRACT_ID,
              ],
              {
                cwd: process.cwd(),
                encoding: 'utf8',
              },
            );

            return {
              status: spawned.status ?? 1,
              output: `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`,
            };
          })();

    const output = result.output;
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
      `${record.network}\t${record.chainId}\t${status}\t${explorer.verifier}\t${record.address}`,
    );
    console.log(`${record.network}: ${status}`);
  }

  writeFileSync(summaryPath, `${rows.join('\n')}\n`);
  console.log(`Summary: ${summaryPath}`);

  if (rows.some((row) => row.includes('\tfailed\t'))) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
