import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

export type RFQVaultExecutorDeployments = {
  RFQVaultExecutor: string;
};

export function rfqVaultExecutorAddressesPath(
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

export async function readRFQVaultExecutorAddress(
  network: string,
  stage = 'prod',
): Promise<string | undefined> {
  const filePath = rfqVaultExecutorAddressesPath(network, stage);

  try {
    const raw = await readFile(filePath, 'utf8');
    const deployments = JSON.parse(raw) as Partial<RFQVaultExecutorDeployments>;
    const address = deployments.RFQVaultExecutor?.trim();

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
 * Persists RFQVaultExecutor address for a network.
 * Creates deployments/<stage>/addresses/ and <network>.json when missing.
 */
export async function writeRFQVaultExecutorAddress(
  network: string,
  address: string,
  stage = 'prod',
): Promise<string> {
  const filePath = rfqVaultExecutorAddressesPath(network, stage);
  let deployments: Partial<RFQVaultExecutorDeployments> = {};

  try {
    const raw = await readFile(filePath, 'utf8');
    deployments = JSON.parse(raw) as Partial<RFQVaultExecutorDeployments>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  deployments.RFQVaultExecutor = address;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(deployments, null, 2)}\n`,
    'utf8',
  );

  return filePath;
}
