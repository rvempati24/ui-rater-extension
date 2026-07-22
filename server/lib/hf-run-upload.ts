import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getRun } from './participant-store.ts';
import { DATA_DIR, PARTICIPANT_DATA_DIR } from './paths.ts';
import { writeJsonAtomic } from './atomic-file.ts';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uploads = new Map<string, Promise<UploadResult>>();
let uploadTail: Promise<void> = Promise.resolve();

export interface UploadResult {
  repo_id: string;
  revision: string;
  commit: string;
  synced_at: string;
}

function serializeUpload<T>(operation: () => Promise<T>): Promise<T> {
  const result = uploadTail.then(operation);
  uploadTail = result.then(() => {}, () => {});
  return result;
}

function syncStatePath(runId: string): string {
  return path.join(DATA_DIR, 'sync-state', `${runId}.json`);
}

export async function getRunUploadStatus(participantId: string, runId: string) {
  const found = await getRun(participantId, runId);
  if (!found) throw new Error('Run not found');
  const repoId = process.env.HF_DATASET_REPO || 'uxBench/ux-task-trace';
  const revision = process.env.HF_DATASET_REVISION || 'participant-v3-integrity';
  let sync: UploadResult | null = null;
  try {
    const stored = JSON.parse(await fs.readFile(syncStatePath(runId), 'utf8'));
    if (stored.participant_id === participantId && stored.run_id === runId
      && stored.hf_repo_id === repoId && stored.hf_revision === revision) {
      sync = {
        repo_id: stored.hf_repo_id,
        revision: stored.hf_revision,
        commit: stored.hf_commit_sha,
        synced_at: stored.synced_at,
      };
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    run_status: found.run.status,
    available: Boolean(process.env.HF_TOKEN),
    repo_id: repoId,
    revision,
    uploading: uploads.has(runId),
    nothing_to_upload: found.run.status === 'completed'
      && !found.tasks.some((task) => Boolean(task.accepted_attempt_id)),
    sync,
  };
}

export async function uploadCompletedRun(participantId: string, runId: string): Promise<UploadResult> {
  const existing = uploads.get(runId);
  if (existing) return existing;
  const operation = serializeUpload(async () => {
    const statusBeforeUpload = await getRunUploadStatus(participantId, runId);
    if (statusBeforeUpload.run_status !== 'completed') {
      throw new Error('Only completed runs can be uploaded');
    }
    if (statusBeforeUpload.sync) return statusBeforeUpload.sync;
    if (statusBeforeUpload.nothing_to_upload) {
      const result: UploadResult = {
        repo_id: statusBeforeUpload.repo_id,
        revision: statusBeforeUpload.revision,
        commit: 'no-accepted-attempts',
        synced_at: new Date().toISOString(),
      };
      await writeJsonAtomic(syncStatePath(runId), {
        schema_version: 1,
        participant_id: participantId,
        run_id: runId,
        hf_repo_id: result.repo_id,
        hf_revision: result.revision,
        hf_commit_sha: result.commit,
        synced_at: result.synced_at,
        no_artifacts: true,
      });
      return result;
    }
    if (!process.env.HF_TOKEN) throw new Error('HF_TOKEN is not configured on the server');
    if (process.env.UI_RATER_DISABLE_EXTERNAL_WRITES === '1') {
      throw new Error('External writes are disabled for this process');
    }

    const script = path.join(REPOSITORY_ROOT, 'scripts', 'export_traces.py');
    const runner = path.join(REPOSITORY_ROOT, 'scripts', 'run-python.sh');
    const command = process.platform === 'win32'
      ? (process.env.PYTHON || 'python') : 'sh';
    const prefix = process.platform === 'win32' ? [script] : [runner, script];
    const { stdout } = await execFileAsync(command, [
      ...prefix,
      '--participants-dir', PARTICIPANT_DATA_DIR,
      '--participant-id', participantId,
      '--run-id', runId,
      '--upload-hf',
    ], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, UI_RATER_KEEP_LOCAL_EXPORT: 'false' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    const status = await getRunUploadStatus(participantId, runId);
    if (!status.sync) {
      throw new Error(`Upload finished without sync state. Exporter output: ${stdout.slice(-1000)}`);
    }
    return status.sync;
  });
  uploads.set(runId, operation);
  try { return await operation; }
  finally { uploads.delete(runId); }
}
