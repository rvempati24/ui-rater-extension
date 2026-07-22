import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';
import { writeJsonAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';

/** A stable identity lets Manager detect a different data root mounted at the same URL. */
export async function getCollectionServiceIdentity(): Promise<string> {
  return withFileLock('collection-service-identity', async () => {
    const file = path.join(DATA_DIR, 'service-identity.json');
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as { service_instance_id?: string };
      if (typeof value.service_instance_id === 'string' && value.service_instance_id) return value.service_instance_id;
    } catch {
      // The identity is created below. A missing/corrupt file is safe to repair before readiness.
    }
    const serviceInstanceId = `collection_${crypto.randomUUID()}`;
    await writeJsonAtomic(file, { schema_version: 1, service_instance_id: serviceInstanceId });
    return serviceInstanceId;
  });
}
