import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { TrialConfigEntry, WebsiteMetadata } from '@/types';
import {
  PARTICIPANT_DATA_DIR, PARTICIPANT_INDEX_DIR, SESSIONS_DIR, SYNC_QUEUE_DIR,
} from './paths';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const locks = new Map<string, Promise<void>>();

export interface ParticipantRecord {
  schema_version: 2;
  participant_id: string;
  status: 'active' | 'disabled' | 'archived';
  active_run_id?: string;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  schema_version: 2;
  run_id: string;
  participant_id: string;
  status: 'active' | 'completed' | 'aborted' | 'archived';
  created_at: string;
  completed_at?: string;
  website?: WebsiteMetadata;
  task_count: number;
}

export interface TaskRecord {
  schema_version: 2;
  assignment_id: string;
  run_id: string;
  participant_id: string;
  position: number;
  source_position: number;
  task_prompt: string;
  site_url: string;
  group: string;
  slug: string;
  app_id: string;
  accepted_attempt_id?: string;
}

export interface AttemptRecord {
  schema_version: 2;
  attempt_id: string;
  assignment_id: string;
  run_id: string;
  participant_id: string;
  attempt_number: number;
  session_id: string;
  status: 'recording' | 'completed' | 'accepted' | 'invalidated' | 'failed';
  started_at: string;
  completed_at?: string;
  reason?: string;
}

export interface TaskWithAttemptState extends TaskRecord {
  attempt_count: number;
}

function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
}

function participantDir(participantId: string): string {
  assertId(participantId, 'participantId');
  return path.join(PARTICIPANT_DATA_DIR, participantId);
}

function runDir(participantId: string, runId: string): string {
  assertId(runId, 'runId');
  return path.join(participantDir(participantId), 'runs', runId);
}

function taskDir(participantId: string, runId: string, position: number, assignmentId: string): string {
  assertId(assignmentId, 'assignmentId');
  return path.join(runDir(participantId, runId), 'tasks', `${String(position).padStart(3, '0')}-${assignmentId}`);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function readJsonMaybe<T>(file: string): Promise<T | null> {
  try { return await readJson<T>(file); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(fn);
  const settled = next.then(() => {}, () => {});
  locks.set(key, settled);
  return next.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function taskEntries(participantId: string, runId: string): Promise<Array<{ dir: string; task: TaskRecord }>> {
  const root = path.join(runDir(participantId, runId), 'tasks');
  let names: string[] = [];
  try { names = (await fs.readdir(root)).sort(); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const output: Array<{ dir: string; task: TaskRecord }> = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const task = await readJsonMaybe<TaskRecord>(path.join(dir, 'task.json'));
    if (task) output.push({ dir, task });
  }
  return output;
}

export async function createRun(
  participantId: string,
  configs: TrialConfigEntry[],
  website?: WebsiteMetadata
): Promise<{ participant: ParticipantRecord; run: RunRecord; tasks: TaskWithAttemptState[] }> {
  assertId(participantId, 'participantId');
  return withLock(`participant:${participantId}`, async () => {
    const now = new Date().toISOString();
    const participantFile = path.join(participantDir(participantId), 'participant.json');
    const existing = await readJsonMaybe<ParticipantRecord>(participantFile);
    if (existing?.status === 'disabled') throw new Error('Participant is disabled');
    const runId = newId('run');
    const participant: ParticipantRecord = {
      schema_version: 2,
      participant_id: participantId,
      status: existing?.status || 'active',
      active_run_id: runId,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    const run: RunRecord = {
      schema_version: 2, run_id: runId, participant_id: participantId,
      status: 'active', created_at: now, website, task_count: configs.length,
    };
    await writeJsonAtomic(participantFile, participant);
    await writeJsonAtomic(path.join(runDir(participantId, runId), 'run.json'), run);
    const tasks: TaskWithAttemptState[] = [];
    for (let index = 0; index < configs.length; index += 1) {
      const config = configs[index];
      const assignmentId = newId('asg');
      const task: TaskRecord = {
        schema_version: 2, assignment_id: assignmentId, run_id: runId,
        participant_id: participantId, position: index + 1, source_position: index + 1,
        task_prompt: config.task_prompt, site_url: config.site_url || '',
        group: config.group, slug: config.slug,
        app_id: config.plain_app,
      };
      await writeJsonAtomic(path.join(taskDir(participantId, runId, task.position, assignmentId), 'task.json'), task);
      tasks.push({ ...task, attempt_count: 0 });
    }
    await rebuildIndexes();
    return { participant, run, tasks };
  });
}

export async function getActiveRun(participantId: string): Promise<{ run: RunRecord; tasks: TaskWithAttemptState[] } | null> {
  const participant = await readJsonMaybe<ParticipantRecord>(path.join(participantDir(participantId), 'participant.json'));
  if (participant?.status === 'disabled' || participant?.status === 'archived') {
    throw new Error(`Participant is ${participant.status}`);
  }
  if (!participant?.active_run_id) return null;
  return getRun(participantId, participant.active_run_id);
}

export async function getRun(participantId: string, runId: string): Promise<{ run: RunRecord; tasks: TaskWithAttemptState[] } | null> {
  const run = await readJsonMaybe<RunRecord>(path.join(runDir(participantId, runId), 'run.json'));
  if (!run) return null;
  const entries = await taskEntries(participantId, runId);
  const tasks = await Promise.all(entries.map(async ({ dir, task }) => {
    let count = 0;
    try { count = (await fs.readdir(path.join(dir, 'attempts'))).length; } catch { /* none */ }
    return { ...task, attempt_count: count };
  }));
  return { run, tasks };
}

async function findTask(participantId: string, runId: string, assignmentId: string) {
  const entry = (await taskEntries(participantId, runId)).find(({ task }) => task.assignment_id === assignmentId);
  if (!entry) throw new Error('Assignment not found');
  return entry;
}

export async function createAttempt(input: {
  participantId: string; runId: string; assignmentId: string; sessionId: string;
}): Promise<AttemptRecord> {
  return withLock(`run:${input.runId}`, async () => {
    const { dir, task } = await findTask(input.participantId, input.runId, input.assignmentId);
    if (task.accepted_attempt_id) throw new Error('Task already has an accepted attempt');
    const root = path.join(dir, 'attempts');
    let names: string[] = [];
    try { names = await fs.readdir(root); } catch { /* none */ }
    const attempt: AttemptRecord = {
      schema_version: 2, attempt_id: newId('att'), assignment_id: input.assignmentId,
      run_id: input.runId, participant_id: input.participantId,
      attempt_number: names.length + 1, session_id: input.sessionId,
      status: 'recording', started_at: new Date().toISOString(),
    };
    const dirName = `${String(attempt.attempt_number).padStart(3, '0')}-${attempt.attempt_id}`;
    await writeJsonAtomic(path.join(root, dirName, 'attempt.json'), attempt);
    return attempt;
  });
}

async function findAttempt(participantId: string, runId: string, assignmentId: string, attemptId: string) {
  const task = await findTask(participantId, runId, assignmentId);
  const root = path.join(task.dir, 'attempts');
  const names = await fs.readdir(root);
  const name = names.find((candidate) => candidate.endsWith(`-${attemptId}`));
  if (!name) throw new Error('Attempt not found');
  const dir = path.join(root, name);
  const attempt = await readJson<AttemptRecord>(path.join(dir, 'attempt.json'));
  return { ...task, attempt, attemptDir: dir };
}

async function copyTree(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, { recursive: true, force: true });
}

async function completeRunIfReady(participantId: string, runId: string): Promise<boolean> {
  const tasks = await taskEntries(participantId, runId);
  const refreshed = await Promise.all(tasks.map(({ dir }) => readJson<TaskRecord>(path.join(dir, 'task.json'))));
  const ready = refreshed.length > 0 && refreshed.every((task) => Boolean(task.accepted_attempt_id));
  if (!ready) return false;
  const runFile = path.join(runDir(participantId, runId), 'run.json');
  const run = await readJson<RunRecord>(runFile);
  await writeJsonAtomic(runFile, {
    ...run, status: 'completed', completed_at: run.completed_at || new Date().toISOString(),
  });
  await writeJsonAtomic(path.join(SYNC_QUEUE_DIR, `${runId}.json`), {
    schema_version: 2, run_id: runId, participant_id: participantId,
    queued_at: new Date().toISOString(),
  });
  return true;
}

export async function completeAttempt(input: {
  participantId: string; runId: string; assignmentId: string; attemptId: string; sessionId: string;
}): Promise<{ attempt: AttemptRecord; runCompleted: boolean }> {
  return withLock(`run:${input.runId}`, async () => {
    const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
    if (found.attempt.session_id !== input.sessionId) throw new Error('Attempt/session mismatch');
    await copyTree(path.join(SESSIONS_DIR, input.sessionId), found.attemptDir);
    const attempt: AttemptRecord = {
      ...found.attempt, status: 'accepted', completed_at: new Date().toISOString(), reason: undefined,
    };
    await writeJsonAtomic(path.join(found.attemptDir, 'attempt.json'), attempt);
    await writeJsonAtomic(path.join(found.dir, 'task.json'), { ...found.task, accepted_attempt_id: attempt.attempt_id });
    const runCompleted = await completeRunIfReady(input.participantId, input.runId);
    await rebuildIndexes();
    return { attempt, runCompleted };
  });
}

export async function invalidateAttempt(input: {
  participantId: string; runId: string; assignmentId: string; attemptId: string; reason: string;
}): Promise<AttemptRecord> {
  return withLock(`run:${input.runId}`, async () => {
    const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
    try {
      await copyTree(path.join(SESSIONS_DIR, found.attempt.session_id), found.attemptDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (found.task.accepted_attempt_id === input.attemptId) {
      await writeJsonAtomic(path.join(found.dir, 'task.json'), { ...found.task, accepted_attempt_id: undefined });
      const runFile = path.join(runDir(input.participantId, input.runId), 'run.json');
      const run = await readJson<RunRecord>(runFile);
      await writeJsonAtomic(runFile, { ...run, status: 'active', completed_at: undefined });
    }
    const attempt: AttemptRecord = {
      ...found.attempt, status: 'invalidated', reason: input.reason || 'operator_retry',
      completed_at: found.attempt.completed_at || new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(found.attemptDir, 'attempt.json'), attempt);
    const eventId = `${Date.now()}-${newId('evt')}`;
    await writeJsonAtomic(path.join(runDir(input.participantId, input.runId), 'events', `${eventId}.json`), {
      schema_version: 2, event_id: eventId, type: 'attempt_invalidated',
      attempt_id: input.attemptId, reason: attempt.reason, created_at: new Date().toISOString(),
    });
    await rebuildIndexes();
    return attempt;
  });
}

export async function saveAttemptRecording(input: {
  participantId: string; runId: string; assignmentId: string; attemptId: string; data: Buffer;
}): Promise<string> {
  const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
  const file = path.join(found.attemptDir, 'recording.webm');
  await fs.writeFile(file, input.data);
  return file;
}

export async function listParticipants(): Promise<ParticipantRecord[]> {
  let names: string[] = [];
  try { names = await fs.readdir(PARTICIPANT_DATA_DIR); } catch { return []; }
  const records = await Promise.all(names.sort().map((name) =>
    readJsonMaybe<ParticipantRecord>(path.join(PARTICIPANT_DATA_DIR, name, 'participant.json'))
  ));
  return records.filter((record): record is ParticipantRecord => Boolean(record));
}

export async function listRuns(participantId: string): Promise<RunRecord[]> {
  const root = path.join(participantDir(participantId), 'runs');
  let names: string[] = [];
  try { names = await fs.readdir(root); } catch { return []; }
  const records = await Promise.all(names.sort().map((name) =>
    readJsonMaybe<RunRecord>(path.join(root, name, 'run.json'))
  ));
  return records.filter((record): record is RunRecord => Boolean(record));
}

export async function updateParticipantStatus(
  participantId: string, status: ParticipantRecord['status']
): Promise<ParticipantRecord> {
  return withLock(`participant:${participantId}`, async () => {
    const file = path.join(participantDir(participantId), 'participant.json');
    const current = await readJson<ParticipantRecord>(file);
    const next = { ...current, status, updated_at: new Date().toISOString() };
    await writeJsonAtomic(file, next);
    await rebuildIndexes();
    return next;
  });
}

export async function updateRunStatus(
  participantId: string, runId: string, status: 'aborted' | 'archived' | 'active'
): Promise<RunRecord> {
  return withLock(`run:${runId}`, async () => {
    const file = path.join(runDir(participantId, runId), 'run.json');
    const current = await readJson<RunRecord>(file);
    if (current.status === 'completed' && status === 'active') throw new Error('Completed runs cannot be reactivated');
    const next = { ...current, status };
    await writeJsonAtomic(file, next);
    await rebuildIndexes();
    return next;
  });
}

export async function decideAttempt(input: {
  participantId: string; runId: string; assignmentId: string; attemptId: string;
  action: 'accept' | 'restore'; reason?: string;
}): Promise<AttemptRecord> {
  return withLock(`run:${input.runId}`, async () => {
    const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
    let status: AttemptRecord['status'];
    if (input.action === 'restore') {
      if (found.attempt.status !== 'invalidated') throw new Error('Only invalidated attempts can be restored');
      status = 'completed';
    } else {
      if (!['completed', 'invalidated'].includes(found.attempt.status)) throw new Error('Attempt is not eligible for acceptance');
      if (found.task.accepted_attempt_id && found.task.accepted_attempt_id !== input.attemptId) {
        throw new Error('Task already has another accepted attempt');
      }
      status = 'accepted';
      await writeJsonAtomic(path.join(found.dir, 'task.json'), { ...found.task, accepted_attempt_id: input.attemptId });
    }
    const attempt = { ...found.attempt, status, reason: input.reason };
    await writeJsonAtomic(path.join(found.attemptDir, 'attempt.json'), attempt);
    const eventId = `${Date.now()}-${newId('evt')}`;
    await writeJsonAtomic(path.join(runDir(input.participantId, input.runId), 'events', `${eventId}.json`), {
      schema_version: 2, event_id: eventId, type: `attempt_${input.action}ed`,
      attempt_id: input.attemptId, reason: input.reason, created_at: new Date().toISOString(),
    });
    if (status === 'accepted') await completeRunIfReady(input.participantId, input.runId);
    await rebuildIndexes();
    return attempt;
  });
}

async function rebuildIndexesUnlocked(): Promise<void> {
  await fs.mkdir(PARTICIPANT_INDEX_DIR, { recursive: true });
  const participants: ParticipantRecord[] = [];
  const runs: RunRecord[] = [];
  const attempts: Array<AttemptRecord & { artifact_path: string }> = [];
  let participantNames: string[] = [];
  try { participantNames = await fs.readdir(PARTICIPANT_DATA_DIR); } catch { /* none */ }
  for (const participantId of participantNames.sort()) {
    const participant = await readJsonMaybe<ParticipantRecord>(path.join(participantDir(participantId), 'participant.json'));
    if (!participant) continue;
    participants.push(participant);
    const runsRoot = path.join(participantDir(participantId), 'runs');
    let runNames: string[] = [];
    try { runNames = await fs.readdir(runsRoot); } catch { /* none */ }
    for (const runId of runNames.sort()) {
      const loaded = await getRun(participantId, runId);
      if (!loaded) continue;
      runs.push(loaded.run);
      for (const { dir } of await taskEntries(participantId, runId)) {
        const attemptRoot = path.join(dir, 'attempts');
        let attemptNames: string[] = [];
        try { attemptNames = await fs.readdir(attemptRoot); } catch { /* none */ }
        for (const name of attemptNames.sort()) {
          const attempt = await readJsonMaybe<AttemptRecord>(path.join(attemptRoot, name, 'attempt.json'));
          if (attempt) attempts.push({ ...attempt, artifact_path: path.relative(PARTICIPANT_DATA_DIR, path.join(attemptRoot, name)).replaceAll('\\', '/') });
        }
      }
    }
  }
  const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  await writeJsonAtomic(path.join(PARTICIPANT_INDEX_DIR, 'index-metadata.json'), {
    schema_version: 2, generated_at: new Date().toISOString(),
    participants: participants.length, runs: runs.length, attempts: attempts.length,
  });
  await fs.writeFile(path.join(PARTICIPANT_INDEX_DIR, 'participants.jsonl'), jsonl(participants), 'utf8');
  await fs.writeFile(path.join(PARTICIPANT_INDEX_DIR, 'runs.jsonl'), jsonl(runs), 'utf8');
  await fs.writeFile(path.join(PARTICIPANT_INDEX_DIR, 'attempts.jsonl'), jsonl(attempts), 'utf8');
}

export function rebuildIndexes(): Promise<void> {
  return withLock('indexes', rebuildIndexesUnlocked);
}
