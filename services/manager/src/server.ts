import http from 'node:http';
import { ContractError, errorEnvelope, validateStudySpecification } from '@ui-rater/contracts';
import { loadConfig, type ManagerConfig } from './config.ts';
import { CollectionClient } from './clients/collection-client.ts';
import { WebsiteClient } from './clients/website-client.ts';
import { operationView } from './domain/publication-operation.ts';
import { createPublishOperation, runPublish, startPublish, type PublishRuntime } from './workflows/publish-study.ts';
import { createRetirementOperation, runRetirement, startRetirement, type RetirementRuntime } from './workflows/retire-study.ts';
import { OperationStore } from './storage/operation-store.ts';
import { StudyStore } from './storage/study-store.ts';
import { readJson, ensureDir } from './storage/json-store.ts';
import { withLock } from './storage/lock.ts';
import type { PublicationOperationRecord } from './domain/publication-operation.ts';
import type { StudyRecord } from './domain/study.ts';

export interface ManagerRuntime extends PublishRuntime, RetirementRuntime {
  config: ManagerConfig;
}

function statusFor(error: unknown): number {
  const code = (error as { code?: string }).code || (error instanceof Error ? error.message : '');
  if (code.endsWith('_not_found')) return 404;
  if (code.includes('conflict') || code.includes('idempotency') || code.includes('active_participant') || code.includes('not_ready') || code.includes('retired') || code.includes('terminal')) return 409;
  if (code.includes('invalid') || code.includes('required')) return 400;
  return 500;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 2 * 1024 * 1024) throw new Error('request_too_large');
  }
  if (!raw.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new ContractError('invalid_json', 'Request body is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid_json', 'JSON body must be an object');
  return value as Record<string, unknown>;
}

async function recover(runtime: ManagerRuntime): Promise<void> {
  for (const operation of await runtime.operations.list()) {
    if (!['running', 'failed_retryable', 'failed_terminal', 'succeeded'].includes(operation.status)) continue;
    if (operation.status === 'succeeded' || operation.status === 'failed_terminal') {
      if (operation.kind === 'publish') await runPublish(runtime, operation.operation_id);
      else await runRetirement(runtime, operation.operation_id);
      continue;
    }
    if (operation.kind === 'publish') startPublish(runtime, operation);
    else startRetirement(runtime, operation);
  }
}

async function routeApi(runtime: ManagerRuntime, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method || 'GET';
  if (method === 'GET' && url.pathname === '/api/v1/health/live') {
    sendJson(response, 200, { status: 'live', service: 'manager', serviceInstanceId: runtime.config.serviceInstanceId });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/v1/health/ready') {
    await Promise.all([runtime.website.ready(), runtime.collection.ready()]);
    sendJson(response, 200, {
      status: 'ready', service: 'manager', serviceInstanceId: runtime.config.serviceInstanceId,
      websiteUrl: runtime.config.websiteUrl, collectionUrl: runtime.config.collectionUrl,
    });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/v1/studies') {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) throw new Error('missing_idempotency_key');
    const body = await readBody(request);
    let spec;
    try { spec = validateStudySpecification(body); }
    catch (error: unknown) {
      throw new ContractError('invalid_request', error instanceof Error ? error.message : 'Invalid Study Specification');
    }
    const created = await runtime.studies.create(spec, key);
    sendJson(response, created.created ? 201 : 200, { study: created.study });
    return;
  }
  if (parts[0] !== 'api' || parts[1] !== 'v1') throw new Error('route_not_found');
  if (parts[2] === 'studies' && parts[3]) {
    const study = await runtime.studies.get(parts[3]);
    if (!study) throw new Error('study_not_found');
    if (method === 'GET' && parts.length === 4) { sendJson(response, 200, { study }); return; }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'publish') {
      const operation = await createPublishOperation(runtime, study);
      startPublish(runtime, operation);
      sendJson(response, operation.status === 'succeeded' ? 200 : 202, { operation: operationView(operation) });
      return;
    }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'retire') {
      const operation = await createRetirementOperation(runtime, study);
      startRetirement(runtime, operation);
      sendJson(response, operation.status === 'succeeded' ? 200 : 202, { operation: operationView(operation) });
      return;
    }
  }
  if (parts[2] === 'publication-operations' && parts[3] && method === 'GET') {
    const operation = await runtime.operations.get(parts[3]);
    if (!operation) throw new Error('publication_operation_not_found');
    sendJson(response, 200, { operation: operationView(operation) });
    return;
  }
  throw new Error('route_not_found');
}

export async function createManagerServer(inputConfig?: ManagerConfig) {
  const config = inputConfig || await loadConfig();
  await ensureDir(config.dataDir);
  const studies = new StudyStore(config.dataDir);
  const operations = new OperationStore(config.dataDir);
  await Promise.all([studies.init(), operations.init()]);
  const runtime: ManagerRuntime = {
    config,
    studies,
    operations,
    website: new WebsiteClient(config.websiteUrl, config.requestTimeoutMs),
    collection: new CollectionClient(config.collectionUrl, config.requestTimeoutMs, config.collectionAdminToken),
  };
  const server = http.createServer(async (request, response) => {
    try {
      const host = String(request.headers.host || '').toLowerCase();
      if (!(host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost')) {
        sendJson(response, 404, { error: { code: 'unknown_origin', message: 'Manager control API is loopback-only', retryable: false } });
        return;
      }
      await routeApi(runtime, request, response, new URL(request.url || '/', `http://${host || '127.0.0.1'}`));
    } catch (error: unknown) {
      sendJson(response, statusFor(error), errorEnvelope(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  await recover(runtime);
  return { server, runtime };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runtime } = await createManagerServer();
  console.log(`Manager Service listening on http://${runtime.config.host}:${runtime.config.port}`);
}
