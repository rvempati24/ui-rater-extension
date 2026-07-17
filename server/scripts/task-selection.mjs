import fs from 'node:fs/promises';
import path from 'node:path';

function normalizePrompt(value) {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function parseTaskNumbers(values) {
  const tokens = values.flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);
  if (tokens.length === 0) throw new Error('--tasks requires at least one 1-based task number.');

  const numbers = tokens.map((token) => Number(token));
  if (numbers.some((number) => !Number.isInteger(number) || number < 1)) {
    throw new Error('--tasks accepts positive 1-based integers, for example: --tasks 1 3 5');
  }
  if (new Set(numbers).size !== numbers.length) throw new Error('--tasks contains duplicate task numbers.');
  return numbers;
}

export function parseMind2WebPrompts(raw) {
  return new Set(raw
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+[.)]\s*(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .map(normalizePrompt));
}

function hasMind2WebMetadata(task) {
  if (task.is_mind2web === true) return true;
  return [task.source, task.origin, task.task_source]
    .some((value) => typeof value === 'string' && value.toLowerCase() === 'mind2web');
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function selectTasks(tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Task JSON must contain a non-empty array.');

  let candidates = tasks.map((task, index) => ({ task, sourceIndex: index + 1 }));
  if (options.mind2webOnly) {
    const prompts = options.mind2webPrompts ?? new Set();
    candidates = candidates.filter(({ task }) =>
      hasMind2WebMetadata(task) || prompts.has(normalizePrompt(String(task.task_prompt ?? ''))));
    if (candidates.length === 0) {
      throw new Error('No Mind2Web tasks found. Add source/origin/task_source="mind2web", is_mind2web=true, or an adjacent mind2web_tasks.txt.');
    }
  }

  if (options.taskNumbers) {
    const byIndex = new Map(candidates.map((candidate) => [candidate.sourceIndex, candidate]));
    const missing = options.taskNumbers.filter((number) => !byIndex.has(number));
    if (missing.length) throw new Error(`Task number(s) unavailable after filtering: ${missing.join(', ')}`);
    candidates = options.taskNumbers.map((number) => byIndex.get(number));
  }

  if (options.randomCount != null) {
    if (!Number.isInteger(options.randomCount) || options.randomCount < 1) {
      throw new Error('--random requires a positive integer.');
    }
    if (options.randomCount > candidates.length) {
      throw new Error(`Cannot sample ${options.randomCount} tasks from ${candidates.length} available tasks.`);
    }
    const random = seededRandom(options.seed);
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
    }
    candidates = candidates.slice(0, options.randomCount);
  }

  return {
    tasks: candidates.map(({ task, sourceIndex }) => ({
      ...task,
      source_position: sourceIndex,
    })),
    sourceIndices: candidates.map(({ sourceIndex }) => sourceIndex),
  };
}

export async function loadTaskArray(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks)) throw new Error('Task JSON must be an array or an object with a tasks array.');
  return tasks;
}

export async function loadMind2WebPrompts(taskFile, explicitFile) {
  const sidecar = explicitFile ?? path.join(path.dirname(taskFile), 'mind2web_tasks.txt');
  try {
    return parseMind2WebPrompts(await fs.readFile(sidecar, 'utf8'));
  } catch (error) {
    if (explicitFile || error?.code !== 'ENOENT') throw error;
    return new Set();
  }
}
