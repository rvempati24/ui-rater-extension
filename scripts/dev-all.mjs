import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildDevAllConfig(environment = process.env) {
  const dataRoot = path.resolve(environment.UI_RATER_DEV_DATA_ROOT || path.join(rootDir, 'data'));
  const websiteUrl = environment.WEBSITE_SERVICE_URL || 'http://127.0.0.1:4173';
  const collectionUrl = environment.COLLECTION_SERVICE_URL || 'http://127.0.0.1:3000';
  const managerUrl = environment.MANAGER_SERVICE_URL || 'http://127.0.0.1:4310';
  return {
    dataRoot,
    services: [
      {
        name: 'website',
        command: process.execPath,
        args: ['--import', 'tsx', 'services/website-server/src/server.ts'],
        cwd: rootDir,
        healthUrl: `${websiteUrl.replace(/\/$/, '')}/api/v1/health/ready`,
        env: {
          UI_RATER_REPO_DIR: environment.UI_RATER_REPO_DIR || rootDir,
          WEBSITE_SERVICE_DATA_DIR: environment.WEBSITE_SERVICE_DATA_DIR || path.join(dataRoot, 'website'),
        },
      },
      {
        name: 'collection',
        command: process.execPath,
        args: [path.join(rootDir, 'server', 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev'],
        cwd: path.join(rootDir, 'server'),
        healthUrl: `${collectionUrl.replace(/\/$/, '')}/api/v1/health/ready`,
        env: {
          UI_RATER_DATA_DIR: environment.UI_RATER_DATA_DIR || path.join(dataRoot, 'collection'),
        },
      },
      {
        name: 'manager',
        command: process.execPath,
        args: ['--import', 'tsx', 'services/manager/src/server.ts'],
        cwd: rootDir,
        healthUrl: `${managerUrl.replace(/\/$/, '')}/api/v1/health/ready`,
        env: {
          MANAGER_DATA_DIR: environment.MANAGER_DATA_DIR || path.join(dataRoot, 'manager'),
          WEBSITE_SERVICE_URL: websiteUrl,
          COLLECTION_SERVICE_URL: collectionUrl,
        },
      },
    ],
  };
}

function prefixOutput(stream, label, destination) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) destination.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => { if (pending) destination.write(`[${label}] ${pending}\n`); });
}

function signalChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForHealth(service, child, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${service.name} exited before becoming ready`);
    }
    try {
      const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${service.name} readiness timed out: ${lastError?.message || 'unavailable'}`);
}

function printableConfig(config) {
  return {
    dataRoot: config.dataRoot,
    services: config.services.map(({ name, args, cwd, healthUrl, env }) => ({ name, args, cwd, healthUrl, env })),
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    console.log('Usage: npm run dev:all [-- --print-config]\n\nEnvironment: UI_RATER_DEV_DATA_ROOT, WEBSITE_SERVICE_DATA_DIR, UI_RATER_DATA_DIR, MANAGER_DATA_DIR, WEBSITE_SERVICE_URL, COLLECTION_SERVICE_URL, MANAGER_SERVICE_URL');
    return;
  }
  const config = buildDevAllConfig();
  if (args.has('--print-config')) {
    console.log(JSON.stringify(printableConfig(config), null, 2));
    return;
  }
  const children = new Map();
  let shuttingDown = false;
  let shutdownPromise;

  const shutdown = (exitCode, reason) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    if (reason) console.error(`[launcher] ${reason}`);
    shutdownPromise = (async () => {
      for (const child of children.values()) signalChild(child, 'SIGTERM');
      await Promise.race([
        Promise.all([...children.values()].map((child) => child.exitCode !== null
          ? undefined
          : new Promise((resolve) => child.once('exit', resolve)))),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      for (const child of children.values()) signalChild(child, 'SIGKILL');
      process.exitCode = exitCode;
    })();
    return shutdownPromise;
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void shutdown(0, `received ${signal}; stopping all services`); });
  }

  for (const service of config.services) {
    const child = spawn(service.command, service.args, {
      cwd: service.cwd,
      env: { ...process.env, ...service.env },
      // Keep every child in the launcher's foreground process group so a
      // terminal Ctrl+C reaches all services even when npm exits first.
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(service.name, child);
    prefixOutput(child.stdout, service.name, process.stdout);
    prefixOutput(child.stderr, service.name, process.stderr);
    child.once('error', (error) => { void shutdown(1, `${service.name} failed to start: ${error.message}`); });
    child.once('exit', (code, signal) => {
      if (!shuttingDown) void shutdown(1, `${service.name} exited (${signal || (code ?? 'unknown')}); stopping all services`);
    });
  }

  const timeoutMs = Number(process.env.UI_RATER_DEV_STARTUP_TIMEOUT_MS || 60_000);
  try {
    await Promise.all(config.services.map((service) => waitForHealth(service, children.get(service.name), timeoutMs)));
    console.log('[launcher] Website, Collection, and Manager are ready. Press Ctrl+C to stop all services.');
    for (const service of config.services) console.log(`[launcher] ${service.name}: ${service.healthUrl}`);
  } catch (error) {
    await shutdown(1, error instanceof Error ? error.message : 'Service startup failed');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
