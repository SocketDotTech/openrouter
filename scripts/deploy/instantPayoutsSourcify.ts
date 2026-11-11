/** Sourcify API v2. No legacy Foundry Sourcify HTTP client is used. */
import { request as httpsRequest } from 'https';
import { address, CHAIN_ID, InputError, requireValue, sha256 } from './instantPayoutsCommon';

const API = 'https://sourcify.dev/server';
const COMPILER = '0.8.30+commit.73712a01';
const IDENTIFIER = 'src/InstantPayouts.sol:InstantPayouts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Reply = { status: number; body: any };
type Transport = (path: string, body?: unknown) => Promise<Reply>;
export interface SourcifyJob {
  status: 'SUBMITTING' | 'PENDING' | 'VERIFIED';
  requestSha256: string;
  verificationId?: string;
}
export interface SourceRecord {
  plan: { expectedAddress: string };
  transactionHash: string;
  sourcifyJob?: SourcifyJob;
}

function transport(path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(API + path, { method: text ? 'POST' : 'GET', timeout: 10_000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'DTF-Instant-Payouts/1 (source verification)' } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (data.length > 1_000_000) req.destroy(new Error('Response too large'));
      });
      response.on('end', () => {
        try { resolve({ status: response.statusCode || 0, body: JSON.parse(data) }); }
        catch { reject(new InputError('Sourcify returned invalid JSON. No automatic retry was made.')); }
      });
      response.on('error', () => reject(new InputError('Sourcify response failed. No automatic retry was made.')));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', () => reject(new InputError('Sourcify request failed. Resume the saved job; no automatic submission retry was made.')));
    if (text) req.write(text);
    req.end();
  });
}

export function sourceRequest(stdJsonInput: any, transactionHash: string) {
  requireValue(stdJsonInput?.language === 'Solidity'
    && typeof stdJsonInput.sources?.['src/InstantPayouts.sol']?.content === 'string', 'Invalid Solidity standard JSON input.');
  const settings = stdJsonInput.settings;
  requireValue(settings?.optimizer?.enabled === true && settings.optimizer.runs === 200
    && settings.evmVersion === 'cancun' && settings.viaIR !== true
    && (settings.metadata?.bytecodeHash === undefined || settings.metadata.bytecodeHash === 'ipfs'),
  'Standard JSON compiler settings differ from the approved build.');
  requireValue(/^0x[0-9a-fA-F]{64}$/.test(transactionHash), 'Invalid creation transaction hash.');
  return { stdJsonInput, compilerVersion: COMPILER, contractIdentifier: IDENTIFIER,
    creationTransactionHash: transactionHash.toLowerCase() };
}
export function exactMatch(input: any, expectedAddress: string): void {
  requireValue(input && input.chainId === String(CHAIN_ID)
    && address(input.address, 'Sourcify contract') === address(expectedAddress, 'Expected contract'),
  'Sourcify returned another chain or contract.');
  requireValue(input.creationMatch === 'exact_match' && input.runtimeMatch === 'exact_match'
    && input.match === 'exact_match', 'Sourcify does not report exact creation and runtime matches.');
}
export function submittedJob(reply: Reply): string | undefined {
  if (reply.status === 409 && reply.body?.customCode === 'already_verified') return undefined;
  requireValue(reply.status === 202 && typeof reply.body?.verificationId === 'string'
    && UUID.test(reply.body.verificationId), 'Sourcify did not accept the verification job. No automatic retry was made.');
  return reply.body.verificationId;
}
export function completedJob(reply: Reply, verificationId: string, expectedAddress: string): boolean {
  requireValue(reply.status === 200 && reply.body?.verificationId === verificationId
    && typeof reply.body.isJobCompleted === 'boolean', 'Invalid Sourcify job response.');
  requireValue(!reply.body.error, 'Sourcify verification job failed. Its saved job ID is retained.');
  if (!reply.body.isJobCompleted) return false;
  exactMatch(reply.body.contract, expectedAddress);
  return true;
}

/** At most one submission and six job reads per command. A repeat resumes the saved ID. */
export async function verifySourcify(
  record: SourceRecord, standardInput: () => any, persist: () => void,
  send: Transport = transport, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
  const target = address(record.plan.expectedAddress, 'Expected contract');
  const lookup = async () => {
    const reply = await send(`/v2/contract/${CHAIN_ID}/${target}`);
    requireValue(reply.status === 200, 'Sourcify contract lookup failed. No success was recorded.');
    exactMatch(reply.body, target);
  };
  if (record.sourcifyJob) {
    requireValue(/^[0-9a-f]{64}$/.test(record.sourcifyJob.requestSha256), 'Invalid saved Sourcify request hash.');
    if (record.sourcifyJob.status === 'VERIFIED') { await lookup(); return true; }
    requireValue(record.sourcifyJob.status === 'PENDING'
      && typeof record.sourcifyJob.verificationId === 'string'
      && UUID.test(record.sourcifyJob.verificationId),
    'Sourcify submission outcome is unknown. Check the existing request before clearing its record; it will not be submitted again.');
  } else {
    const body = sourceRequest(standardInput(), record.transactionHash);
    record.sourcifyJob = { status: 'SUBMITTING', requestSha256: sha256(JSON.stringify(body)) };
    persist();
    const verificationId = submittedJob(await send(`/v2/verify/${CHAIN_ID}/${target}`, body));
    if (!verificationId) {
      await lookup(); record.sourcifyJob.status = 'VERIFIED'; persist(); return true;
    }
    record.sourcifyJob = { ...record.sourcifyJob, status: 'PENDING', verificationId };
    persist();
  }
  const verificationId = record.sourcifyJob.verificationId!;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(2_000);
    if (completedJob(await send(`/v2/verify/${verificationId}`), verificationId, target)) {
      await lookup(); record.sourcifyJob.status = 'VERIFIED'; persist(); return true;
    }
  }
  return false;
}
