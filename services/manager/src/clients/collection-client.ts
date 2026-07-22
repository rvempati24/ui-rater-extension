import { requestDigest, validateCollectionRegistration, type CollectionStudyRegistration, type StudyRevisionDescriptor } from '@ui-rater/contracts';
import { requestJson, ServiceClientError } from './http.ts';

export interface CollectionSummary {
  registration: CollectionStudyRegistration;
  runCounts: { active: number; completed: number; aborted: number; total: number };
}

function invalidResponse(message: string): never {
  throw new ServiceClientError({ code: 'invalid_collection_response', message, retryable: true }, 502, message);
}

function validateReady(value: unknown): { serviceInstanceId: string } {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : invalidResponse('Collection readiness response must be an object');
  if (typeof row.serviceInstanceId !== 'string' || !row.serviceInstanceId) invalidResponse('Collection readiness response omitted serviceInstanceId');
  return { serviceInstanceId: row.serviceInstanceId as string };
}

function validateSummary(value: unknown, revisionId: string): CollectionSummary {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : invalidResponse('Collection summary response must be an object');
  let registration: CollectionStudyRegistration;
  try { registration = validateCollectionRegistration(row.registration); }
  catch (error: unknown) { invalidResponse(error instanceof Error ? error.message : 'Invalid Collection registration'); }
  if (registration!.studyRevisionId !== revisionId) invalidResponse('Collection summary returned a different Study Revision');
  const rawCounts = row.runCounts;
  if (!rawCounts || typeof rawCounts !== 'object' || Array.isArray(rawCounts)) invalidResponse('Collection summary omitted runCounts');
  const counts = rawCounts as Record<string, unknown>;
  for (const name of ['active', 'completed', 'aborted', 'total']) {
    if (!Number.isInteger(counts[name]) || Number(counts[name]) < 0) invalidResponse(`Collection runCounts.${name} must be a nonnegative integer`);
  }
  if (Number(counts.total) < Number(counts.active) + Number(counts.completed) + Number(counts.aborted)) {
    invalidResponse('Collection runCounts.total is inconsistent');
  }
  return {
    registration: registration!,
    runCounts: {
      active: Number(counts.active), completed: Number(counts.completed),
      aborted: Number(counts.aborted), total: Number(counts.total),
    },
  };
}

function validateRegistrationFor(value: unknown, revisionId: string, revisionDigest?: string): CollectionStudyRegistration {
  let registration: CollectionStudyRegistration;
  try { registration = validateCollectionRegistration(value); }
  catch (error: unknown) { invalidResponse(error instanceof Error ? error.message : 'Invalid Collection registration'); }
  if (registration!.studyRevisionId !== revisionId) invalidResponse('Collection returned a different Study Revision');
  if (revisionDigest && registration!.revisionDigest !== revisionDigest) invalidResponse('Collection returned a different Study Revision digest');
  return registration!;
}

export class CollectionClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number, private readonly adminToken?: string) {}
  private adminHeaders(): HeadersInit {
    return this.adminToken ? { Authorization: `Bearer ${this.adminToken}` } : {};
  }
  async ready(): Promise<{ serviceInstanceId: string }> {
    return validateReady(await requestJson<unknown>(this.baseUrl, '/api/v1/health/ready', {}, this.timeoutMs));
  }
  async registerRevision(revision: StudyRevisionDescriptor, key: string): Promise<CollectionStudyRegistration> {
    const body = await requestJson<{ registration: unknown }>(this.baseUrl, '/api/v1/admin/study-revisions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...this.adminHeaders() }, body: JSON.stringify(revision),
    }, this.timeoutMs);
    return validateRegistrationFor(body.registration, revision.studyRevisionId, requestDigest(revision));
  }
  async summary(revisionId: string): Promise<CollectionSummary> {
    return validateSummary(
      await requestJson<unknown>(this.baseUrl, `/api/v1/admin/study-revisions/${encodeURIComponent(revisionId)}/summary`, { headers: this.adminHeaders() }, this.timeoutMs),
      revisionId,
    );
  }
  async closeRevision(revisionId: string): Promise<CollectionStudyRegistration> {
    const body = await requestJson<{ registration: unknown }>(this.baseUrl, `/api/v1/admin/study-revisions/${encodeURIComponent(revisionId)}/close`, { method: 'POST', headers: this.adminHeaders() }, this.timeoutMs);
    return validateRegistrationFor(body.registration, revisionId);
  }
  async retireRevision(revisionId: string): Promise<CollectionStudyRegistration> {
    const body = await requestJson<{ registration: unknown }>(this.baseUrl, `/api/v1/admin/study-revisions/${encodeURIComponent(revisionId)}/retire`, { method: 'POST', headers: this.adminHeaders() }, this.timeoutMs);
    return validateRegistrationFor(body.registration, revisionId);
  }
}
