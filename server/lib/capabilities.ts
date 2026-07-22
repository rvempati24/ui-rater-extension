import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { DATA_DIR } from './paths.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';

let cachedSecret: Buffer | null = null;

async function capabilitySecret(): Promise<Buffer> {
  if (cachedSecret) return cachedSecret;
  if (process.env.UI_RATER_CAPABILITY_SECRET) {
    cachedSecret = Buffer.from(process.env.UI_RATER_CAPABILITY_SECRET, 'utf8');
    if (cachedSecret.length < 32) throw new Error('UI_RATER_CAPABILITY_SECRET must be at least 32 bytes');
    return cachedSecret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('UI_RATER_CAPABILITY_SECRET is required in production');
  }
  const file = path.join(DATA_DIR, '.capability-secret');
  cachedSecret = await withFileLock('capability-secret', async () => {
    try {
      return Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'base64url');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const generated = crypto.randomBytes(32);
      await writeFileAtomic(file, generated.toString('base64url') + '\n', 'utf8');
      return generated;
    }
  });
  if (cachedSecret.length < 32) throw new Error('Local capability secret is invalid');
  return cachedSecret;
}

export async function capabilityFor(scope: 'run' | 'attempt', id: string): Promise<string> {
  const mac = crypto.createHmac('sha256', await capabilitySecret())
    .update(`ui-rater-capability-v1\0${scope}\0${id}`)
    .digest('base64url');
  return `urc1_${scope}_${mac}`;
}

export async function requireCapability(
  req: NextRequest, scope: 'run' | 'attempt', id: string
): Promise<void> {
  const supplied = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const expected = await capabilityFor(scope, id);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error(`${scope} capability authorization required`);
  }
}
