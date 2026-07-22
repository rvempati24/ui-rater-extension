import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ManagerConfig {
  dataDir: string;
  host: string;
  port: number;
  websiteUrl: string;
  collectionUrl: string;
  collectionAdminToken?: string;
  requestTimeoutMs: number;
  serviceInstanceId: string;
}

async function readOrCreateIdentity(file: string): Promise<string> {
  try {
    const value = (await fs.readFile(file, 'utf8')).trim();
    if (value) return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const value = `manager_${crypto.randomUUID()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${value}\n`, { flag: 'wx' }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return (await fs.readFile(file, 'utf8')).trim();
}

export async function loadConfig(): Promise<ManagerConfig> {
  const dataDir = path.resolve(process.env.MANAGER_DATA_DIR || path.join(process.cwd(), 'data', 'manager'));
  const port = Number(process.env.MANAGER_PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('MANAGER_PORT must be a valid port');
  return {
    dataDir,
    host: process.env.MANAGER_HOST || '127.0.0.1',
    port,
    websiteUrl: (process.env.WEBSITE_SERVICE_URL || 'http://127.0.0.1:4173').replace(/\/$/, ''),
    collectionUrl: (process.env.COLLECTION_SERVICE_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
    collectionAdminToken: process.env.UI_RATER_ADMIN_TOKEN || undefined,
    requestTimeoutMs: Number(process.env.MANAGER_REQUEST_TIMEOUT_MS || 10_000),
    serviceInstanceId: await readOrCreateIdentity(path.join(dataDir, 'service-instance-id')),
  };
}
