import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

export type EtherealExecutorDeployments = {
  EtherealExecutor: string;
};

export function etherealExecutorAddressesPath(
  network: string,
  stage = 'prod',
): string {
  return resolve(
    process.cwd(),
    'deployments',
    stage,
    'addresses',
    `${network}.json`,
  );
}

export async function readEtherealExecutorAddress(
  network: string,
  stage = 'prod',
): Promise<string | undefined> {
  const filePath = etherealExecutorAddressesPath(network, stage);

  try {
    const raw = await readFile(filePath, 'utf8');
    const deployments = JSON.parse(raw) as Partial<EtherealExecutorDeployments>;
    const address = deployments.EtherealExecutor?.trim();

    if (!address) {
      return undefined;
    }

    return address;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw err;
  }
}

/**
 * Persists EtherealExecutor address for a network.
 */
export async function writeEtherealExecutorAddress(
  network: string,
  address: string,
  stage = 'prod',
): Promise<string> {
  const filePath = etherealExecutorAddressesPath(network, stage);
  let deployments: Partial<EtherealExecutorDeployments> = {};

  try {
    const raw = await readFile(filePath, 'utf8');
    deployments = JSON.parse(raw) as Partial<EtherealExecutorDeployments>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  deployments.EtherealExecutor = address;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(deployments, null, 2)}\n`,
    'utf8',
  );

  return filePath;
}
