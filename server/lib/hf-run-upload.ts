import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRun } from './participant-store.ts';
import { DATA_DIR, PARTICIPANT_DATA_DIR } from './paths.ts';

const execFileAsync = promisify(execFile);
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
  const revision = process.env.HF_DATASET_REVISION || 'participant-v2';
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
    if (!process.env.HF_TOKEN) throw new Error('HF_TOKEN is not configured on the server');

    const repositoryRoot = path.dirname(DATA_DIR);
    const script = path.join(repositoryRoot, 'scripts', 'export_traces.py');
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const { stdout } = await execFileAsync(python, [
      script,
      '--participants-dir', PARTICIPANT_DATA_DIR,
      '--participant-id', participantId,
      '--run-id', runId,
      '--upload-hf',
    ], {
      cwd: repositoryRoot,
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
