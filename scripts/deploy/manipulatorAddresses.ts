import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

export type ManipulatorContractName =
  | 'AcrossERC20AmountManipulator'
  | 'MathManipulator';

export async function writeManipulatorAddress(
  network: string,
  contractName: ManipulatorContractName,
  address: string,
  stage = 'prod',
): Promise<string> {
  const filePath = resolve(
    process.cwd(),
    'deployments',
    stage,
    'addresses',
    `${network}.json`,
  );
  let deployments: Record<string, string> = {};

  try {
    deployments = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      string
    >;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  deployments[contractName] = address;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(deployments, null, 2)}\n`,
    'utf8',
  );
  return filePath;
}
