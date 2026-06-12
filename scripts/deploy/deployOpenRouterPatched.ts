/**
 * Patches the Solidity ALLOWANCE_HOLDER constant for one network, sets the
 * matching Hardhat EVM version, then runs the normal OpenRouter deployment.
 *
 * Usage:
 *   npx ts-node scripts/deploy/deployOpenRouterPatched.ts polygon
 *   npx ts-node scripts/deploy/deployOpenRouterPatched.ts --network polygon
 */

import { spawnSync } from 'child_process';
import {
  parseNetworkArg,
  prepareOpenRouterBuild,
} from './openRouterBuild';

async function main() {
  const network = parseNetworkArg(process.argv.slice(2));
  const { config, registryPath } = await prepareOpenRouterBuild(network);

  console.log('Prepared OpenRouter build');
  console.log('Network:          ', config.network);
  console.log('Chain ID:         ', config.chainId);
  console.log('AllowanceHolder:  ', config.allowanceHolder);
  console.log('AH source:        ', config.allowanceHolderConfigSource);
  console.log('AH variant:       ', config.allowanceHolderVariant);
  console.log('Hardhat EVM:      ', config.evmVersion);
  console.log('Deployment CSV:   ', registryPath);
  console.log('');

  const result = spawnSync(
    'npx',
    [
      'hardhat',
      'run',
      'scripts/deploy/deployOpenRouter.ts',
      '--network',
      network,
    ],
    {
      env: {
        ...process.env,
        OPENROUTER_EVM_VERSION: config.evmVersion,
      },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
