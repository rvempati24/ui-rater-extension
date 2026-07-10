import fs from 'fs/promises';
import { TrialConfigEntry } from '@/types';
import { TRIALS_CONFIG_PATH } from './paths';

let _cache: TrialConfigEntry[] | null = null;

export async function getTrialConfigs(): Promise<TrialConfigEntry[]> {
  if (_cache) return _cache;
  const raw = await fs.readFile(TRIALS_CONFIG_PATH, 'utf-8');
  _cache = JSON.parse(raw);
  return _cache!;
}
