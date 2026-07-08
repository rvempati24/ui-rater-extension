import path from 'path';
import fs from 'fs/promises';
import { Trial, ResultsStore } from '@/types';

const RESULTS_PATH = path.join(process.cwd(), '..', 'data', 'results.json');
const TMP_PATH = RESULTS_PATH + '.tmp';

async function readResults(): Promise<ResultsStore> {
  const raw = await fs.readFile(RESULTS_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function writeResults(data: ResultsStore): Promise<void> {
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
  const data = await readResults();
  return data[participantId]?.trials ?? null;
}
