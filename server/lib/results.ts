import fs from 'fs/promises';
import path from 'path';
import type { ParticipantData, Trial, ResultsStore } from '@/types';
import { RESULTS_PATH } from './paths.ts';

const TMP_PATH = RESULTS_PATH + '.tmp';

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
  await fs.mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await fs.writeFile(TMP_PATH, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(TMP_PATH, RESULTS_PATH);
}

let writeLock = Promise.resolve();

export function withResultsLock<T>(fn: (data: ResultsStore) => Promise<T>): Promise<T> {
  const next = writeLock.then(async () => {
    const data = await readResults();
    const result = await fn(data);
    await writeResults(data);
    return result;
  });
  writeLock = next.then(
    () => {},
    () => {}
  );
  return next;
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
