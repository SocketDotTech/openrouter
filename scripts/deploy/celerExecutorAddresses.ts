import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

export type CelerExecutorDeployments = {
  CelerExecutor: string;
};

export function celerExecutorAddressesPath(
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

export async function readCelerExecutorAddress(
  network: string,
  stage = 'prod',
): Promise<string | undefined> {
  const filePath = celerExecutorAddressesPath(network, stage);

  try {
    const raw = await readFile(filePath, 'utf8');
    const deployments = JSON.parse(raw) as Partial<CelerExecutorDeployments>;
    const address = deployments.CelerExecutor?.trim();

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
 * Persists CelerExecutor address for a network.
 * Creates deployments/<stage>/addresses/ and <network>.json when missing.
 */
export async function writeCelerExecutorAddress(
  network: string,
  address: string,
  stage = 'prod',
): Promise<string> {
  const filePath = celerExecutorAddressesPath(network, stage);
  let deployments: Partial<CelerExecutorDeployments> = {};

  try {
    const raw = await readFile(filePath, 'utf8');
    deployments = JSON.parse(raw) as Partial<CelerExecutorDeployments>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  deployments.CelerExecutor = address;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(deployments, null, 2)}\n`,
    'utf8',
  );

  return filePath;
}
