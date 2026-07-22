import {
  validateWebsiteAcquisition, validateWebsiteArtifact, validateWebsiteDeployment,
  type WebsiteAcquisitionDescriptor, type WebsiteArtifactDescriptor, type WebsiteDeploymentDescriptor,
} from '@ui-rater/contracts';
import { requestJson, ServiceClientError, type HttpErrorShape } from './http.ts';

export interface WebsiteOperation {
  operationId: string;
  status: 'queued' | 'running' | 'failed_retryable' | 'failed_terminal' | 'succeeded';
  step: string;
  result?: { websiteArtifactId?: string; websiteAcquisitionId?: string };
  error?: HttpErrorShape | null;
}

function invalidResponse(message: string): never {
  throw new ServiceClientError({ code: 'invalid_website_response', message, retryable: true }, 502, message);
}

function validateReady(value: unknown): { serviceInstanceId: string } {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : invalidResponse('Website readiness response must be an object');
  if (typeof row.serviceInstanceId !== 'string' || !row.serviceInstanceId) invalidResponse('Website readiness response omitted serviceInstanceId');
  return { serviceInstanceId: row.serviceInstanceId as string };
}

function validateOperationEnvelope(value: unknown): WebsiteOperation {
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : invalidResponse('Website operation response must be an object');
  const operation = envelope.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) invalidResponse('Website operation response omitted operation');
  const row = operation as Record<string, unknown>;
  const statuses = ['queued', 'running', 'failed_retryable', 'failed_terminal', 'succeeded'];
  if (typeof row.operationId !== 'string' || !row.operationId) invalidResponse('Website operation omitted operationId');
  if (!statuses.includes(String(row.status))) invalidResponse('Website operation returned an invalid status');
  if (typeof row.step !== 'string' || !row.step) invalidResponse('Website operation omitted step');
  if (row.result !== undefined && (!row.result || typeof row.result !== 'object' || Array.isArray(row.result))) invalidResponse('Website operation result must be an object');
  if (row.error !== undefined && row.error !== null && (typeof row.error !== 'object' || Array.isArray(row.error))) invalidResponse('Website operation error must be an object');
  return row as unknown as WebsiteOperation;
}

export class WebsiteClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}
  async ready(): Promise<{ serviceInstanceId: string }> {
    return validateReady(await requestJson<unknown>(this.baseUrl, '/api/v1/health/ready', {}, this.timeoutMs));
  }
  async artifactJob(source: Record<string, unknown>, key: string): Promise<WebsiteOperation> {
    const result = await requestJson<unknown>(this.baseUrl, '/api/v1/artifact-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(source),
    }, this.timeoutMs);
    return validateOperationEnvelope(result);
  }
  async getOperation(operationId: string): Promise<WebsiteOperation> {
    return validateOperationEnvelope(await requestJson<unknown>(this.baseUrl, `/api/v1/artifact-jobs/${encodeURIComponent(operationId)}`, {}, this.timeoutMs));
  }
  async retryOperation(operationId: string): Promise<WebsiteOperation> {
    return validateOperationEnvelope(await requestJson<unknown>(this.baseUrl, `/api/v1/artifact-jobs/${encodeURIComponent(operationId)}/retry`, { method: 'POST' }, this.timeoutMs));
  }
  async resolveArtifact(source: Record<string, unknown>, key: string, waitMs = 200): Promise<WebsiteOperation> {
    let operation = await this.artifactJob(source, key);
    let retried = false;
    if (operation.status === 'failed_retryable') {
      operation = await this.retryOperation(operation.operationId);
      retried = true;
    }
    while (!['succeeded', 'failed_retryable', 'failed_terminal'].includes(operation.status)) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      operation = await this.getOperation(operation.operationId);
      if (operation.status === 'failed_retryable' && !retried) {
        operation = await this.retryOperation(operation.operationId);
        retried = true;
      }
    }
    if (operation.status !== 'succeeded') {
      throw new ServiceClientError(
        operation.error,
        operation.status === 'failed_retryable' ? 503 : 400,
        'Website artifact resolution failed',
      );
    }
    return operation;
  }
  async getArtifact(id: string): Promise<WebsiteArtifactDescriptor> {
    const body = await requestJson<{ artifact: unknown }>(this.baseUrl, `/api/v1/artifacts/${encodeURIComponent(id)}`, {}, this.timeoutMs);
    return validateWebsiteArtifact(body.artifact);
  }
  async getAcquisition(id: string): Promise<WebsiteAcquisitionDescriptor> {
    const body = await requestJson<{ acquisition: unknown }>(this.baseUrl, `/api/v1/acquisitions/${encodeURIComponent(id)}`, {}, this.timeoutMs);
    return validateWebsiteAcquisition(body.acquisition);
  }
  async createDeployment(artifactId: string, key: string): Promise<WebsiteDeploymentDescriptor> {
    const body = await requestJson<{ deployment: unknown }>(this.baseUrl, '/api/v1/deployments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ websiteArtifactId: artifactId }),
    }, this.timeoutMs);
    return validateWebsiteDeployment(body.deployment);
  }
  async getDeployment(id: string): Promise<WebsiteDeploymentDescriptor> {
    const body = await requestJson<{ deployment: unknown }>(this.baseUrl, `/api/v1/deployments/${encodeURIComponent(id)}`, {}, this.timeoutMs);
    return validateWebsiteDeployment(body.deployment);
  }
  async releaseDeployment(id: string): Promise<void> {
    await requestJson<unknown>(this.baseUrl, `/api/v1/deployments/${encodeURIComponent(id)}`, { method: 'DELETE' }, this.timeoutMs);
  }
}
