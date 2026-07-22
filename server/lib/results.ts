import fs from 'fs/promises';
import type { ParticipantData, Trial, ResultsStore } from '@/types';
import { RESULTS_PATH } from './paths.ts';
import { writeJsonAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';

async function readResults(): Promise<ResultsStore> {
  try {
    const raw = await fs.readFile(RESULTS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeResults(data: ResultsStore): Promise<void> {
  await writeJsonAtomic(RESULTS_PATH, data);
}

export function withResultsLock<T>(fn: (data: ResultsStore) => Promise<T>): Promise<T> {
  return withFileLock('legacy-results', async () => {
    const data = await readResults();
    const result = await fn(data);
    await writeResults(data);
    return result;
  });
}

export async function getParticipantTrials(
  participantId: string
): Promise<Trial[] | null> {
  return (await getParticipantData(participantId))?.trials ?? null;
}

export async function getParticipantData(
  participantId: string
): Promise<ParticipantData | null> {
  const data = await readResults();
  return data[participantId] ?? null;
}
