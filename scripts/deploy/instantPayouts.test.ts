/** Offline script checks. No RPC, real private key, KMS signing, or broadcast. */
import assert from 'assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AbiCoder, Interface, Wallet, TypedDataEncoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import {
  CHAIN_ID, NAME, VERSION, SIGNER, USDC, PAYOUT_ABI, PAYOUT_TYPES, amountUnits, typedData,
  validateTypedData, digest, projectRoot, readJson, safeMain, cast,
} from './instantPayoutsCommon';
import { encodePayoutCall, relayPayload } from './instantPayoutAuthorization';
import { completedJob, exactMatch, sourceRequest, submittedJob, verifySourcify, SourceRecord } from './instantPayoutsSourcify';

async function main() {
  const originalLoadEnvFile = process.loadEnvFile;
  let importEnvLoads = 0;
  process.loadEnvFile = () => { importEnvLoads++; };
  let deployment: typeof import('./deployInstantPayouts');
  try { deployment = require('./deployInstantPayouts'); }
  finally { process.loadEnvFile = originalLoadEnvFile; }
  assert.equal(importEnvLoads, 0, 'Importing the deployment module must not load .env');
  const { runtimeMatches, sourceVerificationArgs, validatePlan, loadDeploymentEnv } = deployment;
  const envTemp = mkdtempSync(join(tmpdir(), 'instant-payout-deploy-env-'));
  const envKeys = ['DTF_INSTANT_ENV_LOADED_TEST', 'DTF_INSTANT_ENV_PRECEDENCE_TEST'];
  const previousEnv = envKeys.map(key => process.env[key]);
  const envMessages: unknown[][] = [];
  const originalConsole = [console.log, console.error, console.warn];
  try {
    delete process.env[envKeys[0]];
    process.env[envKeys[1]] = 'inherited-fixture-value';
    writeFileSync(join(envTemp, '.env'), 'DTF_INSTANT_ENV_LOADED_TEST=fixture-only-value\nDTF_INSTANT_ENV_PRECEDENCE_TEST=file-fixture-value\n');
    console.log = console.error = console.warn = (...items) => { envMessages.push(items); };
    loadDeploymentEnv(join(envTemp, '.env'));
    assert.equal(process.env[envKeys[0]], 'fixture-only-value');
    assert.equal(process.env[envKeys[1]], 'inherited-fixture-value');
    loadDeploymentEnv(join(envTemp, 'missing.env'));
    assert.equal(process.env[envKeys[0]], 'fixture-only-value');
    assert.equal(process.env[envKeys[1]], 'inherited-fixture-value');
    assert.throws(() => loadDeploymentEnv(envTemp), error => {
      assert.equal((error as Error).message, 'Deployment settings could not be loaded. Details are withheld.');
      return true;
    });
  } finally {
    [console.log, console.error, console.warn] = originalConsole;
    envKeys.forEach((key, i) => {
      if (previousEnv[i] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[i];
    });
    rmSync(envTemp, { recursive: true, force: true });
  }
  assert.deepEqual(envMessages, [], 'Deployment environment loading must not log fixture settings');
  assert.equal(amountUnits('100'), '100000000');
  assert.equal(amountUnits('0.000001'), '1');
  assert.equal(amountUnits('80.123456'), '80123456');
  for (const value of ['0', '-1', '+1', '1e6', '0.0000001', '1.0000000', '1.2.3', ' 1', 'NaN']) {
    assert.throws(() => amountUnits(value));
  }
  const contract = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const id = '0x' + '33'.repeat(32);
  const data = typedData(contract, id, recipient, amountUnits('80'), '2000000000');
  assert.equal(data.domain.chainId, CHAIN_ID);
  assert.equal(data.domain.name, NAME); assert.equal(data.domain.version, VERSION);
  assert.deepEqual(validateTypedData(JSON.parse(JSON.stringify(data))), data);
  const abi = AbiCoder.defaultAbiCoder();
  const hash = (text: string) => keccak256(toUtf8Bytes(text));
  const domainHash = keccak256(abi.encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    hash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    hash(NAME), hash(VERSION), CHAIN_ID, contract,
  ]));
  const messageHash = keccak256(abi.encode(['bytes32', 'bytes32', 'address', 'uint256', 'uint256'], [
    hash('Payout(bytes32 payoutId,address recipient,uint256 amount,uint256 deadline)'), id, recipient, '80000000', '2000000000',
  ]));
  assert.equal(digest(data), keccak256(concat(['0x1901', domainHash, messageHash])));
  assert.equal(digest(data), TypedDataEncoder.hash(data.domain, PAYOUT_TYPES, data.message));
  for (const [group, field, value] of [
    ['domain', 'chainId', 1], ['domain', 'name', 'Other'], ['domain', 'version', '2'],
    ['message', 'extra', '0'],
  ] as const) {
    const wrong: any = JSON.parse(JSON.stringify(data)); wrong[group][field] = value;
    assert.throws(() => validateTypedData(wrong));
  }
  for (const [field, value] of [ ['payoutId', '0x' + '44'.repeat(32)], ['recipient', contract],
    ['amount', '80000001'], ['deadline', '2000000001'] ]) {
    assert.notEqual(digest(data), TypedDataEncoder.hash(data.domain, PAYOUT_TYPES, { ...data.message, [field]: value }));
  }
  assert.throws(() => typedData(contract, '0x' + '00'.repeat(32), recipient, '1', '1'));
  assert.throws(() => typedData(contract, id, contract, '1', '1'));
  assert.throws(() => typedData(contract, id, USDC, '1', '1'));
  // A public test fixture key cannot create a manual relay for the production KMS signer.
  const fixture = new Wallet('0x' + '00'.repeat(31) + '01');
  const signature = await fixture.signTypedData(data.domain, PAYOUT_TYPES, data.message);
  const relay = encodePayoutCall(data, signature);
  const decoded = new Interface(PAYOUT_ABI).decodeFunctionData('payout', relay.data);
  assert.equal(relay.to, contract); assert.equal(relay.chainId, 8453); assert.equal(relay.value, '0');
  assert.deepEqual([...decoded], [id, recipient, 80000000n, 2000000000n, signature]);
  assert.throws(() => relayPayload({ typedData: data, digest: digest(data), signature }, SIGNER), /expected current payout signer/);
  assert.throws(() => relayPayload({ typedData: data, digest: '0x' + '00'.repeat(32), signature }, SIGNER), /digest/);
  assert.notEqual(fixture.address.toLowerCase(), SIGNER.toLowerCase());
  assert.deepEqual(relayPayload({ typedData: data, digest: digest(data), signature }, fixture.address), relay);
  const rotated = new Wallet('0x' + '00'.repeat(31) + '02');
  const rotatedSignature = await rotated.signTypedData(data.domain, PAYOUT_TYPES, data.message);
  const rotatedInput = { typedData: data, digest: digest(data), signature: rotatedSignature };
  assert.throws(() => relayPayload(rotatedInput, fixture.address), /expected current payout signer/);
  assert.deepEqual(relayPayload(rotatedInput, rotated.address), encodePayoutCall(data, rotatedSignature));
  assert.throws(() => relayPayload(rotatedInput, '0x' + '00'.repeat(20)), /nonzero/);
  const controls = new Interface(PAYOUT_ABI);
  assert.equal(controls.decodeFunctionData('setPayoutSigner', controls.encodeFunctionData('setPayoutSigner', [rotated.address]))[0], rotated.address);
  assert.deepEqual([...controls.decodeFunctionData('rescueNative', controls.encodeFunctionData('rescueNative', [recipient, 123n]))], [recipient, 123n]);

  const template = { object: '0x01020304', immutableReferences: { key: [{ start: 1, length: 1 }] } };
  assert(runtimeMatches('0x01ff0304', template));
  assert(!runtimeMatches('0x01ff0305', template));
  assert(!runtimeMatches('0x01ff03', template));
  assert.throws(() => validatePlan({ kind: 'InstantPayouts deployment', chainId: 1, usdc: USDC }));
  const verifyArgs = sourceVerificationArgs(contract, recipient, SIGNER, '/tmp/example', 'sourcify');
  assert(verifyArgs.includes('v0.8.30+commit.73712a01'));
  assert(verifyArgs.includes('--watch') && verifyArgs.includes('200') && verifyArgs.includes('cancun'));
  assert.equal(verifyArgs[verifyArgs.length - 1], abi.encode(['address', 'address'], [recipient, SIGNER]));
  assert.throws(() => sourceVerificationArgs(contract, recipient, SIGNER, '/tmp/example', 'other'));

  const verificationId = '72d12273-0723-448e-a9f6-f7957128efa5';
  const matched = { match: 'exact_match', creationMatch: 'exact_match', runtimeMatch: 'exact_match', chainId: '8453', address: contract };
  const pending = { status: 200, body: { verificationId, isJobCompleted: false } };
  const complete = { status: 200, body: { verificationId, isJobCompleted: true, contract: matched } };
  assert.equal(submittedJob({ status: 202, body: { verificationId } }), verificationId);
  assert.equal(submittedJob({ status: 409, body: { customCode: 'already_verified' } }), undefined);
  assert.throws(() => submittedJob({ status: 200, body: { verificationId } }));
  assert.throws(() => submittedJob({ status: 202, body: {} }));
  assert.throws(() => submittedJob({ status: 429, body: {} }));
  assert.equal(completedJob(pending, verificationId, contract), false);
  assert.equal(completedJob(complete, verificationId, contract), true);
  assert.throws(() => completedJob({ status: 200, body: { ...complete.body, error: { customCode: 'compiler_error' } } }, verificationId, contract));
  assert.throws(() => completedJob(complete, '00000000-0000-0000-0000-000000000000', contract));
  assert.throws(() => exactMatch({ ...matched, chainId: '1' }, contract));
  assert.throws(() => exactMatch({ ...matched, creationMatch: 'match' }, contract));
  assert.throws(() => exactMatch({ ...matched, runtimeMatch: null }, contract));
  const standardInput = { language: 'Solidity', sources: { 'src/InstantPayouts.sol': { content: 'contract InstantPayouts {}' } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', metadata: { bytecodeHash: 'ipfs' } } };
  const creationHash = '0x' + '55'.repeat(32);
  const request = sourceRequest(standardInput, creationHash);
  assert.equal(request.compilerVersion, '0.8.30+commit.73712a01');
  assert.equal(request.contractIdentifier, 'src/InstantPayouts.sol:InstantPayouts');
  assert.equal(request.creationTransactionHash, creationHash);
  assert.throws(() => sourceRequest({ ...standardInput, settings: { ...standardInput.settings, evmVersion: 'paris' } }, creationHash));
  const record: SourceRecord = { plan: { expectedAddress: contract }, transactionHash: creationHash };
  const saved: any[] = [];
  let posts = 0;
  const send = async (path: string, body?: unknown) => {
    if (body !== undefined) { posts++; assert.deepEqual(body, request); return { status: 202, body: { verificationId } }; }
    assert.equal(record.sourcifyJob?.verificationId, verificationId);
    return path.includes('/v2/contract/') ? { status: 200, body: matched } : pending;
  };
  const persist = () => { saved.push(JSON.parse(JSON.stringify(record))); };
  assert.equal(await verifySourcify(record, () => standardInput, persist, send, async () => {}), false);
  assert.equal(posts, 1); assert.equal(record.sourcifyJob?.status, 'PENDING');
  assert.equal(saved[0].sourcifyJob.status, 'SUBMITTING');
  assert.equal(saved[1].sourcifyJob.verificationId, verificationId);
  assert.equal(await verifySourcify(record, () => { throw new Error('Must resume, not resubmit'); }, persist,
    async (path, body) => { assert.equal(body, undefined); return path.includes('/v2/contract/') ? { status: 200, body: matched } : complete; },
    async () => {}), true);
  assert.equal(posts, 1); assert.equal(record.sourcifyJob?.status, 'VERIFIED');
  const uncertain: SourceRecord = { plan: { expectedAddress: contract }, transactionHash: creationHash };
  await assert.rejects(verifySourcify(uncertain, () => standardInput, () => {}, async () => { throw new Error('HTTP outcome unknown'); }, async () => {}));
  assert.equal(uncertain.sourcifyJob?.status, 'SUBMITTING');
  await assert.rejects(verifySourcify(uncertain, () => standardInput, () => {}, async () => { assert.fail('Must not resubmit'); }, async () => {}), /outcome is unknown/);

  const temp = mkdtempSync(join(tmpdir(), 'instant-payout-script-check-'));
  const previous = process.env.INSTANT_PAYOUTS_ROOT;
  try {
    process.env.INSTANT_PAYOUTS_ROOT = temp;
    assert.throws(projectRoot, /foundry.toml/);
    writeFileSync(join(temp, 'foundry.toml'), '[profile.default]\n');
    assert.equal(projectRoot(), temp);
    writeFileSync(join(temp, '.env'), '');
    assert.throws(projectRoot, /contains .env/);
    assert.throws(() => cast(['--version']), /contains .env/);
    assert.throws(() => readJson(join(temp, '.env')), /.env files/);
    symlinkSync(join(temp, '.env'), join(temp, 'input.json'));
    assert.throws(() => readJson(join(temp, 'input.json')), /.env files/);
  } finally {
    if (previous === undefined) delete process.env.INSTANT_PAYOUTS_ROOT;
    else process.env.INSTANT_PAYOUTS_ROOT = previous;
    rmSync(temp, { recursive: true, force: true });
  }
  const messages: unknown[][] = [];
  const log = console.error;
  const exitCode = process.exitCode;
  console.error = (...items) => { messages.push(items); };
  try { await safeMain(async () => { throw new Error('https://user:PRIVATE@rpc.invalid/PRIVATE'); }); }
  finally { console.error = log; process.exitCode = exitCode; }
  assert(!JSON.stringify(messages).includes('PRIVATE'));
  assert(JSON.stringify(messages).includes('withheld'));
  console.log(`Fixture EIP-712 digest: ${digest(data)}`);
  console.log('Offline script checks passed: exact amounts, EIP-712 fields/hash, positive calldata, current/rotated signer, native rescue ABI, code mask, chain, scoped synthetic deployment env loading, inherited precedence, no import-time .env reads, error redaction, and Sourcify v2 responses/resume.');
}

main().catch(() => { console.error('Offline script checks failed.'); process.exitCode = 1; });
