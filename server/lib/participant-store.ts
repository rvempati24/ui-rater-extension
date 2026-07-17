import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { TrialConfigEntry, WebsiteMetadata } from '@/types';
import { PARTICIPANT_DATA_DIR, SESSIONS_DIR } from './paths.ts';
import {
  applyOutcomeTransition, isTerminalTask, nextAttemptNumber,
} from './participant-state.ts';
import type { AttemptOutcome, AttemptStatus, TaskStatus } from './participant-state.ts';
import { assertSessionId } from './sessions.ts';

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
  outcome?: 'all_tasks_terminal';
  reason?: 'tasks_terminal';
  outcome_at?: string;
  website?: WebsiteMetadata;
  task_count: number;
  outcome_summary?: { completed: number; skipped: number; failed_no_retry: number };
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
  status: TaskStatus;
  accepted_attempt_id?: string;
  outcome?: AttemptOutcome;
  reason?: string;
  outcome_at?: string;
}

export interface AttemptRecord {
  schema_version: 2;
  attempt_id: string;
  assignment_id: string;
  run_id: string;
  participant_id: string;
  attempt_number: number;
  session_id: string;
  status: AttemptStatus;
  started_at: string;
  evidence_completed_at?: string;
  status_updated_at?: string;
  outcome?: AttemptOutcome;
  outcome_at?: string;
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
    if (task) output.push({
      dir,
      task: {
        ...task,
        status: task.status || (task.accepted_attempt_id ? 'completed' : 'pending'),
      },
    });
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
      const sourcePosition = config.source_position;
      const assignmentId = newId('asg');
      const task: TaskRecord = {
        schema_version: 2, assignment_id: assignmentId, run_id: runId,
        participant_id: participantId, position: index + 1,
        source_position: typeof sourcePosition === 'number'
          && Number.isInteger(sourcePosition) && sourcePosition > 0
          ? sourcePosition : index + 1,
        task_prompt: config.task_prompt, site_url: config.site_url || '',
        group: config.group, slug: config.slug,
        app_id: config.plain_app,
        status: 'pending',
      };
      await writeJsonAtomic(path.join(taskDir(participantId, runId, task.position, assignmentId), 'task.json'), task);
      tasks.push({ ...task, attempt_count: 0 });
    }
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
  assertId(input.assignmentId, 'assignmentId');
  assertSessionId(input.sessionId);
  return withLock(`run:${input.runId}`, async () => {
    const run = await readJson<RunRecord>(path.join(runDir(input.participantId, input.runId), 'run.json'));
    if (run.status !== 'active') throw new Error(`Run is ${run.status}; a new attempt is not allowed`);
    const { dir, task } = await findTask(input.participantId, input.runId, input.assignmentId);
    if (task.status !== 'pending') throw new Error(`Task is ${task.status}; a new attempt is not allowed`);
    if (task.accepted_attempt_id) throw new Error('Task already has an accepted attempt');
    const root = path.join(dir, 'attempts');
    let names: string[] = [];
    try { names = await fs.readdir(root); } catch { /* none */ }
    const existing = await Promise.all(names.map((name) =>
      readJsonMaybe<AttemptRecord>(path.join(root, name, 'attempt.json'))
    ));
    const sameSession = existing.find((attempt) => attempt?.session_id === input.sessionId);
    if (sameSession) return sameSession;
    const active = existing.find((attempt) =>
      attempt?.status === 'recording' || attempt?.status === 'completed_pending_outcome'
      || (attempt?.status as string) === 'completed'
    );
    if (active) throw new Error(`Attempt ${active.attempt_id} still requires completion or outcome`);
    const nextNumber = nextAttemptNumber(existing);
    const attempt: AttemptRecord = {
      schema_version: 2, attempt_id: newId('att'), assignment_id: input.assignmentId,
      run_id: input.runId, participant_id: input.participantId,
      attempt_number: nextNumber, session_id: input.sessionId,
      status: 'recording', started_at: new Date().toISOString(),
      status_updated_at: new Date().toISOString(),
    };
    const dirName = `${String(attempt.attempt_number).padStart(3, '0')}-${attempt.attempt_id}`;
    await writeJsonAtomic(path.join(root, dirName, 'attempt.json'), attempt);
    return attempt;
  });
}

async function findAttempt(participantId: string, runId: string, assignmentId: string, attemptId: string) {
  assertId(attemptId, 'attemptId');
  const task = await findTask(participantId, runId, assignmentId);
  const root = path.join(task.dir, 'attempts');
  const names = await fs.readdir(root);
  const name = names.find((candidate) => candidate.endsWith(`-${attemptId}`));
  if (!name) throw new Error('Attempt not found');
  const dir = path.join(root, name);
  const storedAttempt = await readJson<AttemptRecord>(path.join(dir, 'attempt.json'));
  const attempt: AttemptRecord = (storedAttempt.status as string) === 'completed'
    ? { ...storedAttempt, status: 'completed_pending_outcome' }
    : storedAttempt;
  return { ...task, attempt, attemptDir: dir };
}

export async function getAttempt(
  participantId: string, runId: string, assignmentId: string, attemptId: string
): Promise<{ attempt: AttemptRecord; task: TaskRecord }> {
  const found = await findAttempt(participantId, runId, assignmentId, attemptId);
  return { attempt: found.attempt, task: found.task };
}

async function copyTree(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, { recursive: true, force: true });
}

async function updateAttemptArtifactManifest(
  attemptDir: string,
  patch: Record<string, unknown>
): Promise<void> {
  const file = path.join(attemptDir, 'manifest.json');
  const current = await readJsonMaybe<Record<string, unknown>>(file);
  if (!current) return;
  await writeJsonAtomic(file, { ...current, ...patch });
}

async function ensureOutcomeEvent(
  participantId: string,
  runId: string,
  assignmentId: string,
  attempt: AttemptRecord
): Promise<void> {
  if (!attempt.outcome) return;
  const eventId = `${attempt.attempt_id}-${attempt.outcome}`;
  const file = path.join(runDir(participantId, runId), 'events', `${eventId}.json`);
  if (await readJsonMaybe<Record<string, unknown>>(file)) return;
  await writeJsonAtomic(file, {
    schema_version: 2,
    event_id: eventId,
    type: 'attempt_outcome_recorded',
    attempt_id: attempt.attempt_id,
    assignment_id: assignmentId,
    outcome: attempt.outcome,
    reason: attempt.reason,
    created_at: attempt.outcome_at,
  });
}

async function completeRunIfReady(participantId: string, runId: string): Promise<boolean> {
  const tasks = await taskEntries(participantId, runId);
  const refreshed = tasks.map(({ task }) => task);
  const ready = refreshed.length > 0 && refreshed.every((task) => isTerminalTask(task.status));
  if (!ready) return false;
  for (const task of refreshed) {
    if (task.status === 'completed' && !task.accepted_attempt_id) {
      throw new Error(`Completed task ${task.assignment_id} has no accepted attempt`);
    }
    if (task.status !== 'completed' && task.accepted_attempt_id) {
      throw new Error(`Non-completed task ${task.assignment_id} has an accepted attempt`);
    }
    const entry = tasks.find(({ task: candidate }) => candidate.assignment_id === task.assignment_id);
    if (!entry) throw new Error(`Task ${task.assignment_id} directory is missing`);
    const attemptRoot = path.join(entry.dir, 'attempts');
    let attemptNames: string[] = [];
    try { attemptNames = await fs.readdir(attemptRoot); } catch { /* validation below handles absence */ }
    const attempts = await Promise.all(attemptNames.map((name) =>
      readJsonMaybe<AttemptRecord>(path.join(attemptRoot, name, 'attempt.json'))
    ));
    const accepted = attempts.filter((attempt) => attempt?.status === 'accepted');
    if (accepted.length > 1) throw new Error(`Task ${task.assignment_id} has multiple accepted attempts`);
    if (task.status !== 'completed' && accepted.length > 0) {
      throw new Error(`Non-completed task ${task.assignment_id} contains an accepted attempt`);
    }
    if (task.status === 'completed' && (
      accepted.length !== 1 || accepted[0]?.attempt_id !== task.accepted_attempt_id
    )) {
      throw new Error(`Task ${task.assignment_id} accepted_attempt_id is invalid`);
    }
  }
  const runFile = path.join(runDir(participantId, runId), 'run.json');
  const run = await readJson<RunRecord>(runFile);
  if (run.status === 'completed') return true;
  if (run.status !== 'active') throw new Error(`Run is ${run.status}; it cannot be completed`);
  const completedAt = run.completed_at || new Date().toISOString();
  await writeJsonAtomic(runFile, {
    ...run,
    status: 'completed',
    completed_at: completedAt,
    outcome: 'all_tasks_terminal',
    reason: 'tasks_terminal',
    outcome_at: run.outcome_at || completedAt,
    outcome_summary: {
      completed: refreshed.filter((task) => task.status === 'completed').length,
      skipped: refreshed.filter((task) => task.status === 'skipped').length,
      failed_no_retry: refreshed.filter((task) => task.status === 'failed_no_retry').length,
    },
  });
  return true;
}

export async function completeAttemptEvidence(input: {
  participantId: string; runId: string; assignmentId: string; attemptId: string; sessionId: string;
}): Promise<{ attempt: AttemptRecord }> {
  return withLock(`run:${input.runId}`, async () => {
    const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
    if (found.attempt.session_id !== input.sessionId) throw new Error('Attempt/session mismatch');
    if (found.attempt.status !== 'recording') {
      if (found.attempt.status === 'completed_pending_outcome' || found.attempt.outcome) {
        // Repeated completion repairs the attempt artifact manifest if a
        // previous request stopped after updating attempt.json.
        await updateAttemptArtifactManifest(found.attemptDir, {
          attempt_status: found.attempt.status,
          task_status: found.task.status,
          outcome: found.attempt.outcome,
          outcome_reason: found.attempt.reason,
          outcome_at: found.attempt.outcome_at,
        });
        return { attempt: found.attempt };
      }
      throw new Error(`Evidence completion is invalid from attempt status ${found.attempt.status}`);
    }
    await copyTree(path.join(SESSIONS_DIR, input.sessionId), found.attemptDir);
    const now = new Date().toISOString();
    const attempt: AttemptRecord = {
      ...found.attempt,
      status: 'completed_pending_outcome',
      evidence_completed_at: now,
      status_updated_at: now,
    };
    await writeJsonAtomic(path.join(found.attemptDir, 'attempt.json'), attempt);
    await updateAttemptArtifactManifest(found.attemptDir, {
      attempt_status: attempt.status,
      task_status: found.task.status,
    });
    return { attempt };
  });
}

export async function applyAttemptOutcome(input: {
  participantId: string;
  runId: string;
  assignmentId: string;
  attemptId: string;
  outcome: AttemptOutcome;
  reason?: string;
}): Promise<{ attempt: AttemptRecord; task: TaskRecord; runCompleted: boolean; idempotent: boolean }> {
  return withLock(`run:${input.runId}`, async () => {
    const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
    const run = await readJson<RunRecord>(path.join(runDir(input.participantId, input.runId), 'run.json'));
    if (!found.attempt.outcome && run.status !== 'active') {
      throw new Error(`Run is ${run.status}; an outcome is not allowed`);
    }
    if (input.outcome === 'succeeded') {
      const attemptRoot = path.join(found.dir, 'attempts');
      const names = await fs.readdir(attemptRoot);
      const attempts = await Promise.all(names.map((name) =>
        readJsonMaybe<AttemptRecord>(path.join(attemptRoot, name, 'attempt.json'))
      ));
      const conflicting = attempts.find((attempt) =>
        attempt?.status === 'accepted' && attempt.attempt_id !== input.attemptId
      );
      if (conflicting) throw new Error('Task already has another accepted attempt');
    }
    const transition = applyOutcomeTransition(
      found.attempt, found.task, input.outcome, input.reason, new Date().toISOString()
    );
    if (transition.idempotent) {
      const taskChanged = JSON.stringify(transition.task) !== JSON.stringify(found.task);
      if (taskChanged) await writeJsonAtomic(path.join(found.dir, 'task.json'), transition.task);
      await updateAttemptArtifactManifest(found.attemptDir, {
        attempt_status: transition.attempt.status,
        task_status: transition.task.status,
        outcome: transition.attempt.outcome,
        outcome_reason: transition.attempt.reason,
        outcome_at: transition.attempt.outcome_at,
      });
      await ensureOutcomeEvent(input.participantId, input.runId, input.assignmentId, transition.attempt);
      const runCompleted = await completeRunIfReady(input.participantId, input.runId);
      return {
        attempt: transition.attempt,
        task: transition.task,
        runCompleted,
        idempotent: true,
      };
    }
    await writeJsonAtomic(path.join(found.attemptDir, 'attempt.json'), transition.attempt);
    await writeJsonAtomic(path.join(found.dir, 'task.json'), transition.task);
    await updateAttemptArtifactManifest(found.attemptDir, {
      attempt_status: transition.attempt.status,
      task_status: transition.task.status,
      outcome: transition.attempt.outcome,
      outcome_reason: transition.attempt.reason,
      outcome_at: transition.attempt.outcome_at,
    });
    await ensureOutcomeEvent(input.participantId, input.runId, input.assignmentId, transition.attempt);
    const runCompleted = await completeRunIfReady(input.participantId, input.runId);
    return {
      attempt: transition.attempt,
      task: transition.task,
      runCompleted,
      idempotent: false,
    };
  });
}

export async function saveAttemptRecording(input: {
  participantId: string; runId: string; assignmentId: string; attemptId: string; data: Buffer;
}): Promise<string> {
  return withLock(`run:${input.runId}`, async () => {
    const found = await findAttempt(input.participantId, input.runId, input.assignmentId, input.attemptId);
    const file = path.join(found.attemptDir, 'recording.webm');
    try {
      const existing = await fs.readFile(file);
      if (existing.equals(input.data)) return file;
      throw new Error('Recording already exists with different content');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.writeFile(file, input.data, { flag: 'wx' });
    return file;
  });
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
    return next;
  });
}
