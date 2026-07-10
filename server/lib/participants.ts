import fs from 'fs/promises';
import { PARTICIPANTS_PATH } from './paths';

export async function isValidParticipant(id: string): Promise<boolean> {
  const raw = await fs.readFile(PARTICIPANTS_PATH, 'utf-8');
  const list: string[] = JSON.parse(raw);
  return list.includes(id);
}
