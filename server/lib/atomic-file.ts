import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeFileAtomic(
  file: string, data: string | Uint8Array, encoding?: BufferEncoding
): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    if (typeof data === 'string') await handle.writeFile(data, encoding || 'utf8');
    else await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  await fs.rename(temp, file);
  await syncDirectory(directory);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2), 'utf8');
}
