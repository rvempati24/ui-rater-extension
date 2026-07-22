import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  ContractError,
  assertIdempotencyKey,
  requestDigest,
  validateStudyRevision,
  type StudyRevisionDescriptor,
} from '@ui-rater/contracts';
import type { RecordingTiming, TrialConfigEntry, WebsiteMetadata } from '@/types';
import { PARTICIPANT_DATA_DIR, SESSIONS_DIR } from './paths.ts';
import { writeFileAtomic, writeJsonAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';
import {
  applyOutcomeTransition, isTerminalTask, nextAttemptNumber,
} from './participant-state.ts';
import type { AttemptOutcome, AttemptStatus, TaskStatus } from './participant-state.ts';
import { assertSessionId, initializeSession } from './sessions.ts';
import {
  assertStudyAdmissionAccepting,
  getStudyRevisionRegistration,
  withStudyRegistrationLock,
} from './study-revisions.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
  creation_key?: string;
  creation_request_digest?: string;
  study_revision_id?: string;
  study_revision_digest?: string;
  study_revision?: StudyRevisionDescriptor;
  website_snapshot?: StudyRevisionDescriptor['website'];
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
  target_url?: string;
  website_task_id?: string;
  is_mind2web?: boolean;
  task_source?: string;
  legacy_app_id?: string;
  suggested_flows?: string[];
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

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(key, fn);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function taskEntries(participantId: string, runId: string): Promise<Array<{ dir: string; task: TaskRecord }>> {
  const root = path.join(runDir(participantId, runId), 'tasks');
  let names: string[] = [];
  try { names = (await fs.readdir(root)).filter((name) => !name.startsWith('.')).sort(); }
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
  website?: WebsiteMetadata,
  creationKey?: string
): Promise<{ participant: ParticipantRecord; run: RunRecord; tasks: TaskWithAttemptState[] }> {
  assertId(participantId, 'participantId');
  return withLock(`participant:${participantId}`, async () => {
    const now = new Date().toISOString();
    const participantFile = path.join(participantDir(participantId), 'participant.json');
    const existing = await readJsonMaybe<ParticipantRecord>(participantFile);
    if (existing?.status === 'disabled' || existing?.status === 'archived') {
      throw new Error(`Participant is ${existing.status}`);
    }
    if (creationKey) {
      assertIdempotencyKey(creationKey, 'creationKey');
      const prior = (await listRuns(participantId)).find((candidate) => candidate.creation_key === creationKey);
      if (prior) {
        const recovered = await getRun(participantId, prior.run_id);
        if (!recovered) throw new Error('Idempotent run exists but is incomplete');
        const repairedParticipant: ParticipantRecord = existing ? {
          ...existing,
          active_run_id: recovered.run.status === 'active'
            ? recovered.run.run_id : existing.active_run_id,
          updated_at: now,
        } : {
          schema_version: 2,
          participant_id: participantId,
          status: 'active',
          active_run_id: recovered.run.status === 'active' ? recovered.run.run_id : undefined,
          created_at: recovered.run.created_at || now,
          updated_at: now,
        };
        await writeJsonAtomic(participantFile, repairedParticipant);
        return { participant: repairedParticipant, run: recovered.run, tasks: recovered.tasks };
      }
    }
    if (!configs.length) throw new Error('A run must contain at least one task');
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
      creation_key: creationKey,
    };
    const runsRoot = path.join(participantDir(participantId), 'runs');
    const finalRunDir = path.join(runsRoot, runId);
    const stagedRunDir = path.join(runsRoot, `.${runId}.staging-${crypto.randomUUID()}`);
    const tasks: TaskWithAttemptState[] = [];
    try {
      await writeJsonAtomic(path.join(stagedRunDir, 'run.json'), run);
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
        const stagedTask = path.join(
          stagedRunDir, 'tasks', `${String(task.position).padStart(3, '0')}-${assignmentId}`, 'task.json'
        );
        await writeJsonAtomic(stagedTask, task);
        tasks.push({ ...task, attempt_count: 0 });
      }
      await fs.mkdir(runsRoot, { recursive: true });
      await fs.rename(stagedRunDir, finalRunDir);
      // The participant pointer is the commit record and is intentionally written last.
      await writeJsonAtomic(participantFile, participant);
    } catch (error) {
      await fs.rm(stagedRunDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { participant, run, tasks };
  });
}

/**
 * Canonical v1 run creation path. The Study Revision is the complete input;
 * no process-global trials configuration or Website Service lookup is used.
 * Lock order is always study registration -> participant -> run/session.
 */
export async function createRunFromStudyRevision(
  participantId: string,
  rawRevision: StudyRevisionDescriptor,
  creationKey: string,
): Promise<{
  participant: ParticipantRecord;
  run: RunRecord;
  tasks: TaskWithAttemptState[];
  created: boolean;
}> {
  assertId(participantId, 'participantId');
  assertIdempotencyKey(creationKey, 'creationKey');
  const revision = validateStudyRevision(rawRevision);
  const revisionDigest = requestDigest(revision);
  const creationRequestDigest = requestDigest({
    participantId,
    studyRevisionId: revision.studyRevisionId,
    revisionDigest,
  });
  return withStudyRegistrationLock(revision.studyRevisionId, async () => {
    const registered = await getStudyRevisionRegistration(revision.studyRevisionId);
    if (!registered) throw new ContractError('study_revision_not_found', 'Study revision was not registered');
    if (requestDigest(registered.revision) !== revisionDigest) {
      throw new ContractError('study_revision_conflict', 'Study revision content does not match Collection registration');
    }
    return withLock(`participant:${participantId}`, async () => {
      const now = new Date().toISOString();
      const participantFile = path.join(participantDir(participantId), 'participant.json');
      const existing = await readJsonMaybe<ParticipantRecord>(participantFile);
      if (existing?.status === 'disabled' || existing?.status === 'archived') {
        throw new ContractError('participant_unavailable', `Participant is ${existing.status}`);
      }

      const priorRuns = await listRuns(participantId);
      const priorByKey = priorRuns.find((candidate) => candidate.creation_key === creationKey);
      if (priorByKey) {
        if (priorByKey.creation_request_digest && priorByKey.creation_request_digest !== creationRequestDigest) {
          throw new ContractError('idempotency_key_reused', 'Run Idempotency-Key was reused with different content');
        }
        if (priorByKey.study_revision_id !== revision.studyRevisionId) {
          throw new ContractError('idempotency_key_reused', 'Run Idempotency-Key belongs to another Study Revision');
        }
        const recovered = await getRun(participantId, priorByKey.run_id);
        if (!recovered) throw new ContractError('run_corrupt', 'Idempotent Participant Run is incomplete');
        const repairedParticipant: ParticipantRecord = existing ? {
          ...existing,
          active_run_id: recovered.run.status === 'active' ? recovered.run.run_id : existing.active_run_id,
          updated_at: now,
        } : {
          schema_version: 2,
          participant_id: participantId,
          status: 'active',
          active_run_id: recovered.run.status === 'active' ? recovered.run.run_id : undefined,
          created_at: recovered.run.created_at || now,
          updated_at: now,
        };
        await writeJsonAtomic(participantFile, repairedParticipant);
        return { participant: repairedParticipant, run: recovered.run, tasks: recovered.tasks, created: false };
      }

      // Admission applies to new work. An exact idempotent replay must remain
      // recoverable after close/retire because the run already committed.
      assertStudyAdmissionAccepting(registered);
      // Run records are authoritative. This also covers a crash after the run
      // directory commit but before participant.active_run_id was persisted.
      const active = priorRuns.find((candidate) => candidate.status === 'active');
      if (active) {
        if (existing?.active_run_id !== active.run_id) {
          const repairedParticipant: ParticipantRecord = existing ? {
            ...existing, active_run_id: active.run_id, updated_at: now,
          } : {
            schema_version: 2, participant_id: participantId, status: 'active',
            active_run_id: active.run_id, created_at: active.created_at, updated_at: now,
          };
          await writeJsonAtomic(participantFile, repairedParticipant);
        }
        throw new ContractError('participant_run_active', 'Participant already has an active run', false, {
          participantId,
          activeRunId: active.run_id,
          studyRevisionId: active.study_revision_id,
        });
      }
      if (!revision.tasks.length) throw new ContractError('invalid_study_revision', 'A run must contain at least one task');

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
        schema_version: 2,
        run_id: runId,
        participant_id: participantId,
        status: 'active',
        created_at: now,
        study_revision_id: revision.studyRevisionId,
        study_revision_digest: revisionDigest,
        study_revision: revision,
        website_snapshot: revision.website,
        task_count: revision.tasks.length,
        creation_key: creationKey,
        creation_request_digest: creationRequestDigest,
      };
      const runsRoot = path.join(participantDir(participantId), 'runs');
      const finalRunDir = path.join(runsRoot, runId);
      const stagedRunDir = path.join(runsRoot, `.${runId}.staging-${crypto.randomUUID()}`);
      const tasks: TaskWithAttemptState[] = [];
      try {
        await writeJsonAtomic(path.join(stagedRunDir, 'run.json'), run);
        for (let index = 0; index < revision.tasks.length; index += 1) {
          const source = revision.tasks[index];
          const assignmentId = newId('asg');
          const task: TaskRecord = {
            schema_version: 2,
            assignment_id: assignmentId,
            run_id: runId,
            participant_id: participantId,
            position: source.position,
            source_position: source.sourcePosition,
            website_task_id: source.websiteTaskId,
            task_prompt: source.prompt,
            target_url: source.targetUrl,
            site_url: source.targetUrl,
            group: source.group,
            slug: source.slug,
            app_id: source.legacyAppId || source.slug,
            legacy_app_id: source.legacyAppId,
            is_mind2web: source.isMind2Web,
            task_source: source.taskSource,
            suggested_flows: source.suggestedFlows,
            status: 'pending',
          };
          const stagedTask = path.join(
            stagedRunDir,
            'tasks',
            `${String(task.position).padStart(3, '0')}-${assignmentId}`,
            'task.json',
          );
          await writeJsonAtomic(stagedTask, task);
          tasks.push({ ...task, attempt_count: 0 });
        }
        await fs.mkdir(runsRoot, { recursive: true });
        await fs.rename(stagedRunDir, finalRunDir);
        await writeJsonAtomic(participantFile, participant);
      } catch (error) {
        await fs.rm(stagedRunDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return { participant, run, tasks, created: true };
    });
  });
}

export async function getActiveRun(participantId: string): Promise<{ run: RunRecord; tasks: TaskWithAttemptState[] } | null> {
  const participant = await readJsonMaybe<ParticipantRecord>(path.join(participantDir(participantId), 'participant.json'));
  if (participant?.status === 'disabled' || participant?.status === 'archived') {
    throw new Error(`Participant is ${participant.status}`);
  }
  if (!participant?.active_run_id) return null;
  const current = await getRun(participantId, participant.active_run_id);
  return current?.run.status === 'active' ? current : null;
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
  recordingTiming: RecordingTiming;
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
  try { names = (await fs.readdir(root)).filter((name) => !name.startsWith('.')); } catch { /* none */ }
    const existing = await Promise.all(names.map((name) =>
      readJsonMaybe<AttemptRecord>(path.join(root, name, 'attempt.json'))
    ));
    const sameSession = existing.find((attempt) => attempt?.session_id === input.sessionId);
    if (sameSession) {
      if (sameSession.status === 'recording') {
        await initializeSession(input.sessionId, {
          participant_id: input.participantId,
          run_id: input.runId,
          assignment_id: input.assignmentId,
          recording_timing: input.recordingTiming,
        });
        return sameSession;
      }
      throw new Error(`Session already belongs to terminal attempt ${sameSession.attempt_id}`);
    }
    const active = existing.find((attempt) =>
      attempt?.status === 'recording' || attempt?.status === 'completed_pending_outcome'
      || (attempt?.status as string) === 'completed'
    );
    if (active) throw new Error(`Attempt ${active.attempt_id} still requires completion or outcome`);
    const nextNumber = nextAttemptNumber(existing);
    let attempt: AttemptRecord = {
      schema_version: 2, attempt_id: newId('att'), assignment_id: input.assignmentId,
      run_id: input.runId, participant_id: input.participantId,
      attempt_number: nextNumber, session_id: input.sessionId,
      status: 'recording', started_at: new Date().toISOString(),
      status_updated_at: new Date().toISOString(),
    };
    const session = await initializeSession(input.sessionId, {
      participant_id: input.participantId,
      run_id: input.runId,
      assignment_id: input.assignmentId,
      attempt_id: attempt.attempt_id,
      attempt_number: attempt.attempt_number,
      attempt_status: 'recording',
      task_status: 'pending',
      trial_index: task.position,
      task_prompt: task.task_prompt,
      site_url: task.site_url,
      website: run.website,
      study_revision_id: run.study_revision_id,
      study_revision_digest: run.study_revision_digest,
      website_snapshot: run.website_snapshot,
      recording_timing: input.recordingTiming,
    });
    if (session.status !== 'recording'
        || (session.attempt_status && session.attempt_status !== 'recording')) {
      throw new Error('Session already contains terminal evidence and cannot create an attempt');
    }
    if (session.attempt_id && session.attempt_id !== attempt.attempt_id) {
      attempt = {
        ...attempt,
        attempt_id: session.attempt_id,
        attempt_number: session.attempt_number || attempt.attempt_number,
      };
    }
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
    await writeFileAtomic(file, input.data);
    return file;
  });
}

export async function listParticipants(): Promise<ParticipantRecord[]> {
  let names: string[] = [];
  try { names = (await fs.readdir(PARTICIPANT_DATA_DIR)).filter((name) => !name.startsWith('.')); } catch { return []; }
  const records = await Promise.all(names.sort().map((name) =>
    readJsonMaybe<ParticipantRecord>(path.join(PARTICIPANT_DATA_DIR, name, 'participant.json'))
  ));
  return records.filter((record): record is ParticipantRecord => Boolean(record));
}

export async function listRuns(participantId: string): Promise<RunRecord[]> {
  const root = path.join(participantDir(participantId), 'runs');
  let names: string[] = [];
  try { names = (await fs.readdir(root)).filter((name) => !name.startsWith('.')); } catch { return []; }
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
  const updateUnderParticipantLock = async (): Promise<RunRecord> => withLock(`participant:${participantId}`, async () => {
    const file = path.join(runDir(participantId, runId), 'run.json');
    const next = await withLock(`run:${runId}`, async () => {
      const current = await readJson<RunRecord>(file);
      if (status === 'active' && (current.status === 'completed' || current.status === 'aborted')) {
        throw new ContractError('run_terminal', `Run is ${current.status}; terminal runs cannot be reactivated`);
      }
      if (status === 'active') {
        const active = (await listRuns(participantId)).find(
          (candidate) => candidate.run_id !== runId && candidate.status === 'active',
        );
        if (active) {
          throw new ContractError('participant_run_active', 'Participant already has an active run', false, {
            participantId, activeRunId: active.run_id, studyRevisionId: active.study_revision_id,
          });
        }
      }
      const updated = { ...current, status };
      await writeJsonAtomic(file, updated);
      return updated;
    });
    const participantFile = path.join(participantDir(participantId), 'participant.json');
    const participant = await readJson<ParticipantRecord>(participantFile);
    await writeJsonAtomic(participantFile, {
      ...participant,
      active_run_id: status === 'active'
        ? runId
        : participant.active_run_id === runId ? undefined : participant.active_run_id,
      updated_at: new Date().toISOString(),
    });
    return next;
  });
  // New managed runs must use the same admission lock as creation. Legacy runs
  // have no study binding and retain the old local-admin compatibility path.
  if (status === 'active') {
    const current = await readJson<RunRecord>(path.join(runDir(participantId, runId), 'run.json'));
    if (current.study_revision_id) {
      return withStudyRegistrationLock(current.study_revision_id, async () => {
        const registration = await getStudyRevisionRegistration(current.study_revision_id!);
        if (!registration) throw new ContractError('study_revision_not_found', 'Study revision was not registered');
        assertStudyAdmissionAccepting(registration);
        return updateUnderParticipantLock();
      });
    }
  }
  return updateUnderParticipantLock();
}
