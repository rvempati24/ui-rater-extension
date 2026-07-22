import fs from 'fs/promises';
import path from 'path';
import type { InteractionEvent, RecordingTiming, SessionManifest, SnapshotMetadata } from '@/types';
import { SESSIONS_DIR } from './paths.ts';
import { writeFileAtomic, writeJsonAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID = /^s\d{4}$/;
const MAX_SNAPSHOTS = 240;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SESSION_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_TRACE_EVENTS = 100_000;
const MAX_BATCH_EVENTS = 2_000;

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid sessionId');
}

function finiteInteger(value: unknown, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} must be a finite integer`);
  return value as number;
}

export function normalizeRecordingTiming(value: unknown, requireStop = false): RecordingTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recordingTiming must be an object');
  }
  const input = value as Record<string, unknown>;
  const videoStart = finiteInteger(input.videoStartEpochMs ?? input.video_start_epoch_ms, 'videoStartEpochMs');
  const traceOrigin = finiteInteger(input.traceOriginEpochMs ?? input.trace_origin_epoch_ms, 'traceOriginEpochMs');
  const offset = finiteInteger(input.traceToVideoOffsetMs ?? input.trace_to_video_offset_ms, 'traceToVideoOffsetMs');
  const stopValue = input.videoStopEpochMs ?? input.video_stop_epoch_ms;
  const videoStop = stopValue === undefined ? undefined : finiteInteger(stopValue, 'videoStopEpochMs');
  if (videoStart <= 0 || traceOrigin <= 0 || traceOrigin < videoStart) throw new Error('Invalid recording clock order');
  if (offset !== traceOrigin - videoStart || offset < 0 || offset > 60_000) {
    throw new Error('recording timing offset is inconsistent');
  }
  if (requireStop && videoStop === undefined) throw new Error('recording stop time is required');
  if (videoStop !== undefined && videoStop <= videoStart) throw new Error('recording stop must follow start');
  const startSource = input.startSource ?? input.start_source;
  if (startSource !== 'mediarecorder-start-event') throw new Error('Unsupported recording start source');
  const profileInput = input.captureProfile ?? input.capture_profile;
  const profile = profileInput && typeof profileInput === 'object' && !Array.isArray(profileInput)
    ? profileInput as Record<string, unknown> : undefined;
  const optionalNumber = (candidate: unknown) => Number.isFinite(candidate) && Number(candidate) > 0
    ? Number(candidate) : undefined;
  return {
    schema_version: 1,
    clock: 'unix-epoch-ms',
    video_start_epoch_ms: videoStart,
    trace_origin_epoch_ms: traceOrigin,
    trace_to_video_offset_ms: offset,
    start_source: 'mediarecorder-start-event',
    video_stop_epoch_ms: videoStop,
    capture_profile: profile ? {
      profile_id: typeof (profile.profileId ?? profile.profile_id) === 'string'
        ? String(profile.profileId ?? profile.profile_id).slice(0, 80) : undefined,
      codec: typeof profile.codec === 'string' ? profile.codec.slice(0, 40) : undefined,
      requested_frame_rate: optionalNumber(profile.requestedFrameRate ?? profile.requested_frame_rate),
      width: optionalNumber(profile.width), height: optionalNumber(profile.height),
      frame_rate: optionalNumber(profile.frameRate ?? profile.frame_rate),
    } : undefined,
  };
}

function mergeRecordingTiming(current: RecordingTiming | undefined, next: RecordingTiming | undefined): RecordingTiming | undefined {
  if (!next) return current;
  if (!current) return next;
  const withoutStop = (timing: RecordingTiming) => ({ ...timing, video_stop_epoch_ms: undefined });
  if (JSON.stringify(withoutStop(current)) !== JSON.stringify(withoutStop(next))) {
    throw new Error('Conflicting recording timing metadata');
  }
  if (current.video_stop_epoch_ms !== undefined && next.video_stop_epoch_ms !== undefined
      && current.video_stop_epoch_ms !== next.video_stop_epoch_ms) {
    throw new Error('Conflicting recording stop time');
  }
  return { ...current, video_stop_epoch_ms: current.video_stop_epoch_ms ?? next.video_stop_epoch_ms };
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

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  assertSessionId(sessionId);
  return withFileLock(`session:${sessionId}`, fn);
}

async function updateManifestUnlocked(
  sessionId: string,
  patch: Partial<SessionManifest>
): Promise<SessionManifest> {
  const dir = getSessionDir(sessionId);
  const file = path.join(dir, 'manifest.json');
  const current = await readJson<SessionManifest | null>(file, null);
  if (!current) throw new Error('Unknown session');
  const safePatch: Partial<SessionManifest> = { ...patch };
  safePatch.recording_timing = mergeRecordingTiming(current.recording_timing, patch.recording_timing);
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
    schema_version: current.schema_version === 2 ? 2 : 1,
    session_id: sessionId,
  };
  await writeJsonAtomic(file, next);
  return next;
}

async function reconcileSnapshotManifestUnlocked(
  sessionId: string, manifest: SessionManifest, snapshotDir: string
): Promise<SessionManifest> {
  const names = (await fs.readdir(snapshotDir)).filter((name) => name.endsWith('.json')).sort();
  let snapshotBytes = 0;
  for (const name of names) {
    const snapshotId = name.slice(0, -5);
    const image = path.join(snapshotDir, `${snapshotId}.jpg`);
    const stat = await fs.stat(image).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile()) throw new Error(`Snapshot ${snapshotId} metadata has no JPEG`);
    snapshotBytes += stat.size;
  }
  if (snapshotBytes > MAX_SESSION_SNAPSHOT_BYTES) {
    throw new Error('Session exceeds the screenshot storage quota');
  }
  if (manifest.snapshot_count === names.length && manifest.snapshot_bytes === snapshotBytes) {
    return manifest;
  }
  return updateManifestUnlocked(sessionId, {
    snapshot_count: names.length,
    snapshot_bytes: snapshotBytes,
  });
}

export async function updateManifest(
  sessionId: string,
  patch: Partial<SessionManifest>
): Promise<SessionManifest> {
  return withSessionLock(sessionId, () => updateManifestUnlocked(sessionId, patch));
}

export async function initializeSession(
  sessionId: string,
  manifest: Omit<SessionManifest, 'schema_version' | 'session_id' | 'status'>
): Promise<SessionManifest> {
  return withSessionLock(sessionId, async () => {
    const file = path.join(getSessionDir(sessionId), 'manifest.json');
    const current = await readJson<SessionManifest | null>(file, null);
    if (current) {
      for (const key of ['participant_id', 'run_id', 'assignment_id'] as const) {
        if (manifest[key] && current[key] && current[key] !== manifest[key]) {
          throw new Error('Session ownership mismatch');
        }
      }
      const mergedTiming = mergeRecordingTiming(current.recording_timing, manifest.recording_timing);
      const enriched = { ...manifest, ...current };
      enriched.recording_timing = mergedTiming;
      await writeJsonAtomic(file, enriched);
      return enriched;
    }
    const created: SessionManifest = {
      ...manifest,
      schema_version: 2,
      session_id: sessionId,
      status: 'recording',
      interaction_count: 0,
      snapshot_count: 0,
      snapshot_bytes: 0,
      processed_batch_ids: [],
    };
    await writeJsonAtomic(file, created);
    await writeJsonAtomic(path.join(getSessionDir(sessionId), 'trace.json'), {
      schema_version: 2, session_id: sessionId, interactions: [],
    });
    return created;
  });
}

export async function appendSessionTraceBatch(
  sessionId: string,
  batchId: string,
  events: InteractionEvent[],
  metadata: Partial<SessionManifest> = {}
): Promise<{ interactionCount: number; appended: number; replayed: boolean }> {
  if (typeof batchId !== 'string' || batchId.length < 8 || batchId.length > 240) {
    throw new Error('Invalid trace batchId');
  }
  if (!Array.isArray(events) || events.length > MAX_BATCH_EVENTS) {
    throw new Error(`A trace batch may contain at most ${MAX_BATCH_EVENTS} events`);
  }
  return withSessionLock(sessionId, async () => {
    const dir = getSessionDir(sessionId);
    const manifest = await readJson<SessionManifest | null>(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new Error('Unknown session');
    if (manifest.status === 'complete') {
      return { interactionCount: manifest.interaction_count || 0, appended: 0, replayed: true };
    }
    const processed = new Set(manifest.processed_batch_ids || []);
    if (processed.has(batchId)) {
      return { interactionCount: manifest.interaction_count || 0, appended: 0, replayed: true };
    }
    const traceFile = path.join(dir, 'trace.json');
    const current = await readJson<{ interactions: InteractionEvent[] }>(traceFile, { interactions: [] });
    const known = new Set(current.interactions.map((event) => event.event_id).filter(Boolean));
    let nextSeq = current.interactions.reduce((value, event) => Math.max(value, event.seq || 0), 0) + 1;
    const appended: InteractionEvent[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const input = events[index];
      if (!input || typeof input !== 'object' || typeof input.kind !== 'string'
        || typeof input.ts !== 'number' || !Number.isFinite(input.ts)) {
        throw new Error(`Invalid trace event at batch position ${index}`);
      }
      const eventId = typeof input.event_id === 'string' && input.event_id.length <= 200
        ? input.event_id : `${batchId}:${index}`;
      if (known.has(eventId)) continue;
      known.add(eventId);
      appended.push({ ...input, event_id: eventId, seq: nextSeq++ });
    }
    const interactions = [...current.interactions, ...appended];
    if (interactions.length > MAX_TRACE_EVENTS) throw new Error('Session trace exceeds the event quota');
    await writeJsonAtomic(traceFile, {
      schema_version: 2, session_id: sessionId, interactions,
    });
    processed.add(batchId);
    await updateManifestUnlocked(sessionId, {
      ...metadata,
      interaction_count: interactions.length,
      processed_batch_ids: [...processed].slice(-2_000),
    });
    return { interactionCount: interactions.length, appended: appended.length, replayed: false };
  });
}

export async function saveSessionTrace(
  sessionId: string,
  interactions: InteractionEvent[],
  metadata: Partial<SessionManifest> = {}
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const dir = getSessionDir(sessionId);
    const manifest = await readJson<SessionManifest | null>(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new Error('Unknown session');
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
    await writeJsonAtomic(traceFile, {
      schema_version: 2,
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
    snapshotId?: string;
    captureRequestId?: string;
    imageDataUrl: string;
    reason?: string;
    actionId?: string;
    phase?: 'before' | 'after';
    eventKind?: string;
    ts?: number;
    requestedTs?: number;
    captureStartedTs?: number;
    captureLatencyMs?: number;
    timingGuarantee?: 'best-effort-before' | 'observed-state';
    url?: string;
    title?: string;
    viewport?: { width: number; height: number };
    scroll?: { x: number; y: number };
    elements?: Array<Record<string, unknown>>;
  }
): Promise<SnapshotMetadata> {
  if (input.snapshotId && !SNAPSHOT_ID.test(input.snapshotId)) throw new Error('Invalid snapshotId');
  if (input.captureRequestId && (input.captureRequestId.length < 8 || input.captureRequestId.length > 240)) {
    throw new Error('Invalid captureRequestId');
  }
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(input.imageDataUrl);
  if (!match) throw new Error('Snapshot must be a JPEG data URL');
  const image = Buffer.from(match[1], 'base64');
  if (image.length > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds 5 MB');

  return withSessionLock(sessionId, async () => {
    const sessionDir = getSessionDir(sessionId);
    const manifestFile = path.join(sessionDir, 'manifest.json');
    let manifest = await readJson<SessionManifest | null>(manifestFile, null);
    if (!manifest) throw new Error('Unknown session');
    const snapshotDir = path.join(sessionDir, 'snapshots');
    await fs.mkdir(snapshotDir, { recursive: true });
    manifest = await reconcileSnapshotManifestUnlocked(sessionId, manifest, snapshotDir);
    const metadataNames = (await fs.readdir(snapshotDir)).filter((name) => name.endsWith('.json')).sort();
    for (const name of metadataNames) {
      const existing = await readJson<SnapshotMetadata | null>(path.join(snapshotDir, name), null);
      if (input.captureRequestId && existing?.capture_request_id === input.captureRequestId) {
        await reconcileSnapshotManifestUnlocked(sessionId, manifest, snapshotDir);
        return existing;
      }
    }
    if (metadataNames.length >= MAX_SNAPSHOTS) throw new Error(`Session exceeds ${MAX_SNAPSHOTS} snapshots`);
    if ((manifest.snapshot_bytes || 0) + image.length > MAX_SESSION_SNAPSHOT_BYTES) {
      throw new Error('Session exceeds the screenshot storage quota');
    }
    const nextNumber = metadataNames.reduce((value, name) => {
      const match = /^s(\d{4})\.json$/.exec(name);
      return Math.max(value, match ? Number(match[1]) : 0);
    }, 0) + 1;
    const snapshotId = input.snapshotId || `s${String(nextNumber).padStart(4, '0')}`;
    const imageFile = `${snapshotId}.jpg`;
    const metadata: SnapshotMetadata = {
      snapshot_id: snapshotId,
      capture_request_id: input.captureRequestId,
      reason: input.reason || 'state-change',
      action_id: typeof input.actionId === 'string' ? input.actionId.slice(0, 80) : undefined,
      phase: input.phase === 'before' || input.phase === 'after' ? input.phase : undefined,
      event_kind: typeof input.eventKind === 'string' ? input.eventKind.slice(0, 40) : undefined,
      ts: typeof input.ts === 'number' ? input.ts : 0,
      requested_ts: typeof input.requestedTs === 'number' ? input.requestedTs : undefined,
      capture_started_ts: typeof input.captureStartedTs === 'number'
        ? input.captureStartedTs : undefined,
      capture_latency_ms: typeof input.captureLatencyMs === 'number'
        ? input.captureLatencyMs : undefined,
      timing_guarantee: input.timingGuarantee === 'best-effort-before'
        || input.timingGuarantee === 'observed-state'
        ? input.timingGuarantee : undefined,
      url: input.url,
      title: input.title,
      viewport: input.viewport,
      scroll: input.scroll,
      elements: Array.isArray(input.elements) ? input.elements.slice(0, 60) : [],
      image_file: `snapshots/${imageFile}`,
    };
    const imagePath = path.join(snapshotDir, imageFile);
    const metadataPath = path.join(snapshotDir, `${snapshotId}.json`);
    const [existingImage, existingMetadata] = await Promise.all([
      fs.readFile(imagePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }),
      readJson<SnapshotMetadata | null>(metadataPath, null),
    ]);
    if (existingImage) {
      if (!existingImage.equals(image)) {
        throw new Error(`Snapshot ${snapshotId} already exists with different content`);
      }
      if (existingMetadata) {
        if (existingMetadata.snapshot_id !== snapshotId) {
          throw new Error(`Snapshot ${snapshotId} metadata is inconsistent`);
        }
        await reconcileSnapshotManifestUnlocked(sessionId, manifest, snapshotDir);
        return existingMetadata;
      }
      // Repair a crash after the immutable JPEG write but before metadata write.
      await writeJsonAtomic(metadataPath, metadata);
      await reconcileSnapshotManifestUnlocked(sessionId, manifest, snapshotDir);
      return metadata;
    }
    if (existingMetadata) {
      throw new Error(`Snapshot ${snapshotId} metadata exists without its image`);
    }
    if (manifest.status === 'complete') throw new Error('Completed sessions do not accept new snapshots');
    await writeFileAtomic(imagePath, image);
    await writeJsonAtomic(metadataPath, metadata);

    await reconcileSnapshotManifestUnlocked(sessionId, manifest, snapshotDir);
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
  const manifest = await readJson<SessionManifest | null>(path.join(dir, 'manifest.json'), null);
  if (!manifest) throw new Error('Unknown session');
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
