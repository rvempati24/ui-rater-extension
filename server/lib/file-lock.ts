import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { DATA_DIR } from './paths.ts';

const localLocks = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 15_000;
const STALE_AFTER_MS = 60_000;

function lockName(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function acquireDirectoryLock(key: string): Promise<() => Promise<void>> {
  const root = path.join(DATA_DIR, '.locks');
  const lock = path.join(root, `${lockName(key)}.lock`);
  await fs.mkdir(root, { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({
        key, pid: process.pid, hostname: os.hostname(), acquired_at: new Date().toISOString(),
      }), 'utf8');
      let released = false;
      const heartbeat = setInterval(() => {
        void fs.utimes(lock, new Date(), new Date()).catch(() => {});
      }, Math.floor(STALE_AFTER_MS / 3));
      heartbeat.unref();
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        await fs.rm(lock, { recursive: true, force: true });
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
        const owner: { pid?: number; hostname?: string } = await fs.readFile(path.join(lock, 'owner.json'), 'utf8')
          .then((value) => JSON.parse(value) as { pid?: number; hostname?: string })
          .catch((): { pid?: number; hostname?: string } => ({}));
        let ownerAlive = false;
        let removable = !owner.hostname || !Number.isInteger(owner.pid);
        if (owner.hostname === os.hostname() && Number.isInteger(owner.pid)) {
          try { process.kill(owner.pid!, 0); ownerAlive = true; }
          catch (probeError: unknown) {
            ownerAlive = (probeError as NodeJS.ErrnoException).code === 'EPERM';
          }
          removable = !ownerAlive;
        }
        if (removable) {
          await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out acquiring lock: ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
    }
  }
}

export function withFileLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = localLocks.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    const release = await acquireDirectoryLock(key);
    try { return await operation(); } finally { await release(); }
  });
  const settled = next.then(() => {}, () => {});
  localLocks.set(key, settled);
  return next.finally(() => {
    if (localLocks.get(key) === settled) localLocks.delete(key);
  });
}
