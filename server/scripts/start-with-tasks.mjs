import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadMind2WebPrompts,
  loadTaskArray,
  parseTaskNumbers,
  selectTasks,
} from './task-selection.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `Usage: npm run dev:tasks -- [options]\n\n` +
    `  --tasks-json <file>       Source task JSON (default: config/trials-config.json)\n` +
    `  --all                     Run all available tasks (default)\n` +
    `  --random [n]              Randomly run one task, or n tasks\n` +
    `  --tasks <1 3 5|1,3,5>     Run specified 1-based source task numbers\n` +
    `  --mind2web                Keep only original Mind2Web tasks\n` +
    `  --mind2web-tasks <file>   Optional numbered Mind2Web task list\n` +
    `  --seed <text>             Reproduce random selection\n` +
    `  --dry-run                 Print selection without starting Next.js\n` +
    `  --help                    Show this help`;
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args) {
  const options = { taskValues: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') options.help = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--mind2web') options.mind2webOnly = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--tasks-json') options.taskFile = takeValue(args, index++, arg);
    else if (arg === '--mind2web-tasks') options.mind2webFile = takeValue(args, index++, arg);
    else if (arg === '--seed') options.seed = takeValue(args, index++, arg);
    else if (arg === '--random') {
      const next = args[index + 1];
      options.randomCount = next && !next.startsWith('--') ? Number(args[++index]) : 1;
    } else if (arg === '--tasks') {
      while (args[index + 1] && !args[index + 1].startsWith('--')) options.taskValues.push(args[++index]);
      if (options.taskValues.length === 0) throw new Error('--tasks requires task numbers.');
    } else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.all && (options.randomCount != null || options.taskValues.length)) {
    throw new Error('--all cannot be combined with --random or --tasks.');
  }
  if (options.randomCount != null && options.taskValues.length) {
    throw new Error('--random and --tasks are mutually exclusive.');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const taskFile = path.resolve(serverDir, options.taskFile ?? 'config/trials-config.json');
  const mind2webFile = options.mind2webFile ? path.resolve(serverDir, options.mind2webFile) : undefined;
  const seed = options.seed ?? randomBytes(8).toString('hex');
  const tasks = await loadTaskArray(taskFile);
  const mind2webPrompts = options.mind2webOnly
    ? await loadMind2WebPrompts(taskFile, mind2webFile)
    : new Set();
  const selected = selectTasks(tasks, {
    mind2webOnly: options.mind2webOnly,
    mind2webPrompts,
    taskNumbers: options.taskValues.length ? parseTaskNumbers(options.taskValues) : undefined,
    randomCount: options.randomCount,
    seed,
  });

  console.log(`Task source: ${taskFile}`);
  console.log(`Selected ${selected.tasks.length}/${tasks.length} task(s): ${selected.sourceIndices.join(', ')}`);
  if (options.randomCount != null) console.log(`Random seed: ${seed}`);
  selected.tasks.forEach((task, index) => console.log(`  ${index + 1}. [source ${selected.sourceIndices[index]}] ${task.task_prompt ?? task.slug ?? 'untitled'}`));
  if (options.dryRun) return;

  const runtimeDir = path.join(serverDir, '.runtime');
  await fsp.mkdir(runtimeDir, { recursive: true });
  const runtimeFile = path.join(runtimeDir, `trials-config-${process.pid}.json`);
  await fsp.writeFile(runtimeFile, `${JSON.stringify(selected.tasks, null, 2)}\n`, 'utf8');

  const nextBin = path.join(serverDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'dev'], {
    cwd: serverDir,
    env: { ...process.env, UI_RATER_TRIALS_CONFIG: runtimeFile },
    stdio: 'inherit',
  });

  const cleanup = () => {
    try { fs.unlinkSync(runtimeFile); } catch (error) { if (error?.code !== 'ENOENT') console.error(error); }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  console.error(`Task selection failed: ${error.message}`);
  process.exitCode = 1;
});
