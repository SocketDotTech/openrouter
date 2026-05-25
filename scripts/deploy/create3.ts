import { Log, TransactionReceipt, keccak256, toUtf8Bytes } from 'ethers';

// CreateX factory — https://createx.rocks/
export const CREATE_X_FACTORY = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';

export const Create3ABI = [
  'function computeCreate2Address(bytes32,bytes32,address) view returns (address)',
  'function deployCreate2(bytes32,bytes) payable returns (address)',
  'function computeCreate3Address(bytes32,address) view returns (address)',
  'function deployCreate3(bytes32,bytes) payable returns (address)',
];

const Create3ContractCreationEvent = 'ContractCreation(address)';
const Create3ContractCreationEventTopicHash = keccak256(
  toUtf8Bytes(Create3ContractCreationEvent),
);

/**
 * Reads the deployed contract address from a CreateX CREATE3 deployment receipt.
 */
export function decodeCreate3DeploymentFromTxReceipt(params: {
  receipt: TransactionReceipt;
}): string | null {
  const { receipt } = params;
  const filteredLogs: Log[] = receipt.logs.filter((log: Log) =>
    log.topics.includes(Create3ContractCreationEventTopicHash),
  );

  if (filteredLogs.length === 0) {
    return null;
  }

  const eventData = filteredLogs[0].topics[1];
  if (!eventData) {
    return null;
  }

  return '0x' + eventData.slice(26);
}
