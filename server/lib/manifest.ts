import path from 'path';
import fs from 'fs/promises';
import { TrialConfigEntry } from '@/types';

const TRIALS_CONFIG_PATH = path.join(process.cwd(), '..', 'data', 'trials-config.json');

let _cache: TrialConfigEntry[] | null = null;

export async function getTrialConfigs(): Promise<TrialConfigEntry[]> {
  if (_cache) return _cache;
  const raw = await fs.readFile(TRIALS_CONFIG_PATH, 'utf-8');
  _cache = JSON.parse(raw);
  return _cache!;
}
