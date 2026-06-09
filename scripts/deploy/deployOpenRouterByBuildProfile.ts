/**
 * Deploys OpenRouter by build profile.
 *
 * A build profile is `(OPENROUTER_EVM_VERSION, ALLOWANCE_HOLDER address)`.
 * Networks in the same profile can share one patched source tree and one
 * compile, then deploy in parallel with `--no-compile`.
 *
 * Usage:
 *   npx ts-node scripts/deploy/deployOpenRouterByBuildProfile.ts --variant cancun
 *   npx ts-node scripts/deploy/deployOpenRouterByBuildProfile.ts polygon base
 */

import { spawn, spawnSync } from 'child_process';
import {
  assertOpenRouterForkCompatibility,
  openRouterBuildProfileKey,
  parseNetworkArgs,
  patchOpenRouterAllowanceHolderConstant,
  resolveOpenRouterBuildConfig,
  writeOpenRouterBuildManifest,
} from './openRouterBuild';
import type { OpenRouterBuildConfig } from './openRouterBuild';

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
  }
}

function runParallelDeploy(
  configs: OpenRouterBuildConfig[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = configs.length;
    const failures: string[] = [];

    for (const config of configs) {
      const child = spawn(
        'npx',
        [
          'hardhat',
          'run',
          '--no-compile',
          'scripts/deploy/deployOpenRouter.ts',
          '--network',
          config.network,
        ],
        {
          env,
          stdio: 'inherit',
        },
      );

      child.on('error', (err) => {
        failures.push(`${config.network}: ${err.message}`);
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          failures.push(`${config.network}: exited ${code}`);
        }

        remaining -= 1;
        if (remaining === 0) {
          if (failures.length > 0) {
            reject(new Error(`OpenRouter deploy failures: ${failures.join('; ')}`));
          } else {
            resolve();
          }
        }
      });
    }
  });
}

async function main() {
  const parsed = parseNetworkArgs(process.argv.slice(2));
  let configs = parsed.networks.map(resolveOpenRouterBuildConfig);

  if (parsed.variant) {
    configs = configs.filter(
      (config) => config.allowanceHolderVariant === parsed.variant,
    );
  }

  if (configs.length === 0) {
    throw new Error('No OpenRouter networks selected for deployment');
  }

  for (const config of configs) {
    await assertOpenRouterForkCompatibility(config);
  }

  const profiles = new Map<string, OpenRouterBuildConfig[]>();
  for (const config of configs) {
    const key = openRouterBuildProfileKey(config);
    const group = profiles.get(key);
    if (group) {
      group.push(config);
    } else {
      profiles.set(key, [config]);
    }
  }

  for (const [profile, group] of profiles.entries()) {
    const first = group[0];
    console.log('');
    console.log('=== OpenRouter Build Profile ===');
    console.log('Profile:         ', profile);
    console.log('EVM version:     ', first.evmVersion);
    console.log('AllowanceHolder: ', first.allowanceHolder);
    console.log('AH source:       ', first.allowanceHolderConfigSource);
    console.log(
      'Networks:        ',
      group.map((config) => config.network).join(', '),
    );

    await patchOpenRouterAllowanceHolderConstant(first.allowanceHolder);

    for (const config of group) {
      const manifestPath = await writeOpenRouterBuildManifest(config);
      console.log(`Manifest ${config.network}: ${manifestPath}`);
    }

    const env = {
      ...process.env,
      OPENROUTER_EVM_VERSION: first.evmVersion,
    };

    run('npx', ['hardhat', 'compile'], env);
    await runParallelDeploy(group, env);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
