import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { AllowanceHolderVariant } from '../e2e/config';

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;

export const DEPLOYMENT_REGISTRY_COLUMNS = [
  'chainId',
  'variant',
  'allowanceHolderAddress',
  'allowanceHolderSalt',
  'allowanceHolderSaltText',
  'allowanceHolderInitcodeHash',
  'allowanceHolderRuntimeBytecodeHash',
  'openRouterAddress',
  'openRouterSalt',
  'openRouterSaltText',
  'openRouterInitcodeHash',
  'openRouterRuntimeBytecodeHash',
  'bungeeReceiverAddress',
  'bungeeReceiverSalt',
  'bungeeReceiverSaltText',
  'bungeeReceiverInitcodeHash',
  'bungeeReceiverRuntimeBytecodeHash',
  'calldataExecutorAddress',
  'calldataExecutorSalt',
  'calldataExecutorSaltText',
  'calldataExecutorInitcodeHash',
  'calldataExecutorRuntimeBytecodeHash',
] as const;

type DeploymentRegistryColumn = (typeof DEPLOYMENT_REGISTRY_COLUMNS)[number];

export interface DeploymentRegistryRow {
  chainId: number;
  variant: AllowanceHolderVariant;
  allowanceHolderAddress?: string;
  allowanceHolderSalt?: string;
  allowanceHolderSaltText?: string;
  allowanceHolderInitcodeHash?: string;
  allowanceHolderRuntimeBytecodeHash?: string;
  openRouterAddress?: string;
  openRouterSalt?: string;
  openRouterSaltText?: string;
  openRouterInitcodeHash?: string;
  openRouterRuntimeBytecodeHash?: string;
  bungeeReceiverAddress?: string;
  bungeeReceiverSalt?: string;
  bungeeReceiverSaltText?: string;
  bungeeReceiverInitcodeHash?: string;
  bungeeReceiverRuntimeBytecodeHash?: string;
  calldataExecutorAddress?: string;
  calldataExecutorSalt?: string;
  calldataExecutorSaltText?: string;
  calldataExecutorInitcodeHash?: string;
  calldataExecutorRuntimeBytecodeHash?: string;
}

export type DeploymentRegistryRowUpdate = Partial<
  Omit<DeploymentRegistryRow, 'chainId'>
> & {
  chainId: number;
};

export function deploymentRegistryPath(): string {
  return resolve(process.cwd(), 'deployments.csv');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function acquireRegistryLock(filePath: string): Promise<string> {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      return lockPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw err;
      }

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for deployment registry lock: ${lockPath}`);
      }

      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function withRegistryLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = await acquireRegistryLock(filePath);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (inQuotes) {
    throw new Error(`Invalid CSV row with unterminated quote: ${line}`);
  }

  values.push(current);
  return values;
}

function normalizeVariant(value: string): AllowanceHolderVariant {
  if (value === 'cancun' || value === 'shanghai') {
    return value;
  }

  throw new Error(`Invalid deployment registry variant: ${value}`);
}

function rowFromRecord(
  record: Partial<Record<DeploymentRegistryColumn, string>>,
): DeploymentRegistryRow {
  const chainIdText = record.chainId?.trim();
  if (!chainIdText) {
    throw new Error('Deployment registry row is missing chainId');
  }

  const chainId = Number(chainIdText);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid deployment registry chainId: ${chainIdText}`);
  }

  const variant = normalizeVariant(record.variant?.trim() ?? '');

  return {
    chainId,
    variant,
    allowanceHolderAddress: record.allowanceHolderAddress || undefined,
    allowanceHolderSalt: record.allowanceHolderSalt || undefined,
    allowanceHolderSaltText: record.allowanceHolderSaltText || undefined,
    allowanceHolderInitcodeHash:
      record.allowanceHolderInitcodeHash || undefined,
    allowanceHolderRuntimeBytecodeHash:
      record.allowanceHolderRuntimeBytecodeHash || undefined,
    openRouterAddress: record.openRouterAddress || undefined,
    openRouterSalt: record.openRouterSalt || undefined,
    openRouterSaltText: record.openRouterSaltText || undefined,
    openRouterInitcodeHash: record.openRouterInitcodeHash || undefined,
    openRouterRuntimeBytecodeHash:
      record.openRouterRuntimeBytecodeHash || undefined,
    bungeeReceiverAddress: record.bungeeReceiverAddress || undefined,
    bungeeReceiverSalt: record.bungeeReceiverSalt || undefined,
    bungeeReceiverSaltText: record.bungeeReceiverSaltText || undefined,
    bungeeReceiverInitcodeHash:
      record.bungeeReceiverInitcodeHash || undefined,
    bungeeReceiverRuntimeBytecodeHash:
      record.bungeeReceiverRuntimeBytecodeHash || undefined,
    calldataExecutorAddress: record.calldataExecutorAddress || undefined,
    calldataExecutorSalt: record.calldataExecutorSalt || undefined,
    calldataExecutorSaltText: record.calldataExecutorSaltText || undefined,
    calldataExecutorInitcodeHash:
      record.calldataExecutorInitcodeHash || undefined,
    calldataExecutorRuntimeBytecodeHash:
      record.calldataExecutorRuntimeBytecodeHash || undefined,
  };
}

function rowToRecord(
  row: DeploymentRegistryRow,
): Record<DeploymentRegistryColumn, string> {
  return {
    chainId: String(row.chainId),
    variant: row.variant,
    allowanceHolderAddress: row.allowanceHolderAddress ?? '',
    allowanceHolderSalt: row.allowanceHolderSalt ?? '',
    allowanceHolderSaltText: row.allowanceHolderSaltText ?? '',
    allowanceHolderInitcodeHash: row.allowanceHolderInitcodeHash ?? '',
    allowanceHolderRuntimeBytecodeHash:
      row.allowanceHolderRuntimeBytecodeHash ?? '',
    openRouterAddress: row.openRouterAddress ?? '',
    openRouterSalt: row.openRouterSalt ?? '',
    openRouterSaltText: row.openRouterSaltText ?? '',
    openRouterInitcodeHash: row.openRouterInitcodeHash ?? '',
    openRouterRuntimeBytecodeHash: row.openRouterRuntimeBytecodeHash ?? '',
    bungeeReceiverAddress: row.bungeeReceiverAddress ?? '',
    bungeeReceiverSalt: row.bungeeReceiverSalt ?? '',
    bungeeReceiverSaltText: row.bungeeReceiverSaltText ?? '',
    bungeeReceiverInitcodeHash: row.bungeeReceiverInitcodeHash ?? '',
    bungeeReceiverRuntimeBytecodeHash:
      row.bungeeReceiverRuntimeBytecodeHash ?? '',
    calldataExecutorAddress: row.calldataExecutorAddress ?? '',
    calldataExecutorSalt: row.calldataExecutorSalt ?? '',
    calldataExecutorSaltText: row.calldataExecutorSaltText ?? '',
    calldataExecutorInitcodeHash: row.calldataExecutorInitcodeHash ?? '',
    calldataExecutorRuntimeBytecodeHash:
      row.calldataExecutorRuntimeBytecodeHash ?? '',
  };
}

function parseDeploymentRegistryCsv(csv: string): DeploymentRegistryRow[] {
  const trimmed = csv.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  for (const column of DEPLOYMENT_REGISTRY_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`Deployment registry is missing column: ${column}`);
    }
  }

  const rows: DeploymentRegistryRow[] = [];
  const seenChainIds = new Set<number>();

  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }

    const values = parseCsvLine(line);
    const record: Partial<Record<DeploymentRegistryColumn, string>> = {};
    header.forEach((column, index) => {
      if ((DEPLOYMENT_REGISTRY_COLUMNS as readonly string[]).includes(column)) {
        record[column as DeploymentRegistryColumn] = values[index] ?? '';
      }
    });

    const row = rowFromRecord(record);
    if (seenChainIds.has(row.chainId)) {
      throw new Error(
        `Deployment registry has multiple rows for chainId=${row.chainId}`,
      );
    }
    seenChainIds.add(row.chainId);
    rows.push(row);
  }

  return rows;
}

export function formatDeploymentRegistryCsv(
  rows: DeploymentRegistryRow[],
): string {
  const sortedRows = [...rows].sort((a, b) => a.chainId - b.chainId);
  const lines = [
    DEPLOYMENT_REGISTRY_COLUMNS.join(','),
    ...sortedRows.map((row) => {
      const record = rowToRecord(row);
      return DEPLOYMENT_REGISTRY_COLUMNS.map((column) =>
        csvEscape(record[column]),
      ).join(',');
    }),
  ];

  return `${lines.join('\n')}\n`;
}

export async function readDeploymentRegistry(
  filePath = deploymentRegistryPath(),
): Promise<DeploymentRegistryRow[]> {
  try {
    const csv = await readFile(filePath, 'utf8');
    return parseDeploymentRegistryCsv(csv);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw err;
  }
}

export function readDeploymentRegistrySync(
  filePath = deploymentRegistryPath(),
): DeploymentRegistryRow[] {
  if (!existsSync(filePath)) {
    return [];
  }

  return parseDeploymentRegistryCsv(readFileSync(filePath, 'utf8'));
}

export function findDeploymentRegistryRow(
  chainId: number,
  filePath = deploymentRegistryPath(),
): DeploymentRegistryRow | undefined {
  return readDeploymentRegistrySync(filePath).find(
    (row) => row.chainId === chainId,
  );
}

function mergeRegistryRow(
  existing: DeploymentRegistryRow | undefined,
  update: DeploymentRegistryRowUpdate,
): DeploymentRegistryRow {
  if (!existing && !update.variant) {
    throw new Error(
      `Deployment registry update for chainId=${update.chainId} is missing variant`,
    );
  }

  if (
    existing?.variant &&
    update.variant &&
    existing.variant !== update.variant
  ) {
    throw new Error(
      `Deployment registry variant mismatch for chainId=${update.chainId}: existing=${existing.variant}, update=${update.variant}`,
    );
  }

  return {
    ...(existing ?? {
      chainId: update.chainId,
      variant: update.variant as AllowanceHolderVariant,
    }),
    ...Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ),
  } as DeploymentRegistryRow;
}

export async function writeDeploymentRegistry(
  rows: DeploymentRegistryRow[],
  filePath = deploymentRegistryPath(),
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, formatDeploymentRegistryCsv(rows));
  await rename(tmpPath, filePath);
  return filePath;
}

export async function upsertDeploymentRegistryRow(
  update: DeploymentRegistryRowUpdate,
  filePath = deploymentRegistryPath(),
): Promise<string> {
  return withRegistryLock(filePath, async () => {
    const rows = await readDeploymentRegistry(filePath);
    const index = rows.findIndex((row) => row.chainId === update.chainId);
    const merged = mergeRegistryRow(rows[index], update);

    if (index >= 0) {
      rows[index] = merged;
    } else {
      rows.push(merged);
    }

    return writeDeploymentRegistry(rows, filePath);
  });
}
