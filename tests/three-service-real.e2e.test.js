const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const serverDir = path.join(root, 'server');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(read, predicate, timeoutMs = 25_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for service state${lastError ? `: ${lastError.message}` : ''}`);
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

async function startCollection(port, dataDir) {
  const nextBin = path.join(serverDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      UI_RATER_DATA_DIR: dataDir,
      UI_RATER_SESSION_DIR: path.join(dataDir, 'sessions'),
      UI_RATER_CAPABILITY_SECRET: 'e2e-capability-secret-012345678901234567890123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += String(chunk); });
  child.stderr.on('data', (chunk) => { logs += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      () => fetch(`${url}/api/v1/health/ready`).then(async (response) => ({ response, body: await response.json().catch(() => ({})) })),
      (value) => value.response.ok && value.body.status === 'ready',
    );
  } catch (error) {
    await stopProcess(child);
    throw new Error(`${error.message}\nCollection logs:\n${logs}`);
  }
  return { child, url };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function requestWithHost(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

const e2eTest = process.env.UI_RATER_SKIP_E2E ? test.skip : test;

e2eTest('real Website, Collection, and Manager services publish, resume, and retire independently', async () => {
  const websiteModule = await import(pathToFileURL(path.join(root, 'services', 'website-server', 'src', 'server.ts')).href);
  const managerModule = await import(pathToFileURL(path.join(root, 'services', 'manager', 'src', 'server.ts')).href);
  const websiteData = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-real-website-'));
  const collectionData = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-real-collection-'));
  const managerData = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-real-manager-'));
  const collectionPort = await reservePort();
  let website;
  let manager;
  let collection;
  try {
    const websiteConfig = {
      dataDir: websiteData,
      port: 0,
      host: '127.0.0.1',
      runtimeSuffix: '.localhost',
      repoDir: root,
      serviceInstanceId: 'website_real_e2e',
    };
    website = await websiteModule.createWebsiteServer(websiteConfig);
    const websitePort = website.server.address().port;
    const websiteUrl = `http://127.0.0.1:${websitePort}`;
    collection = await startCollection(collectionPort, collectionData);
    const managerConfig = {
      dataDir: managerData,
      port: 0,
      host: '127.0.0.1',
      websiteUrl,
      collectionUrl: collection.url,
      requestTimeoutMs: 3_000,
      serviceInstanceId: 'manager_real_e2e',
    };
    manager = await managerModule.createManagerServer(managerConfig);
    const managerUrl = `http://127.0.0.1:${manager.server.address().port}`;
    const invalidStudy = await fetch(`${managerUrl}/api/v1/studies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:invalid-study' },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    assert.equal(invalidStudy.status, 400);
    assert.equal((await invalidStudy.json()).error.code, 'invalid_request');
    const invalidRevision = await fetch(`${collection.url}/api/v1/admin/study-revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:invalid-revision' },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    assert.equal(invalidRevision.status, 400);
    assert.equal((await invalidRevision.json()).error.code, 'invalid_request');
    const fixture = path.join(root, 'tests', 'fixtures', 'website-artifact');
    const job = await fetchJson(`${websiteUrl}/api/v1/artifact-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:artifact' },
      body: JSON.stringify({ kind: 'local', path: fixture }),
    });
    const resolved = await waitFor(
      () => fetchJson(`${websiteUrl}/api/v1/artifact-jobs/${job.operation.operationId}`),
      (value) => value.operation.status === 'succeeded',
    );
    const specification = {
      schemaVersion: 1,
      studyId: 'study_real_e2e',
      websiteSource: {
        kind: 'artifact',
        websiteArtifactId: resolved.operation.result.websiteArtifactId,
        websiteAcquisitionId: resolved.operation.result.websiteAcquisitionId,
      },
      taskSelector: { kind: 'positions', positions: [1, 3] },
    };
    const created = await fetchJson(`${managerUrl}/api/v1/studies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:study' },
      body: JSON.stringify(specification),
    });
    const publish = await fetchJson(`${managerUrl}/api/v1/studies/study_real_e2e/publish`, { method: 'POST' });
    const publication = await waitFor(
      () => fetchJson(`${managerUrl}/api/v1/publication-operations/${publish.operation.operationId}`),
      (value) => ['succeeded', 'failed_terminal'].includes(value.operation.status),
    );
    assert.equal(publication.operation.status, 'succeeded', publication.operation.error?.message);
    assert.equal(created.study.study_id, 'study_real_e2e');
    const revisionId = publication.operation.result.studyRevisionId;
    const deployment = await fetchJson(`${websiteUrl}/api/v1/deployments/${publication.operation.result.websiteDeploymentId}`);
    const target = await requestWithHost(websitePort, '/deep-route', `${deployment.deployment.routingLabel}.localhost:${websitePort}`);
    assert.equal(target.status, 200);
    assert.match(target.body, /Fixture/);

    // Manager can stop after publication; Collection owns the participant flow.
    await new Promise((resolve) => manager.server.close(resolve));
    manager = undefined;
    const firstRun = await fetchJson(`${collection.url}/api/v1/participants/P001/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:participant-run' },
      body: JSON.stringify({ studyRevisionId: revisionId }),
    });
    assert.equal(firstRun.tasks.length, 2);
    for (const task of firstRun.tasks) {
      const taskUrl = new URL(task.target_url);
      assert.equal(taskUrl.origin, new URL(deployment.deployment.baseUrl).origin);
      const taskPage = await requestWithHost(
        websitePort,
        `${taskUrl.pathname}${taskUrl.search}`,
        taskUrl.host,
      );
      assert.equal(taskPage.status, 200);
      assert.match(taskPage.body, /Fixture/);
    }
    const replayRun = await fetchJson(`${collection.url}/api/v1/participants/P001/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:participant-run' },
      body: JSON.stringify({ studyRevisionId: revisionId }),
    });
    assert.equal(replayRun.created, false);
    assert.equal(replayRun.runId, firstRun.runId);

    // Rebind the same Website data root and verify the deployment origin survives.
    await new Promise((resolve) => website.server.close(resolve));
    website = await websiteModule.createWebsiteServer(websiteConfig);
    const afterWebsiteRestart = await requestWithHost(websitePort, '/deep-route', `${deployment.deployment.routingLabel}.localhost:${websitePort}`);
    assert.equal(afterWebsiteRestart.status, 200);

    // Rebind Collection's data root and verify the run/capability resume path.
    await stopProcess(collection.child);
    collection = await startCollection(collectionPort, collectionData);
    const resumed = await fetchJson(`${collection.url}/api/v1/participants/P001/runs/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studyRevisionId: revisionId }),
    });
    assert.equal(resumed.runId, firstRun.runId);
    assert.equal(resumed.tasks.length, 2);

    // Restart Manager, then retire. An active run makes the first retirement
    // retryable; aborting it lets the same operation converge on retry.
    manager = await managerModule.createManagerServer(managerConfig);
    const managerUrlAfterRestart = `http://127.0.0.1:${manager.server.address().port}`;
    const status = await fetchJson(`${managerUrlAfterRestart}/api/v1/studies/study_real_e2e`);
    assert.equal(status.study.status, 'ready');
    const retire = await fetchJson(`${managerUrlAfterRestart}/api/v1/studies/study_real_e2e/retire`, { method: 'POST' });
    const waiting = await waitFor(
      () => fetchJson(`${managerUrlAfterRestart}/api/v1/publication-operations/${retire.operation.operationId}`),
      (value) => value.operation.status === 'failed_retryable',
    );
    assert.equal(waiting.operation.error.code, 'active_participant_runs');
    const replayAfterClose = await fetchJson(`${collection.url}/api/v1/participants/P001/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real:e2e:participant-run' },
      body: JSON.stringify({ studyRevisionId: revisionId }),
    });
    assert.equal(replayAfterClose.created, false);
    assert.equal(replayAfterClose.runId, firstRun.runId);
    await fetchJson(`${collection.url}/api/admin/runs/${encodeURIComponent(firstRun.runId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId: 'P001', status: 'aborted' }),
    });
    const retired = await fetchJson(`${managerUrlAfterRestart}/api/v1/studies/study_real_e2e/retire`, { method: 'POST' });
    const finalRetirement = await waitFor(
      () => fetchJson(`${managerUrlAfterRestart}/api/v1/publication-operations/${retired.operation.operationId}`),
      (value) => ['succeeded', 'failed_terminal'].includes(value.operation.status),
    );
    assert.equal(finalRetirement.operation.status, 'succeeded', finalRetirement.operation.error?.message);
    const released = await requestWithHost(websitePort, '/', `${deployment.deployment.routingLabel}.localhost:${websitePort}`);
    assert.equal(released.status, 410);
  } finally {
    await new Promise((resolve) => manager?.server?.close(resolve));
    await stopProcess(collection?.child);
    await new Promise((resolve) => website?.server?.close(resolve));
    await fs.rm(websiteData, { recursive: true, force: true });
    await fs.rm(collectionData, { recursive: true, force: true });
    await fs.rm(managerData, { recursive: true, force: true });
  }
});
