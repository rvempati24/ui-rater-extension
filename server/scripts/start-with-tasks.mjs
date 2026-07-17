import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  loadMind2WebPrompts,
  loadTaskArray,
  parseTaskNumbers,
  selectTasks,
} from './task-selection.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(serverDir, '..');

function usage() {
  return `Usage: npm run dev:tasks -- [options]\n\n` +
    `  --website-dir <folder>    Prefer a local website run containing dist/ and trials-config.json\n` +
    `  --tasks-json <file>       Override task JSON inside a local website run\n` +
    `  --hf-website <path>       Exact remote model/website/run-id\n` +
    `  --hf-model <name>         Restrict random remote selection by model\n` +
    `  --hf-site <name>          Restrict random remote selection by website\n` +
    `  --hf-revision <revision>  Dataset revision (default: prompt-userflow-regen-20260624)\n` +
    `  --website-cache <folder>  Download cache (default: .website-cache)\n` +
    `  --website-port <port>     Synthetic website port (default: 4173)\n` +
    `  --all                     Run all available tasks (default)\n` +
    `  --random [n]              Randomly run one task, or n tasks\n` +
    `  --tasks <1 3 5|1,3,5>     Run specified 1-based source task numbers\n` +
    `  --mind2web                Keep only original Mind2Web tasks\n` +
    `  --mind2web-tasks <file>   Optional numbered Mind2Web task list\n` +
    `  --seed <text>             Reproduce random selection\n` +
    `  --keep-open               Keep localhost running after the selected run completes\n` +
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
    else if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--website-dir') options.websiteDir = takeValue(args, index++, arg);
    else if (arg === '--tasks-json') options.taskFile = takeValue(args, index++, arg);
    else if (arg === '--hf-website') options.hfWebsite = takeValue(args, index++, arg);
    else if (arg === '--hf-model') options.hfModel = takeValue(args, index++, arg);
    else if (arg === '--hf-site') options.hfSite = takeValue(args, index++, arg);
    else if (arg === '--hf-revision') options.hfRevision = takeValue(args, index++, arg);
    else if (arg === '--website-cache') options.websiteCache = takeValue(args, index++, arg);
    else if (arg === '--website-port') options.websitePort = Number(takeValue(args, index++, arg));
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
  const hasHfSelector = options.hfWebsite || options.hfModel || options.hfSite;
  if (options.websiteDir && hasHfSelector) {
    throw new Error('--website-dir cannot be combined with Hugging Face website selectors.');
  }
  if (options.taskFile && hasHfSelector) {
    throw new Error('--tasks-json cannot be combined with Hugging Face website selectors.');
  }
  if (options.websitePort != null && (!Number.isInteger(options.websitePort) || options.websitePort < 1 || options.websitePort > 65535)) {
    throw new Error('--website-port must be an integer from 1 to 65535.');
  }
  return options;
}

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

async function startWebsiteServer(distDir, port) {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, 'index.html');
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relative = pathname.replace(/^\/+/, '');
      let target = path.resolve(root, relative || 'index.html');
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        response.writeHead(400).end('Invalid path');
        return;
      }
      const stat = await fsp.stat(target).catch(() => undefined);
      if (!stat?.isFile()) target = indexFile;
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : 'Website server error');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function runPython(args) {
  const configured = process.env.PYTHON ? [{ command: process.env.PYTHON, prefix: [] }] : [];
  const candidates = process.platform === 'win32'
    ? [...configured, { command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }]
    : [...configured, { command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
  let lastResult;
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.prefix, ...args], {
      cwd: repoDir,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    lastResult = result;
    if (result.error || result.status == null) continue;
    break;
  }
  if (!lastResult) throw new Error('Python 3 was not found. Set PYTHON to its executable path.');
  if (lastResult.error) throw new Error(
    `Python 3 could not be started: ${lastResult.error.message}. Set PYTHON to its executable path.`
  );
  if (lastResult.status !== 0) throw new Error(
    (lastResult.stderr || lastResult.stdout).trim() || 'Website downloader failed.'
  );
  const jsonLine = lastResult.stdout.trim().split(/\r?\n/).reverse().find((line) => line.startsWith('{'));
  if (!jsonLine) throw new Error('Website downloader returned no metadata.');
  return JSON.parse(jsonLine);
}

async function localWebsite(options) {
  let sourceDir;
  if (options.websiteDir) sourceDir = path.resolve(serverDir, options.websiteDir);
  else if (options.taskFile) {
    const candidate = path.dirname(path.resolve(serverDir, options.taskFile));
    if (await fsp.stat(path.join(candidate, 'dist', 'index.html')).then(() => true, () => false)) {
      sourceDir = candidate;
    } else {
      throw new Error('--tasks-json is not inside a website run with dist/. Add --website-dir or choose an HF website.');
    }
  }
  if (!sourceDir) return undefined;

  const taskFile = path.resolve(serverDir, options.taskFile ?? path.join(sourceDir, 'trials-config.json'));
  const tasks = await loadTaskArray(taskFile);
  const runIds = [...new Set(tasks.map((task) => task.plain_app).filter(Boolean))];
  if (runIds.length > 1) throw new Error('A website task file must reference exactly one plain_app run.');
  const runId = runIds[0] ?? path.basename(sourceDir);
  const deploymentDir = path.join(serverDir, 'public', 'apps', runId);
  const dist = path.join(sourceDir, 'dist');
  if (!await fsp.stat(path.join(dist, 'index.html')).then(() => true, () => false)) {
    throw new Error(`Local website has no dist/index.html: ${sourceDir}`);
  }

  let existing = {};
  const existingFile = path.join(sourceDir, 'ui-rater-website.json');
  try { existing = JSON.parse(await fsp.readFile(existingFile, 'utf8')); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!options.dryRun) {
    await fsp.mkdir(deploymentDir, { recursive: true });
    await fsp.cp(dist, deploymentDir, { recursive: true, force: true });
  }
  const { files, ...compactExisting } = existing;
  return {
    schema_version: 1,
    source: 'local',
    model: 'local',
    website: tasks[0]?.group ?? path.basename(path.dirname(sourceDir)),
    run_id: runId,
    ...compactExisting,
    file_count: compactExisting.file_count ?? (Array.isArray(files) ? files.length : undefined),
    source_dir: sourceDir,
    task_file: taskFile,
    deployment_dir: deploymentDir,
    metadata_file: await fsp.stat(existingFile).then(() => existingFile, () => undefined),
  };
}

function hfWebsite(options, seed) {
  const cacheDir = path.resolve(serverDir, options.websiteCache ?? '.website-cache');
  const args = [
    path.join(repoDir, 'scripts', 'resolve_hf_website.py'),
    '--revision', options.hfRevision ?? 'prompt-userflow-regen-20260624',
    '--seed', seed,
    '--cache-dir', cacheDir,
    '--deploy-dir', path.join(serverDir, 'public', 'apps'),
  ];
  if (options.hfWebsite) args.push('--website', options.hfWebsite);
  if (options.hfModel) args.push('--model', options.hfModel);
  if (options.hfSite) args.push('--site', options.hfSite);
  if (options.dryRun) args.push('--no-deploy');
  return runPython(args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const seed = options.seed ?? randomBytes(8).toString('hex');
  const website = await localWebsite(options) ?? hfWebsite(options, seed);
  const taskFile = path.resolve(website.task_file);
  const mind2webFile = options.mind2webFile ? path.resolve(serverDir, options.mind2webFile) : undefined;
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

  console.log(`Website: ${website.model}/${website.website}/${website.run_id} (${website.source})`);
  if (website.source === 'huggingface') {
    console.log(`HF source: ${website.repo_id}@${website.revision}/${website.path_in_repo}`);
    console.log(`Website selection seed: ${seed}`);
  }
  console.log(`Task source: ${taskFile}`);
  console.log(`Selected ${selected.tasks.length}/${tasks.length} task(s): ${selected.sourceIndices.join(', ')}`);
  if (options.randomCount != null) console.log(`Random seed: ${seed}`);
  selected.tasks.forEach((task, index) => console.log(`  ${index + 1}. [source ${selected.sourceIndices[index]}] ${task.task_prompt ?? task.slug ?? 'untitled'}`));
  if (options.dryRun) return;

  const websitePort = options.websitePort ?? 4173;
  const websiteUrl = `http://localhost:${websitePort}/`;
  const runtimeTasks = selected.tasks.map((task) => ({ ...task, site_url: websiteUrl }));
  const websiteServer = await startWebsiteServer(path.join(website.source_dir, 'dist'), websitePort);
  website.runtime_url = websiteUrl;
  console.log(`Website runtime: ${websiteUrl}`);

  const runtimeDir = path.join(serverDir, '.runtime');
  await fsp.mkdir(runtimeDir, { recursive: true });
  const runtimeFile = path.join(runtimeDir, `trials-config-${process.pid}.json`);
  const metadataFile = path.join(runtimeDir, `website-metadata-${process.pid}.json`);
  const shutdownFile = path.join(runtimeDir, `shutdown-${process.pid}.json`);
  await fsp.writeFile(runtimeFile, `${JSON.stringify(runtimeTasks, null, 2)}\n`, 'utf8');
  await fsp.writeFile(metadataFile, `${JSON.stringify(website, null, 2)}\n`, 'utf8');

  const nextBin = path.join(serverDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'dev'], {
    cwd: serverDir,
    env: {
      ...process.env,
      UI_RATER_TRIALS_CONFIG: runtimeFile,
      UI_RATER_WEBSITE_SOURCE_DIR: website.source_dir,
      UI_RATER_WEBSITE_METADATA_FILE: metadataFile,
      UI_RATER_WEBSITE_RUN_ID: website.run_id,
      ...(options.keepOpen ? {} : { UI_RATER_SHUTDOWN_FILE: shutdownFile }),
    },
    stdio: 'inherit',
  });

  let shutdownMonitor;
  let autoShutdown = false;
  const cleanup = () => {
    if (shutdownMonitor) clearInterval(shutdownMonitor);
    websiteServer.close();
    try { fs.unlinkSync(runtimeFile); } catch (error) { if (error?.code !== 'ENOENT') console.error(error); }
    try { fs.unlinkSync(metadataFile); } catch (error) { if (error?.code !== 'ENOENT') console.error(error); }
    try { fs.unlinkSync(shutdownFile); } catch (error) { if (error?.code !== 'ENOENT') console.error(error); }
  };
  if (!options.keepOpen) {
    console.log('Auto-close: localhost will stop after this run reaches a terminal state.');
    shutdownMonitor = setInterval(() => {
      if (!fs.existsSync(shutdownFile)) return;
      clearInterval(shutdownMonitor);
      shutdownMonitor = undefined;
      autoShutdown = true;
      console.log('Selected task run completed; stopping localhost...');
      setTimeout(() => {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          try { fs.unlinkSync(path.join(serverDir, '.next', 'dev', 'lock')); }
          catch (error) { if (error?.code !== 'ENOENT') console.error(error); }
        } else {
          child.kill('SIGINT');
        }
      }, 1000);
    }, 250);
  }
  process.on('exit', cleanup);
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    cleanup();
    process.exitCode = autoShutdown ? 0 : code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  console.error(`Task selection failed: ${error.message}`);
  process.exitCode = 1;
});
