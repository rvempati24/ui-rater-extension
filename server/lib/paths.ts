import path from 'path';
import fs from 'fs';

// Detect whether process.cwd() is the server/ dir or the repo root.
const cwd = process.cwd();
const candidate = path.join(cwd, 'data');
const fallback = path.join(cwd, '..', 'data');

export const DATA_DIR = fs.existsSync(candidate) ? candidate : fallback;
export const RESULTS_PATH = path.join(DATA_DIR, 'results.json');
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Config files live in server/config/, not in data/
const configCandidate = path.join(cwd, 'config');
const configFallback = path.join(cwd, 'server', 'config');
const CONFIG_DIR = fs.existsSync(configCandidate) ? configCandidate : configFallback;

export const PARTICIPANTS_PATH = path.join(CONFIG_DIR, 'participants.json');
export const TRIALS_CONFIG_PATH = path.join(CONFIG_DIR, 'trials-config.json');
