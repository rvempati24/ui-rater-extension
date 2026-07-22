const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function jsonBody(request) {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  return raw ? JSON.parse(raw) : {};
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function startCollectionContractStub() {
  const revisions = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/v1/health/ready') {
        send(response, 200, { status: 'ready', service: 'collection', serviceInstanceId: 'collection_e2e' });
        return;
      }
      const match = url.pathname.match(/^\/api\/v1\/admin\/study-revisions(?:\/([^/]+))?(?:\/(summary|close|retire))?$/);
      if (request.method === 'POST' && url.pathname === '/api/v1/admin/study-revisions') {
        const revision = await jsonBody(request);
        const id = revision.studyRevisionId;
        const digest = (await import('@ui-rater/contracts')).requestDigest(revision);
        const existing = revisions.get(id);
        if (existing && existing.registration.revisionDigest !== digest) {
          send(response, 409, { error: { code: 'study_revision_conflict', message: 'conflict', retryable: false } });
          return;
        }
        const registration = existing?.registration || { studyRevisionId: id, revisionDigest: digest, admission: 'accepting' };
        revisions.set(id, { revision, registration });
        send(response, existing ? 200 : 201, { registration });
        return;
      }
      if (match?.[1]) {
        const id = decodeURIComponent(match[1]);
        const current = revisions.get(id);
        if (!current) { send(response, 404, { error: { code: 'study_revision_not_found', message: 'not found', retryable: false } }); return; }
        if (request.method === 'GET' && match[2] === 'summary') {
          send(response, 200, { registration: current.registration, runCounts: { active: 0, completed: 0, aborted: 0, total: 0 } });
          return;
        }
        if (request.method === 'POST' && (match[2] === 'close' || match[2] === 'retire')) {
          current.registration = { ...current.registration, admission: match[2] === 'close' ? 'closed' : 'retired' };
          send(response, 200, { registration: current.registration });
          return;
        }
      }
      send(response, 404, { error: { code: 'route_not_found', message: 'not found', retryable: false } });
    } catch (error) {
      send(response, 500, { error: { code: 'stub_error', message: error.message, retryable: false } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, revisions, port: server.address().port };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function requestWithHost(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function poll(fetchValue, done, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fetchValue();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for service operation');
}

const e2eTest = process.env.UI_RATER_SKIP_E2E ? test.skip : test;

e2eTest('Website + Manager publish through an independent Collection contract', async () => {
  const contracts = await import('@ui-rater/contracts');
  const websiteModule = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'website-server', 'src', 'server.ts')).href);
  const managerModule = await import(pathToFileURL(path.join(__dirname, '..', 'services', 'manager', 'src', 'server.ts')).href);
  const websiteData = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-e2e-website-'));
  const managerData = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-e2e-manager-'));
  const collection = await startCollectionContractStub();
  let website;
  let manager;
  try {
    website = await websiteModule.createWebsiteServer({
      dataDir: websiteData,
      port: 0,
      host: '127.0.0.1',
      runtimeSuffix: '.localhost',
      repoDir: path.join(__dirname, '..'),
      serviceInstanceId: 'website_e2e',
    });
    const websitePort = website.server.address().port;
    const websiteUrl = `http://127.0.0.1:${websitePort}`;
    manager = await managerModule.createManagerServer({
      dataDir: managerData,
      port: 0,
      host: '127.0.0.1',
      websiteUrl,
      collectionUrl: `http://127.0.0.1:${collection.port}`,
      requestTimeoutMs: 2_000,
      serviceInstanceId: 'manager_e2e',
    });
    const managerPort = manager.server.address().port;
    const fixture = path.join(__dirname, 'fixtures', 'website-artifact');
    const jobResponse = await fetch(`${websiteUrl}/api/v1/artifact-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e:artifact' },
      body: JSON.stringify({ kind: 'local', path: fixture }),
    });
    assert.equal(jobResponse.status, 202);
    const job = await jobResponse.json();
    const operation = await poll(
      async () => (await fetch(`${websiteUrl}/api/v1/artifact-jobs/${job.operation.operationId}`)).json(),
      (value) => value.operation.status === 'succeeded',
    );
    const spec = {
      schemaVersion: 1,
      studyId: 'study_e2e',
      websiteSource: {
        kind: 'artifact',
        websiteArtifactId: operation.operation.result.websiteArtifactId,
        websiteAcquisitionId: operation.operation.result.websiteAcquisitionId,
      },
      taskSelector: { kind: 'positions', positions: [1, 3] },
    };
    const createResponse = await fetch(`http://127.0.0.1:${managerPort}/api/v1/studies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e:study' },
      body: JSON.stringify(spec),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const publishResponse = await fetch(`http://127.0.0.1:${managerPort}/api/v1/studies/study_e2e/publish`, { method: 'POST' });
    assert.equal(publishResponse.status, 202);
    const publishBody = await publishResponse.json();
    const publicationOperationId = publishBody.operation.operationId;
    const published = await poll(
      async () => (await fetch(`http://127.0.0.1:${managerPort}/api/v1/publication-operations/${publicationOperationId}`)).json(),
      (value) => value.operation?.status === 'succeeded',
    );
    assert.match(published.operation.result.studyRevisionId, /^str_/);
    const revision = collection.revisions.get(published.operation.result.studyRevisionId).revision;
    assert.deepEqual(revision.tasks.map((task) => task.sourcePosition), [1, 3]);
    const deployment = published.operation.result.websiteDeploymentId;
    const deploymentResponse = await fetch(`${websiteUrl}/api/v1/deployments/${deployment}`);
    const deploymentBody = await deploymentResponse.json();
    const staticResponse = await requestWithHost(websitePort, '/deep-route', `${deploymentBody.deployment.routingLabel}.localhost:${websitePort}`);
    assert.equal(staticResponse.status, 200);
    assert.match(staticResponse.body, /Fixture/);
  } finally {
    await closeServer(manager?.server);
    await closeServer(website?.server);
    await closeServer(collection.server);
    await fs.rm(websiteData, { recursive: true, force: true });
    await fs.rm(managerData, { recursive: true, force: true });
  }
});
