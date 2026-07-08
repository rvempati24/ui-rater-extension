import path from 'path';
import fs from 'fs/promises';

const PARTICIPANTS_PATH = path.join(process.cwd(), 'data', 'participants.json');

export async function isValidParticipant(id: string): Promise<boolean> {
  const raw = await fs.readFile(PARTICIPANTS_PATH, 'utf-8');
  const list: string[] = JSON.parse(raw);
  return list.includes(id);
}
