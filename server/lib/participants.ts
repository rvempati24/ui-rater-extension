import fs from 'fs/promises';
import { BUNDLED_PARTICIPANTS_PATH, PARTICIPANTS_PATH } from './paths';
import { writeFileAtomic } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';

export async function participantRegistry(): Promise<string[]> {
  return withFileLock('participant-registry-bootstrap', async () => {
    let raw: string;
    try { raw = await fs.readFile(PARTICIPANTS_PATH, 'utf-8'); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = await fs.readFile(BUNDLED_PARTICIPANTS_PATH, 'utf-8');
      await writeFileAtomic(PARTICIPANTS_PATH, raw, 'utf8');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error('Participant registry must be an array of participant IDs');
    }
    return parsed;
  });
}

export async function isValidParticipant(id: string): Promise<boolean> {
  return (await participantRegistry()).includes(id);
}
