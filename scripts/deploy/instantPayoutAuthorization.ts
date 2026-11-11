/** Offline EIP-712 preparation/calldata; KMS is used only by explicit sign mode. */
import { Contract, Interface, JsonRpcProvider, verifyTypedData } from 'ethers';
import {
  CHAIN_ID, USDC, NAME, VERSION, PAYOUT_ABI, PAYOUT_TYPES, address,
  amountUnits, cast, digest, option, parseArgs, readJson, requireValue,
  safeMain, typedData, validateTypedData, writeJson, Authorization,
} from './instantPayoutsCommon';

export function encodePayoutCall(data: Authorization, signature: string) {
  const m = data.message;
  return { chainId: CHAIN_ID, to: data.domain.verifyingContract, value: '0',
    data: new Interface(PAYOUT_ABI).encodeFunctionData('payout', [
      m.payoutId, m.recipient, m.amount, m.deadline, signature,
    ]), payoutId: m.payoutId, recipient: m.recipient, amount: m.amount, deadline: m.deadline };
}
export function relayPayload(input: any, expectedSigner: string) {
  const data = validateTypedData(input.typedData);
  requireValue(input.digest === digest(data), 'Authorization digest does not match its fields.');
  const signer = address(verifyTypedData(data.domain, PAYOUT_TYPES, data.message, input.signature), 'Recovered signer');
  requireValue(signer === address(expectedSigner, 'Expected payout signer'), 'Signature is not from the expected current payout signer.');
  return encodePayoutCall(data, input.signature);
}
export async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const allowed = ['--contract', '--payout-id', '--recipient', '--amount', '--deadline',
    '--input', '--output', '--execute-kms-sign', '--kms-key-id', '--signer'];
  requireValue(Object.keys(args).every(arg => allowed.includes(arg)), 'Unknown authorization option.');
  if (mode === 'prepare') {
    const data = typedData(option(args, '--contract'), option(args, '--payout-id'),
      option(args, '--recipient'), amountUnits(option(args, '--amount')), option(args, '--deadline'));
    const result = { typedData: data, digest: digest(data) };
    writeJson(option(args, '--output'), result); console.log(JSON.stringify(result, null, 2)); return;
  }
  requireValue(mode === 'hash' || mode === 'sign' || mode === 'calldata', 'Use prepare, hash, sign, or calldata.');
  const input = readJson(option(args, '--input'));
  const data = validateTypedData(input.typedData);
  requireValue(input.digest === digest(data), 'Authorization digest does not match its fields.');
  if (mode === 'hash') { console.log(digest(data)); return; }
  if (mode === 'calldata') {
    const result = relayPayload(input, option(args, '--signer'));
    if (args['--output']) writeJson(option(args, '--output'), result);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  requireValue(args['--execute-kms-sign'] === true, 'Signing requires --execute-kms-sign. No KMS call was made.');
  requireValue(BigInt(data.message.deadline) > BigInt(Math.floor(Date.now() / 1000)), 'Authorization deadline has expired.');
  const keyId = typeof args['--kms-key-id'] === 'string' ? args['--kms-key-id'] : process.env.AWS_KMS_KEY_ID;
  requireValue(keyId, 'Export AWS_KMS_KEY_ID or supply --kms-key-id.');
  const rpc = process.env.BASE_RPC?.trim();
  requireValue(rpc, 'Export BASE_RPC explicitly. The script does not load .env.');
  const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  try {
    requireValue((await provider.getNetwork()).chainId === BigInt(CHAIN_ID), 'RPC must be Base mainnet (8453).');
    requireValue(await provider.getCode(data.domain.verifyingContract) !== '0x', 'Payout contract has no code.');
    const contract = new Contract(data.domain.verifyingContract, PAYOUT_ABI, provider);
    const [onchainSigner, token, used, domain] = await Promise.all([
      contract.payoutSigner(), contract.USDC(), contract.used(data.message.payoutId), contract.eip712Domain(),
    ]);
    requireValue(token === USDC && !used,
      'Onchain token mismatch or payout ID already used. No signature was requested.');
    const expectedSigner = typeof args['--signer'] === 'string' ? args['--signer'] : process.env.PAYOUT_SIGNER_ADDRESS;
    if (expectedSigner) requireValue(onchainSigner === address(expectedSigner, 'Expected payout signer'),
      'Onchain signer differs from the expected current payout signer. No signature was requested.');
    requireValue(domain[0] === '0x0f' && domain[1] === NAME && domain[2] === VERSION
      && domain[3] === BigInt(CHAIN_ID) && domain[4] === data.domain.verifyingContract
      && BigInt(domain[5]) === 0n && domain[6].length === 0, 'Onchain EIP-712 domain does not match.');
    requireValue(address(cast(['wallet', 'address', '--aws'], keyId), 'KMS signer') === onchainSigner,
      'KMS public address does not match the current payout signer.');
    const signature = cast(['wallet', 'sign', '--aws', '--data', JSON.stringify(data)], keyId);
    const result = { typedData: data, digest: digest(data), signature };
    // Recover offline before saving. This also checks the KMS signature format.
    relayPayload(result, onchainSigner);
    writeJson(option(args, '--output'), result);
    console.log(JSON.stringify({ digest: result.digest, payoutId: data.message.payoutId,
      signer: onchainSigner, note: 'Authorization saved. No payout transaction was broadcast.' }, null, 2));
  } finally { provider.destroy(); }
}

if (require.main === module) void safeMain(main);
