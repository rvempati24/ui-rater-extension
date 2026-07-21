import fs from 'fs/promises';
import path from 'path';
import type { InteractionEvent, SessionManifest, SnapshotMetadata } from '@/types';
import { SESSIONS_DIR } from './paths.ts';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID = /^s\d{4}$/;

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid sessionId');
}

export function getSessionDir(sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(SESSIONS_DIR, sessionId);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}

const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  const next = previous.then(fn);
  const settled = next.then(() => {}, () => {});
  sessionLocks.set(sessionId, settled);
  return next.finally(() => {
    if (sessionLocks.get(sessionId) === settled) sessionLocks.delete(sessionId);
  });
}

async function updateManifestUnlocked(
  sessionId: string,
  patch: Partial<SessionManifest>
): Promise<SessionManifest> {
  const dir = getSessionDir(sessionId);
  const file = path.join(dir, 'manifest.json');
  const current = await readJson<SessionManifest>(file, {
    schema_version: 1,
    session_id: sessionId,
    status: 'recording',
  });
  const safePatch: Partial<SessionManifest> = { ...patch };
  if (current.status === 'complete' && patch.status === 'recording') {
    safePatch.status = 'complete';
    delete safePatch.attempt_status;
    delete safePatch.task_status;
    delete safePatch.outcome;
    delete safePatch.outcome_reason;
    delete safePatch.outcome_at;
  }
  const next: SessionManifest = {
    ...current,
    ...safePatch,
    interaction_count: Math.max(current.interaction_count || 0, safePatch.interaction_count || 0),
    schema_version: 1,
    session_id: sessionId,
  };
  await writeJson(file, next);
  return next;
}

export async function updateManifest(
  sessionId: string,
  patch: Partial<SessionManifest>
): Promise<SessionManifest> {
  return withSessionLock(sessionId, () => updateManifestUnlocked(sessionId, patch));
}

export async function saveSessionTrace(
  sessionId: string,
  interactions: InteractionEvent[],
  metadata: Partial<SessionManifest> = {}
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const dir = getSessionDir(sessionId);
    const manifest = await readJson<SessionManifest>(path.join(dir, 'manifest.json'), {
      schema_version: 1, session_id: sessionId, status: 'recording',
    });
    if (manifest.status === 'complete' && metadata.status === 'recording') return;
    const traceFile = path.join(dir, 'trace.json');
    const current = await readJson<{ interactions: InteractionEvent[] }>(
      traceFile, { interactions: [] }
    );
    const nextInteractions = manifest.status === 'complete'
      ? current.interactions
      : interactions.length >= current.interactions.length
      ? interactions
      : current.interactions;
    await writeJson(traceFile, {
      schema_version: 1,
      session_id: sessionId,
      interactions: nextInteractions,
    });
    await updateManifestUnlocked(sessionId, {
      ...metadata,
      interaction_count: nextInteractions.length,
    });
  });
}

export async function saveSnapshot(
  sessionId: string,
  input: {
    snapshotId: string;
    imageDataUrl: string;
    reason?: string;
    actionId?: string;
    phase?: 'before' | 'after';
    eventKind?: string;
    ts?: number;
    url?: string;
    title?: string;
    viewport?: { width: number; height: number };
    scroll?: { x: number; y: number };
    elements?: Array<Record<string, unknown>>;
  }
): Promise<SnapshotMetadata> {
  if (!SNAPSHOT_ID.test(input.snapshotId)) throw new Error('Invalid snapshotId');
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(input.imageDataUrl);
  if (!match) throw new Error('Snapshot must be a JPEG data URL');
  const image = Buffer.from(match[1], 'base64');
  if (image.length > 5 * 1024 * 1024) throw new Error('Snapshot exceeds 5 MB');

  return withSessionLock(sessionId, async () => {
    const snapshotDir = path.join(getSessionDir(sessionId), 'snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    const imageFile = `${input.snapshotId}.jpg`;
    const metadata: SnapshotMetadata = {
      snapshot_id: input.snapshotId,
      reason: input.reason || 'state-change',
      action_id: typeof input.actionId === 'string' ? input.actionId.slice(0, 80) : undefined,
      phase: input.phase === 'before' || input.phase === 'after' ? input.phase : undefined,
      event_kind: typeof input.eventKind === 'string' ? input.eventKind.slice(0, 40) : undefined,
      ts: typeof input.ts === 'number' ? input.ts : 0,
      url: input.url,
      title: input.title,
      viewport: input.viewport,
      scroll: input.scroll,
      elements: Array.isArray(input.elements) ? input.elements.slice(0, 60) : [],
      image_file: `snapshots/${imageFile}`,
    };
    const imagePath = path.join(snapshotDir, imageFile);
    const metadataPath = path.join(snapshotDir, `${input.snapshotId}.json`);
    const [existingImage, existingMetadata] = await Promise.all([
      fs.readFile(imagePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }),
      readJson<SnapshotMetadata | null>(metadataPath, null),
    ]);
    if (existingImage) {
      if (!existingImage.equals(image)) {
        throw new Error(`Snapshot ${input.snapshotId} already exists with different content`);
      }
      if (existingMetadata) {
        if (existingMetadata.snapshot_id !== input.snapshotId) {
          throw new Error(`Snapshot ${input.snapshotId} metadata is inconsistent`);
        }
        return existingMetadata;
      }
      // Repair a crash after the immutable JPEG write but before metadata write.
      await writeJson(metadataPath, metadata);
      const repairedJsonFiles = (await fs.readdir(snapshotDir)).filter((name) => name.endsWith('.json'));
      await updateManifestUnlocked(sessionId, { snapshot_count: repairedJsonFiles.length });
      return metadata;
    }
    if (existingMetadata) {
      throw new Error(`Snapshot ${input.snapshotId} metadata exists without its image`);
    }
    const manifest = await readJson<SessionManifest>(path.join(getSessionDir(sessionId), 'manifest.json'), {
      schema_version: 1, session_id: sessionId, status: 'recording',
    });
    if (manifest.status === 'complete') throw new Error('Completed sessions do not accept new snapshots');
    await fs.writeFile(imagePath, image, { flag: 'wx' });
    await writeJson(metadataPath, metadata);

    const jsonFiles = (await fs.readdir(snapshotDir)).filter((name) => name.endsWith('.json'));
    await updateManifestUnlocked(sessionId, { snapshot_count: jsonFiles.length });
    return metadata;
  });
}

export async function loadSession(sessionId: string): Promise<{
  dir: string;
  manifest: SessionManifest;
  interactions: InteractionEvent[];
  snapshots: SnapshotMetadata[];
}> {
  const dir = getSessionDir(sessionId);
  const manifest = await readJson<SessionManifest>(path.join(dir, 'manifest.json'), {
    schema_version: 1, session_id: sessionId, status: 'recording',
  });
  const trace = await readJson<{ interactions: InteractionEvent[] }>(
    path.join(dir, 'trace.json'), { interactions: [] }
  );
  const snapshotDir = path.join(dir, 'snapshots');
  let names: string[] = [];
  try {
    names = (await fs.readdir(snapshotDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const snapshots = await Promise.all(names.map((name) =>
    readJson<SnapshotMetadata>(path.join(snapshotDir, name), {} as SnapshotMetadata)
  ));
  return { dir, manifest, interactions: trace.interactions || [], snapshots };
}
