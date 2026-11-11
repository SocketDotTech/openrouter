/** Standalone deployment: main loads the repository .env without logging its contents. */
import { readFileSync, renameSync } from 'fs';
import { resolve } from 'path';
import { loadEnvFile } from 'node:process';
import {
  Contract, ContractFactory, JsonRpcProvider, Wallet, Transaction,
  AbiCoder, getCreateAddress, isHexString, keccak256,
} from 'ethers';
import {
  CHAIN_ID, OWNER, SIGNER, USDC, NAME, VERSION, PAYOUT_ABI, address,
  foundry, InputError, option, parseArgs, projectRoot, readJson, requireValue, safeMain, sha256, writeJson,
} from './instantPayoutsCommon';
import { SourcifyJob, verifySourcify } from './instantPayoutsSourcify';

interface Artifact {
  abi: any[];
  bytecode: { object: string };
  deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> };
}
interface Plan {
  kind: 'InstantPayouts deployment'; chainId: number; owner: string; signer: string; usdc: string;
  deployer: string; nonce: number; expectedAddress: string; artifactSha256: string;
  creationCodeHash: string; initcodeHash: string; gasEstimate: string; gasLimit: string;
  maxFeePerGas: string; maxPriorityFeePerGas: string; gasBudgetWeiExcludingL1Fee: string;
}
interface RecordFile { plan: Plan; planSha256: string; signedTransaction: string; transactionHash: string;
  result?: unknown; sourcifyJob?: SourcifyJob;
  sourceVerification?: { verifier: string; compiler: string; checkedAt: string } }

export function sourceVerificationArgs(contract: string, owner: string, signer: string, root: string, verifier: string): string[] {
  requireValue(verifier === 'sourcify' || verifier === 'etherscan', 'Use sourcify or etherscan for source verification.');
  return ['verify-contract', address(contract, 'Contract'), 'src/InstantPayouts.sol:InstantPayouts',
    '--root', root, '--chain', String(CHAIN_ID), '--verifier', verifier, '--watch',
    '--compiler-version', 'v0.8.30+commit.73712a01', '--num-of-optimizations', '200',
    '--evm-version', 'cancun', '--constructor-args',
    AbiCoder.defaultAbiCoder().encode(['address', 'address'], [address(owner, 'Owner'), address(signer, 'Signer')])];
}

function artifact(): { data: Artifact; hash: string } {
  const file = resolve(projectRoot(), 'out/InstantPayouts.sol/InstantPayouts.json');
  const data = readJson(file) as Artifact;
  requireValue(Array.isArray(data.abi) && isHexString(data.bytecode?.object)
    && isHexString(data.deployedBytecode?.object), 'Build InstantPayouts in its dedicated Foundry root first.');
  return { data, hash: sha256(readFileSync(file)) };
}
function planHash(plan: Plan): string { return sha256(JSON.stringify(plan)); }
export function runtimeMatches(code: string, template: Artifact['deployedBytecode']): boolean {
  if (!isHexString(code) || code.length !== template.object.length) return false;
  const actual = Buffer.from(code.slice(2), 'hex');
  const expected = Buffer.from(template.object.slice(2), 'hex');
  for (const entries of Object.values(template.immutableReferences)) {
    for (const { start, length } of entries) {
      if (start < 0 || length <= 0 || start + length > actual.length) return false;
      actual.fill(0, start, start + length); expected.fill(0, start, start + length);
    }
  }
  return actual.equals(expected);
}
async function initcode(data: Artifact, owner: string, signer: string): Promise<string> {
  const tx = await new ContractFactory(data.abi, data.bytecode.object).getDeployTransaction(owner, signer);
  requireValue(typeof tx.data === 'string', 'Deployment bytecode is missing.');
  return tx.data;
}
export function validatePlan(value: any): Plan {
  requireValue(value?.kind === 'InstantPayouts deployment' && value.chainId === CHAIN_ID
    && value.usdc === USDC, 'The plan is not a Base native-USDC deployment plan.');
  for (const name of ['owner', 'signer', 'deployer', 'expectedAddress']) {
    requireValue(address(value[name], name) === value[name], 'Plan addresses must be canonical.');
  }
  requireValue(value.owner !== value.signer, 'Owner and payout signer must be separate addresses.');
  requireValue(value.signer === address(SIGNER, 'Approved payout signer'), 'Plan signer differs from the approved payout KMS address.');
  requireValue(Number.isSafeInteger(value.nonce) && value.nonce >= 0, 'Invalid deployment nonce.');
  requireValue(getCreateAddress({ from: value.deployer, nonce: value.nonce }) === value.expectedAddress, 'Plan CREATE address does not match its deployer and nonce.');
  requireValue(/^[0-9a-f]{64}$/.test(value.artifactSha256), 'Invalid artifact hash.');
  for (const field of ['creationCodeHash', 'initcodeHash']) requireValue(isHexString(value[field], 32), 'Invalid bytecode hash.');
  for (const field of ['gasEstimate', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasBudgetWeiExcludingL1Fee']) {
    requireValue(typeof value[field] === 'string' && /^[0-9]+$/.test(value[field]) && BigInt(value[field]) > 0n, 'Invalid gas field.');
  }
  const keys = ['kind', 'chainId', 'owner', 'signer', 'usdc', 'deployer', 'nonce', 'expectedAddress',
    'artifactSha256', 'creationCodeHash', 'initcodeHash', 'gasEstimate', 'gasLimit', 'maxFeePerGas',
    'maxPriorityFeePerGas', 'gasBudgetWeiExcludingL1Fee'];
  requireValue(Object.keys(value).length === keys.length && keys.every(key => key in value), 'Plan has unsupported fields.');
  requireValue(BigInt(value.gasLimit) >= BigInt(value.gasEstimate)
    && BigInt(value.maxFeePerGas) >= BigInt(value.maxPriorityFeePerGas)
    && BigInt(value.gasBudgetWeiExcludingL1Fee) === BigInt(value.gasLimit) * BigInt(value.maxFeePerGas), 'Plan gas values disagree.');
  return value as Plan;
}
async function verify(provider: JsonRpcProvider, record: RecordFile, data: Artifact) {
  const { plan, transactionHash } = record;
  const receipt = await provider.getTransactionReceipt(transactionHash);
  requireValue(receipt?.status === 1 && receipt.contractAddress === plan.expectedAddress, 'Deployment is pending, failed, or has another address. Do not create another deployment.');
  const tx = await provider.getTransaction(transactionHash);
  requireValue(tx && tx.to === null && tx.from === plan.deployer && tx.nonce === plan.nonce
    && tx.chainId === BigInt(CHAIN_ID) && keccak256(tx.data) === plan.initcodeHash, 'Deployment transaction does not match the reviewed plan.');
  const block = await provider.getBlock(receipt.blockNumber);
  requireValue(block?.hash === receipt.blockHash, 'Deployment receipt is not on the current chain.');
  const code = await provider.getCode(plan.expectedAddress);
  requireValue(runtimeMatches(code, data.deployedBytecode), 'Onchain code differs from the compiled runtime.');
  const contract = new Contract(plan.expectedAddress, PAYOUT_ABI, provider);
  const [owner, signer, token, domain] = await Promise.all([
    contract.owner(), contract.payoutSigner(), contract.USDC(), contract.eip712Domain(),
  ]);
  requireValue(owner === plan.owner && signer === plan.signer && token === USDC, 'Onchain owner, payout signer, or USDC does not match.');
  requireValue(domain[0] === '0x0f' && domain[1] === NAME && domain[2] === VERSION
    && domain[3] === BigInt(CHAIN_ID) && domain[4] === plan.expectedAddress
    && BigInt(domain[5]) === 0n && domain[6].length === 0, 'Onchain EIP-712 domain does not match.');
  return { status: 'MINED_AND_CHECKED', contractAddress: plan.expectedAddress,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(), runtimeCodeHash: keccak256(code),
    owner, signer, usdc: token, finality: 'Mined receipt checked; finality is not asserted.' };
}
function saveResult(path: string, record: RecordFile): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeJson(temp, record); renameSync(temp, path);
}

export function loadDeploymentEnv(path = resolve(__dirname, '../../.env')): void {
  try { loadEnvFile(path); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw new InputError('Deployment settings could not be loaded. Details are withheld.');
  }
}

export async function main(): Promise<void> {
  loadDeploymentEnv();
  const args = parseArgs(process.argv.slice(2));
  const allowed = ['--deployer', '--output', '--plan', '--expected-plan', '--broadcast', '--nonce-coordinated', '--verify', '--verify-source', '--source-verifier'];
  requireValue(Object.keys(args).every(arg => allowed.includes(arg)), 'Unknown deployment option.');
  for (const flag of ['--broadcast', '--nonce-coordinated']) {
    requireValue(!args[flag] || args[flag] === true, `${flag} is a flag and takes no value.`);
  }
  const built = artifact();
  const rpc = process.env.BASE_RPC?.trim();
  requireValue(rpc, 'Set BASE_RPC in the environment or repository .env.');
  const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  try {
    requireValue((await provider.getNetwork()).chainId === BigInt(CHAIN_ID), 'RPC must be Base mainnet (8453).');
    requireValue(await provider.getCode(USDC) !== '0x', 'Base native USDC has no code at the expected address.');
    if (args['--verify'] || args['--verify-source']) {
      requireValue(!args['--broadcast'], '--verify cannot broadcast.');
      requireValue(!(args['--verify'] && args['--verify-source']), 'Use either --verify or --verify-source.');
      const path = option(args, args['--verify-source'] ? '--verify-source' : '--verify');
      const record = readJson(path) as RecordFile;
      record.plan = validatePlan(record.plan);
      requireValue(record.planSha256 === planHash(record.plan) && built.hash === record.plan.artifactSha256,
        'Deployment record or local artifact changed.');
      const signed = Transaction.from(record.signedTransaction);
      requireValue(signed.hash === record.transactionHash && signed.chainId === BigInt(CHAIN_ID)
        && signed.from === record.plan.deployer && signed.nonce === record.plan.nonce
        && signed.to === null && keccak256(signed.data) === record.plan.initcodeHash,
      'Stored signed transaction does not match the plan.');
      record.result = await verify(provider, record, built.data); saveResult(path, record);
      if (args['--verify-source']) {
        const verifier = args['--source-verifier'] ? option(args, '--source-verifier') : 'sourcify';
        requireValue(verifier !== 'etherscan' || process.env.ETHERSCAN_API_KEY,
          'Export ETHERSCAN_API_KEY for Etherscan/BaseScan source verification.');
        if (verifier === 'sourcify') {
          const complete = await verifySourcify(record, () => {
            const command = sourceVerificationArgs(record.plan.expectedAddress, record.plan.owner,
              record.plan.signer, projectRoot(), verifier).filter(arg => arg !== '--watch');
            const output = foundry('forge', [...command, '--show-standard-json-input']);
            try { return JSON.parse(output); }
            catch { throw new Error('Invalid compiler JSON output'); }
          }, () => saveResult(path, record));
          if (!complete) {
            console.log(`Sourcify job pending: ${record.sourcifyJob?.verificationId}. Run the same --verify-source command to continue.`);
            process.exitCode = 2; return;
          }
        } else {
          foundry('forge', sourceVerificationArgs(record.plan.expectedAddress, record.plan.owner,
            record.plan.signer, projectRoot(), verifier), { ETH_RPC_URL: rpc });
        }
        record.sourceVerification = { verifier, compiler: 'v0.8.30+commit.73712a01', checkedAt: new Date().toISOString() };
        saveResult(path, record);
        console.log(`Source verification completed with ${verifier}.`);
      }
      console.log(JSON.stringify(record.result, null, 2)); return;
    }
    if (!args['--broadcast']) {
      requireValue(!args['--plan'], 'To submit a reviewed plan, use --broadcast explicitly.');
      const deployer = address(option(args, '--deployer'), 'Deployer');
      const owner = address(process.env.OWNER_ADDRESS?.trim() || OWNER, 'OWNER_ADDRESS');
      const signer = address(process.env.PAYOUT_SIGNER_ADDRESS?.trim()
        || SIGNER, 'PAYOUT_SIGNER_ADDRESS');
      requireValue(signer === address(SIGNER, 'Approved payout signer'), 'PAYOUT_SIGNER_ADDRESS differs from the approved payout KMS address.');
      requireValue(owner !== signer, 'Owner and payout signer must be separate addresses.');
      const code = await initcode(built.data, owner, signer);
      const nonce = await provider.getTransactionCount(deployer, 'pending');
      const gasEstimate = await provider.estimateGas({ from: deployer, data: code });
      const fees = await provider.getFeeData();
      requireValue(fees.maxFeePerGas && fees.maxPriorityFeePerGas, 'RPC did not return EIP-1559 fee data.');
      const gasLimit = (gasEstimate * 130n + 99n) / 100n;
      const plan: Plan = { kind: 'InstantPayouts deployment', chainId: CHAIN_ID, owner, signer,
        usdc: USDC, deployer, nonce, expectedAddress: getCreateAddress({ from: deployer, nonce }),
        artifactSha256: built.hash, creationCodeHash: keccak256(built.data.bytecode.object),
        initcodeHash: keccak256(code), gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        gasBudgetWeiExcludingL1Fee: (gasLimit * fees.maxFeePerGas).toString() };
      validatePlan(plan); writeJson(option(args, '--output'), plan);
      console.log(JSON.stringify({ mode: 'PREPARE_ONLY', plan, planSha256: planHash(plan),
        note: 'No signature or broadcast. Gas budget excludes the Base L1 data fee.' }, null, 2));
      return;
    }
    const plan = validatePlan(readJson(option(args, '--plan')));
    requireValue(plan.deployer !== plan.signer || args['--nonce-coordinated'] === true,
      'This deployer is the payout signer. Stop its other senders and pass --nonce-coordinated.');
    if (args['--expected-plan']) requireValue(option(args, '--expected-plan') === planHash(plan), 'The expected plan hash does not match.');
    requireValue(built.hash === plan.artifactSha256, 'Artifact changed since preparation.');
    const code = await initcode(built.data, plan.owner, plan.signer);
    requireValue(keccak256(code) === plan.initcodeHash && keccak256(built.data.bytecode.object) === plan.creationCodeHash, 'Deployment bytecode changed since preparation.');
    const key = process.env.DEPLOYER_PRIVATE_KEY;
    requireValue(key && /^0x[0-9a-fA-F]{64}$/.test(key), 'Set a valid DEPLOYER_PRIVATE_KEY in the environment or repository .env.');
    const wallet = new Wallet(key);
    requireValue(wallet.address === plan.deployer, 'DEPLOYER_PRIVATE_KEY does not match the reviewed deployer.');
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(wallet.address, 'latest'), provider.getTransactionCount(wallet.address, 'pending'),
    ]);
    requireValue(latest === plan.nonce && pending === plan.nonce, 'Deployer nonce changed or has pending transactions. Prepare and review again; do not bypass coordination.');
    requireValue(await provider.getCode(plan.expectedAddress) === '0x', 'Expected deployment address already has code. Verify the prior deployment first.');
    requireValue(await provider.estimateGas({ from: wallet.address, data: code }) <= BigInt(plan.gasLimit), 'Prepared gas limit is too low. Prepare again.');
    const raw = await wallet.signTransaction({ type: 2, chainId: CHAIN_ID, nonce: plan.nonce,
      data: code, value: 0, gasLimit: plan.gasLimit,
      maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas });
    const record: RecordFile = { plan, planSha256: planHash(plan), signedTransaction: raw,
      transactionHash: keccak256(raw) };
    const output = option(args, '--output');
    // Save exact bytes before the first send. Never create another tx on an uncertain outcome.
    writeJson(output, record);
    console.log(`Deployment transaction: ${record.transactionHash}`);
    await provider.broadcastTransaction(raw);
    await provider.waitForTransaction(record.transactionHash, 2, 120_000);
    record.result = await verify(provider, record, built.data); saveResult(output, record);
    console.log(JSON.stringify(record.result, null, 2));
  } finally { provider.destroy(); }
}

if (require.main === module) void safeMain(main);
