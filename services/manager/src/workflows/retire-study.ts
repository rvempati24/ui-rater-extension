import type { ManagerConfig } from '../config.ts';
import { CollectionClient } from '../clients/collection-client.ts';
import type { PublicationOperationRecord } from '../domain/publication-operation.ts';
import type { StudyRecord } from '../domain/study.ts';
import { OperationStore } from '../storage/operation-store.ts';
import { StudyStore } from '../storage/study-store.ts';
import { WebsiteClient } from '../clients/website-client.ts';
import { ServiceClientError } from '../clients/http.ts';
import { withLock } from '../storage/lock.ts';

export interface RetirementRuntime {
  config: ManagerConfig;
  studies: StudyStore;
  operations: OperationStore;
  website: WebsiteClient;
  collection: CollectionClient;
}

async function reconcileRetiredStudy(
  runtime: RetirementRuntime,
  operation: PublicationOperationRecord,
): Promise<void> {
  const study = await runtime.studies.get(operation.study_id);
  if (!study) throw new Error('study_not_found');
  if (study.retirement_operation_id && study.retirement_operation_id !== operation.operation_id) {
    throw new Error('retirement_operation_conflict');
  }
  if (study.status === 'retired') return;
  if (study.status !== 'retiring') throw new Error(`retired_study_state_conflict:${study.status}`);
  await runtime.studies.update(study, { status: 'retired', retirement_operation_id: operation.operation_id });
}

async function reconcileFailedRetirement(
  runtime: RetirementRuntime,
  operation: PublicationOperationRecord,
): Promise<void> {
  const study = await runtime.studies.get(operation.study_id);
  if (!study) throw new Error('study_not_found');
  if (study.retirement_operation_id && study.retirement_operation_id !== operation.operation_id) {
    throw new Error('retirement_operation_conflict');
  }
  if (study.status === 'ready') {
    await runtime.studies.update(study, { status: 'retiring', retirement_operation_id: operation.operation_id });
    return;
  }
  if (study.status !== 'retiring') throw new Error(`failed_retirement_state_conflict:${study.status}`);
  // Once retirement starts, remote admission may already be closed even when
  // the response was not persisted. Never project the Study backward.
}

async function pinRetirementEndpoints(
  runtime: RetirementRuntime,
  operation: PublicationOperationRecord,
): Promise<PublicationOperationRecord> {
  if (operation.website_endpoint.baseUrl.replace(/\/$/, '') !== runtime.config.websiteUrl.replace(/\/$/, '')) {
    throw new ServiceClientError({ code: 'website_endpoint_changed', message: 'Website Service URL changed during retirement recovery', retryable: false }, 409, 'Website Service URL changed');
  }
  if (operation.collection_endpoint.baseUrl.replace(/\/$/, '') !== runtime.config.collectionUrl.replace(/\/$/, '')) {
    throw new ServiceClientError({ code: 'collection_endpoint_changed', message: 'Collection Service URL changed during retirement recovery', retryable: false }, 409, 'Collection Service URL changed');
  }
  const [websiteReady, collectionReady] = await Promise.all([runtime.website.ready(), runtime.collection.ready()]);
  if (operation.website_endpoint.serviceInstanceId
    && operation.website_endpoint.serviceInstanceId !== websiteReady.serviceInstanceId) {
    throw new ServiceClientError({ code: 'website_service_identity_changed', message: 'Website Service identity changed during retirement recovery', retryable: false }, 409, 'Website Service identity changed');
  }
  if (operation.collection_endpoint.serviceInstanceId
    && operation.collection_endpoint.serviceInstanceId !== collectionReady.serviceInstanceId) {
    throw new ServiceClientError({ code: 'collection_service_identity_changed', message: 'Collection Service identity changed during retirement recovery', retryable: false }, 409, 'Collection Service identity changed');
  }
  return {
    ...operation,
    website_endpoint: { ...operation.website_endpoint, serviceInstanceId: websiteReady.serviceInstanceId },
    collection_endpoint: { ...operation.collection_endpoint, serviceInstanceId: collectionReady.serviceInstanceId },
  };
}

export async function createRetirementOperation(runtime: RetirementRuntime, study: StudyRecord): Promise<PublicationOperationRecord> {
  return withLock(`study:${study.study_id}`, async () => {
    const currentStudy = await runtime.studies.get(study.study_id);
    if (!currentStudy) throw new Error('study_not_found');
    if (currentStudy.retirement_operation_id) {
      const current = await runtime.operations.get(currentStudy.retirement_operation_id);
      if (current) {
        if (current.status === 'succeeded') await reconcileRetiredStudy(runtime, current);
        if (current.status === 'failed_terminal') {
          await reconcileFailedRetirement(runtime, current);
          const refreshedStudy = await runtime.studies.get(currentStudy.study_id);
          if (!refreshedStudy || !['ready', 'retiring'].includes(refreshedStudy.status)) return current;
          return runtime.operations.update(current, { status: 'running', error: undefined });
        }
        return current;
      }
    }
    if (currentStudy.status !== 'ready' && currentStudy.status !== 'retiring') throw new Error('study_not_ready');
    if (!currentStudy.publication_operation_id) throw new Error('study_has_no_publication');
    const publication = await runtime.operations.get(currentStudy.publication_operation_id);
    if (!publication?.study_revision_id || !publication.website_deployment_id) throw new Error('publication_result_incomplete');
    const operationId = runtime.operations.operationIdFor('retire', currentStudy.study_id);
    const operation = await runtime.operations.create({
      schema_version: 1, kind: 'retire', study_id: currentStudy.study_id, status: 'running', step: 'specification_frozen',
      specification_digest: currentStudy.specification_digest, specification: currentStudy.specification,
      website_endpoint: publication.website_endpoint,
      collection_endpoint: publication.collection_endpoint,
      idempotency_keys: {}, study_revision_id: publication.study_revision_id,
      website_deployment_id: publication.website_deployment_id,
      registration: publication.registration, remote_responses: {},
    }, operationId);
    await runtime.studies.update(currentStudy, { status: 'retiring', retirement_operation_id: operation.operation_id });
    return operation;
  });
}

export async function runRetirement(runtime: RetirementRuntime, operationId: string): Promise<PublicationOperationRecord> {
  return withLock(`retire:${operationId}`, async () => {
    let operation = await runtime.operations.get(operationId);
    if (!operation) throw new Error('retirement_operation_not_found');
    if (operation.status === 'succeeded') {
      await reconcileRetiredStudy(runtime, operation);
      return operation;
    }
    if (operation.status === 'failed_terminal') {
      await reconcileFailedRetirement(runtime, operation);
      return operation;
    }
    let study = await runtime.studies.get(operation.study_id);
    if (!study || !operation.study_revision_id || !operation.website_deployment_id) throw new Error('retirement_inputs_incomplete');
    const revisionId = operation.study_revision_id;
    const deploymentId = operation.website_deployment_id;
    try {
      if (study.retirement_operation_id && study.retirement_operation_id !== operation.operation_id) {
        throw new Error('retirement_operation_conflict');
      }
      if (!study.retirement_operation_id) {
        study = await runtime.studies.update(study, {
          status: 'retiring', retirement_operation_id: operation.operation_id,
        });
      }
      operation = await pinRetirementEndpoints(runtime, operation);
      operation = await runtime.operations.update(operation, operation);
      if (!operation.registration || operation.registration.admission === 'accepting') {
        const registration = await runtime.collection.closeRevision(revisionId);
        operation = await runtime.operations.update(operation, { step: 'artifact_ready', registration });
      }
      const summary = await runtime.collection.summary(revisionId);
      if (!operation.registration
        || summary.registration.revisionDigest !== operation.registration.revisionDigest
        || summary.registration.admission === 'accepting') {
        throw new ServiceClientError({
          code: 'collection_summary_conflict',
          message: 'Collection summary does not match the closed Study Revision',
          retryable: false,
        }, 409, 'Collection summary conflict');
      }
      if (summary.runCounts.active > 0) {
        const next = await runtime.operations.update(operation, {
          status: 'failed_retryable',
          step: 'failed_retryable',
          error: { code: 'active_participant_runs', message: 'Study has active participant runs', retryable: true, details: summary.runCounts },
        });
        return next;
      }
      await runtime.website.releaseDeployment(deploymentId);
      operation = await runtime.operations.update(operation, { step: 'deployment_ready' });
      const registration = await runtime.collection.retireRevision(revisionId);
      operation = await runtime.operations.update(operation, { step: 'collection_registered', registration, status: 'succeeded' });
      await reconcileRetiredStudy(runtime, operation);
      return operation;
    } catch (error: unknown) {
      const retryable = error instanceof ServiceClientError
        ? error.retryable || ['http_401', 'http_403'].includes(error.code)
        : (error as { retryable?: boolean }).retryable !== false;
      const next = await runtime.operations.update(operation, {
        status: retryable ? 'failed_retryable' : 'failed_terminal', step: retryable ? 'failed_retryable' : 'failed_terminal',
        error: {
          code: error instanceof ServiceClientError ? error.code : 'retirement_failed',
          message: error instanceof Error ? error.message : 'Retirement failed', retryable,
          details: error instanceof ServiceClientError ? error.details : undefined,
        },
      });
      if (!retryable) await reconcileFailedRetirement(runtime, next);
      return next;
    }
  });
}

export function startRetirement(runtime: RetirementRuntime, operation: PublicationOperationRecord): void {
  void runRetirement(runtime, operation.operation_id).catch(() => {});
}
