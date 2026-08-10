import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

export type HypercoreExecutorDeployments = {
  HypercoreDepositExecutor: string;
};

export function hypercoreExecutorAddressesPath(
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

export async function readHypercoreExecutorAddress(
  network: string,
  stage = 'prod',
): Promise<string | undefined> {
  const filePath = hypercoreExecutorAddressesPath(network, stage);

  try {
    const raw = await readFile(filePath, 'utf8');
    const deployments = JSON.parse(raw) as Partial<HypercoreExecutorDeployments>;
    const address = deployments.HypercoreDepositExecutor?.trim();

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

export async function writeHypercoreExecutorAddress(
  network: string,
  address: string,
  stage = 'prod',
): Promise<string> {
  const filePath = hypercoreExecutorAddressesPath(network, stage);
  let deployments: Record<string, string> = {};

  try {
    const raw = await readFile(filePath, 'utf8');
    deployments = JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  deployments.HypercoreDepositExecutor = address;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(deployments, null, 2)}\n`,
    'utf8',
  );

  return filePath;
}
