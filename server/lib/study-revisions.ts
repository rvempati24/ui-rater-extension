import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ContractError,
  assertIdempotencyKey,
  requestDigest,
  validateCollectionRegistration,
  validateStudyRevision,
  type CollectionStudyRegistration,
  type StudyRevisionDescriptor,
} from '@ui-rater/contracts';
import { writeJsonAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';
import { PARTICIPANT_DATA_DIR, STUDY_REVISIONS_DIR } from './paths.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface StudyRegistrationReceipt {
  schema_version: 1;
  study_revision_id: string;
  idempotency_key: string;
  request_digest: string;
  registered_at: string;
}

export interface StudyRevisionRegistration {
  revision: StudyRevisionDescriptor;
  registration: CollectionStudyRegistration;
}

export interface StudySummary {
  registration: CollectionStudyRegistration;
  runCounts: { active: number; completed: number; aborted: number; total: number };
}

function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new ContractError('invalid_id', `Invalid ${label}`);
}

function studyDir(studyRevisionId: string): string {
  assertId(studyRevisionId, 'studyRevisionId');
  return path.join(STUDY_REVISIONS_DIR, studyRevisionId);
}

async function readJsonMaybe<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function withStudyRegistrationLock<T>(studyRevisionId: string, fn: () => Promise<T>): Promise<T> {
  assertId(studyRevisionId, 'studyRevisionId');
  return withFileLock(`study-registration:${studyRevisionId}`, fn);
}

async function readRegistrationUnlocked(studyRevisionId: string): Promise<StudyRevisionRegistration | null> {
  const root = studyDir(studyRevisionId);
  const revisionRaw = await readJsonMaybe<unknown>(path.join(root, 'revision.json'));
  if (revisionRaw === null) return null;
  const revision = validateStudyRevision(revisionRaw);
  if (revision.studyRevisionId !== studyRevisionId) {
    throw new ContractError('study_revision_corrupt', 'Stored study revision ID does not match its directory');
  }
  const storedAdmission = await readJsonMaybe<unknown>(path.join(root, 'admission.json'));
  if (!storedAdmission) {
    throw new ContractError(
      'study_registration_corrupt',
      'Stored Study Revision has no admission state; refusing to admit work',
    );
  }
  const registration = validateCollectionRegistration(storedAdmission);
  if (registration.studyRevisionId !== studyRevisionId) {
    throw new ContractError('study_registration_corrupt', 'Stored admission ID does not match its directory');
  }
  if (registration.revisionDigest !== requestDigest(revision)) {
    throw new ContractError('study_registration_corrupt', 'Stored admission digest does not match revision');
  }
  return { revision, registration };
}

export async function getStudyRevisionRegistration(studyRevisionId: string): Promise<StudyRevisionRegistration | null> {
  return readRegistrationUnlocked(studyRevisionId);
}

export async function getCurrentStudyRevision(): Promise<StudyRevisionRegistration | null> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(STUDY_REVISIONS_DIR, { withFileTypes: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let current: { registeredAt: string; value: StudyRevisionRegistration } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const value = await readRegistrationUnlocked(entry.name);
    if (!value || value.registration.admission !== 'accepting') continue;
    const receipt = await readJsonMaybe<StudyRegistrationReceipt>(
      path.join(STUDY_REVISIONS_DIR, entry.name, 'registration-receipt.json'),
    );
    if (!receipt) throw new ContractError('study_registration_corrupt', 'Stored Study Revision has no registration receipt');
    if (!current
      || receipt.registered_at > current.registeredAt
      || (receipt.registered_at === current.registeredAt
        && value.revision.studyRevisionId > current.value.revision.studyRevisionId)) {
      current = { registeredAt: receipt.registered_at, value };
    }
  }
  return current?.value ?? null;
}

export async function registerStudyRevision(
  rawRevision: unknown,
  idempotencyKey: string,
): Promise<{ registration: CollectionStudyRegistration; created: boolean }> {
  let revision: StudyRevisionDescriptor;
  try { revision = validateStudyRevision(rawRevision); }
  catch (error: unknown) {
    throw new ContractError('invalid_request', error instanceof Error ? error.message : 'Invalid Study Revision');
  }
  assertIdempotencyKey(idempotencyKey);
  const digest = requestDigest(revision);
  const keyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
  const globalReceiptFile = path.join(STUDY_REVISIONS_DIR, '.registration-receipts', `${keyHash}.json`);
  return withFileLock(`study-registration-key:${keyHash}`, async () => {
    const globalReceipt = await readJsonMaybe<StudyRegistrationReceipt>(globalReceiptFile);
    if (globalReceipt) {
      if (globalReceipt.request_digest !== digest
        || globalReceipt.study_revision_id !== revision.studyRevisionId) {
        throw new ContractError('idempotency_key_reused', 'Idempotency-Key was reused with different content');
      }
      const existing = await readRegistrationUnlocked(globalReceipt.study_revision_id);
      if (!existing) {
        throw new ContractError('study_registration_corrupt', 'Idempotency receipt points to a missing Study Revision');
      }
      return { registration: existing.registration, created: false };
    }
    return withStudyRegistrationLock(revision.studyRevisionId, async () => {
    const root = studyDir(revision.studyRevisionId);
    const existingReceipt = await readJsonMaybe<StudyRegistrationReceipt>(path.join(root, 'registration-receipt.json'));
    // Check the caller's idempotency key before comparing the immutable
    // revision ID. This keeps a reused key deterministic even when the caller
    // accidentally submits a different revision ID/content pair.
    if (existingReceipt && existingReceipt.idempotency_key === idempotencyKey && existingReceipt.request_digest !== digest) {
      throw new ContractError('idempotency_key_reused', 'Idempotency-Key was reused with different content');
    }
    const existing = await readRegistrationUnlocked(revision.studyRevisionId);
    if (existing) {
      const existingDigest = requestDigest(existing.revision);
      if (existingDigest !== digest) {
        throw new ContractError('study_revision_conflict', 'Study revision ID is already bound to different content', false, {
          studyRevisionId: revision.studyRevisionId,
          existingDigest,
          requestDigest: digest,
        });
      }
      const receipt: StudyRegistrationReceipt = {
        schema_version: 1,
        study_revision_id: revision.studyRevisionId,
        idempotency_key: idempotencyKey,
        request_digest: digest,
        registered_at: new Date().toISOString(),
      };
      await writeJsonAtomic(globalReceiptFile, receipt);
      return { registration: existing.registration, created: false };
    }
    const registration: CollectionStudyRegistration = {
      studyRevisionId: revision.studyRevisionId,
      revisionDigest: digest,
      admission: 'accepting',
    };
    const receipt: StudyRegistrationReceipt = {
      schema_version: 1,
      study_revision_id: revision.studyRevisionId,
      idempotency_key: idempotencyKey,
      request_digest: digest,
      registered_at: new Date().toISOString(),
    };
    const staging = path.join(STUDY_REVISIONS_DIR, `.${revision.studyRevisionId}.staging-${crypto.randomUUID()}`);
    try {
      await writeJsonAtomic(path.join(staging, 'revision.json'), revision);
      await writeJsonAtomic(path.join(staging, 'admission.json'), registration);
      await writeJsonAtomic(path.join(staging, 'registration-receipt.json'), receipt);
      await fs.mkdir(STUDY_REVISIONS_DIR, { recursive: true });
      await fs.rename(staging, root);
      await writeJsonAtomic(globalReceiptFile, receipt);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { registration, created: true };
    });
  });
}

async function countRunsForStudy(studyRevisionId: string): Promise<StudySummary['runCounts']> {
  const counts: StudySummary['runCounts'] = { active: 0, completed: 0, aborted: 0, total: 0 };
  let participants: string[] = [];
  try { participants = (await fs.readdir(PARTICIPANT_DATA_DIR)).filter((name) => !name.startsWith('.')); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return counts;
    throw error;
  }
  for (const participantId of participants) {
    const runsRoot = path.join(PARTICIPANT_DATA_DIR, participantId, 'runs');
    let runIds: string[] = [];
    try { runIds = (await fs.readdir(runsRoot)).filter((name) => !name.startsWith('.')); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const runId of runIds) {
      const run = await readJsonMaybe<{ study_revision_id?: string; status?: string }>(path.join(runsRoot, runId, 'run.json'));
      if (!run) {
        throw new ContractError('study_run_state_unreadable', 'A Participant Run directory has no readable run.json', true, {
          participantId, runId,
        });
      }
      if (run.study_revision_id !== studyRevisionId) continue;
      counts.total += 1;
      if (run.status === 'active') counts.active += 1;
      else if (run.status === 'completed') counts.completed += 1;
      else if (run.status === 'aborted') counts.aborted += 1;
      else if (run.status !== 'archived') {
        throw new ContractError('study_run_state_unreadable', 'A Participant Run has an unknown lifecycle status', true, {
          participantId, runId, status: run.status,
        });
      }
    }
  }
  return counts;
}

export async function summarizeStudyRevision(studyRevisionId: string): Promise<StudySummary> {
  return withStudyRegistrationLock(studyRevisionId, async () => {
    const current = await readRegistrationUnlocked(studyRevisionId);
    if (!current) throw new ContractError('study_revision_not_found', 'Study revision was not found');
    return { registration: current.registration, runCounts: await countRunsForStudy(studyRevisionId) };
  });
}

async function transitionAdmission(
  studyRevisionId: string,
  target: 'closed' | 'retired',
): Promise<CollectionStudyRegistration> {
  return withStudyRegistrationLock(studyRevisionId, async () => {
    const current = await readRegistrationUnlocked(studyRevisionId);
    if (!current) throw new ContractError('study_revision_not_found', 'Study revision was not found');
    const admission = current.registration.admission;
    if (target === 'closed') {
      if (admission === 'retired') throw new ContractError('study_already_retired', 'Retired study admission cannot be reopened');
      if (admission === 'closed') return current.registration;
    } else {
      if (admission === 'retired') return current.registration;
      if (admission === 'accepting') throw new ContractError('study_admission_open', 'Study admission must be closed before retirement');
      const counts = await countRunsForStudy(studyRevisionId);
      if (counts.active > 0) {
        throw new ContractError('active_participant_runs', 'Study has active participant runs', true, { active: counts.active });
      }
    }
    const next: CollectionStudyRegistration = { ...current.registration, admission: target };
    await writeJsonAtomic(path.join(studyDir(studyRevisionId), 'admission.json'), next);
    return next;
  });
}

export function closeStudyRevision(studyRevisionId: string): Promise<CollectionStudyRegistration> {
  return transitionAdmission(studyRevisionId, 'closed');
}

export function retireStudyRevision(studyRevisionId: string): Promise<CollectionStudyRegistration> {
  return transitionAdmission(studyRevisionId, 'retired');
}

export function assertStudyAdmissionAccepting(registration: StudyRevisionRegistration): void {
  if (registration.registration.admission !== 'accepting') {
    throw new ContractError('study_admission_closed', `Study admission is ${registration.registration.admission}`, false, {
      studyRevisionId: registration.revision.studyRevisionId,
      admission: registration.registration.admission,
    });
  }
}
