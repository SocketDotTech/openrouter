import { confirm } from '../utils';
import { assertAddressMatchesExpected } from './create3';

/**
 * Prints deployment details, verifies CREATE3 address matches the canonical
 * target, and prompts for confirmation before broadcasting.
 */
export async function confirmCreate3Deployment(params: {
  contractLabel: string;
  networkName: string;
  chainId: number;
  deployerAddress: string;
  expectedAddress: string;
  create3Address: string;
  extraLines?: string[];
}): Promise<void> {
  assertAddressMatchesExpected({
    label: params.contractLabel,
    actual: params.create3Address,
    expected: params.expectedAddress,
  });

  console.log('\n=== Deployment confirmation ===');
  console.log(`Contract:         ${params.contractLabel}`);
  console.log(
    `Network:          ${params.networkName} (chainId=${params.chainId})`,
  );
  console.log(`Deployer:         ${params.deployerAddress}`);
  console.log(`Expected address: ${params.expectedAddress}`);
  console.log(`CREATE3 address:  ${params.create3Address}`);
  for (const line of params.extraLines ?? []) {
    console.log(line);
  }
  console.log('');

  await confirm('Proceed with CREATE3 deployment? (y/n) ');
}
