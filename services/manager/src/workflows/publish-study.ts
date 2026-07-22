import crypto from 'node:crypto';
import {
  requestDigest,
  validateStudySpecification,
  validateStudyRevision,
  type StudySpecification,
  type StudyRevisionDescriptor,
} from '@ui-rater/contracts';
import type { ManagerConfig } from '../config.ts';
import { CollectionClient } from '../clients/collection-client.ts';
import { ServiceClientError } from '../clients/http.ts';
import { WebsiteClient } from '../clients/website-client.ts';
import { makeStudyRevisionTasks } from '../domain/task-selection.ts';
import type { PublicationOperationRecord } from '../domain/publication-operation.ts';
import type { StudyRecord } from '../domain/study.ts';
import { OperationStore } from '../storage/operation-store.ts';
import { StudyStore } from '../storage/study-store.ts';
import { withLock } from '../storage/lock.ts';

export interface PublishRuntime {
  config: ManagerConfig;
  studies: StudyStore;
  operations: OperationStore;
  website: WebsiteClient;
  collection: CollectionClient;
}

function keyFor(operationId: string, name: string): string { return `manager:${operationId}:${name}`; }

function sourceRequest(specification: StudySpecification): Record<string, unknown> {
  const source = specification.websiteSource;
  if (source.kind === 'artifact') return { kind: 'artifact' };
  if (source.kind === 'huggingface') return {
    kind: 'huggingface', repoId: source.repoId, revision: source.revision,
    website: source.website, selector: source.selector, model: source.model,
  };
  throw new Error(`Unsupported Website source kind: ${source.kind}`);
}

async function reconcilePublishedStudy(
  runtime: PublishRuntime,
  operation: PublicationOperationRecord,
): Promise<void> {
  const study = await runtime.studies.get(operation.study_id);
  if (!study) throw new Error('study_not_found');
  if (study.publication_operation_id && study.publication_operation_id !== operation.operation_id) {
    throw new Error('publication_operation_conflict');
  }
  if (study.status === 'ready') return;
  if (study.status !== 'publishing') throw new Error(`published_study_state_conflict:${study.status}`);
  await runtime.studies.update(study, {
    status: 'ready', publication_operation_id: operation.operation_id,
    study_revision_id: operation.study_revision_id,
  });
}

async function reconcileFailedPublication(
  runtime: PublishRuntime,
  operation: PublicationOperationRecord,
): Promise<void> {
  const study = await runtime.studies.get(operation.study_id);
  if (!study) throw new Error('study_not_found');
  if (study.publication_operation_id && study.publication_operation_id !== operation.operation_id) {
    throw new Error('publication_operation_conflict');
  }
  const hasCommittedDownstreamState = Boolean(
    operation.deployment || operation.website_deployment_id || operation.registration,
  );
  if (study.status === 'draft') {
    if (hasCommittedDownstreamState) throw new Error('failed_publication_projection_regressed');
    return;
  }
  if (study.status !== 'publishing') throw new Error(`failed_publication_state_conflict:${study.status}`);
  // A deployment or Collection registration is forward-only. Keep the Study
  // publishing so an explicit retry can resume the same pinned operation.
  if (hasCommittedDownstreamState) return;
  await runtime.studies.update(study, { status: 'draft', publication_operation_id: operation.operation_id });
}

function assertArtifactAssociation(
  artifact: { websiteArtifactId: string; artifactDigest: string },
  acquisition: { websiteArtifactId: string; artifactDigest: string },
): void {
  if (artifact.websiteArtifactId !== acquisition.websiteArtifactId || artifact.artifactDigest !== acquisition.artifactDigest) {
    throw new Error('Website artifact/acquisition association mismatch');
  }
}

async function pinEndpoints(runtime: PublishRuntime, operation: PublicationOperationRecord): Promise<PublicationOperationRecord> {
  if (operation.website_endpoint.baseUrl.replace(/\/$/, '') !== runtime.config.websiteUrl.replace(/\/$/, '')) {
    throw new ServiceClientError({ code: 'website_endpoint_changed', message: 'Website Service URL changed during operation recovery', retryable: false }, 409, 'Website Service URL changed');
  }
  if (operation.collection_endpoint.baseUrl.replace(/\/$/, '') !== runtime.config.collectionUrl.replace(/\/$/, '')) {
    throw new ServiceClientError({ code: 'collection_endpoint_changed', message: 'Collection Service URL changed during operation recovery', retryable: false }, 409, 'Collection Service URL changed');
  }
  const [websiteReady, collectionReady] = await Promise.all([runtime.website.ready(), runtime.collection.ready()]);
  if (operation.website_endpoint.serviceInstanceId && operation.website_endpoint.serviceInstanceId !== websiteReady.serviceInstanceId) {
    throw new ServiceClientError({ code: 'website_service_identity_changed', message: 'Website Service identity changed during operation recovery', retryable: false }, 409, 'Website Service identity changed');
  }
  if (operation.collection_endpoint.serviceInstanceId && operation.collection_endpoint.serviceInstanceId !== collectionReady.serviceInstanceId) {
    throw new ServiceClientError({ code: 'collection_service_identity_changed', message: 'Collection Service identity changed during operation recovery', retryable: false }, 409, 'Collection Service identity changed');
  }
  return {
    ...operation,
    website_endpoint: { baseUrl: runtime.config.websiteUrl, serviceInstanceId: websiteReady.serviceInstanceId },
    collection_endpoint: { baseUrl: runtime.config.collectionUrl, serviceInstanceId: collectionReady.serviceInstanceId },
  };
}

export async function createPublishOperation(runtime: PublishRuntime, study: StudyRecord): Promise<PublicationOperationRecord> {
  return withLock(`study:${study.study_id}`, async () => {
    const currentStudy = await runtime.studies.get(study.study_id);
    if (!currentStudy) throw new Error('study_not_found');
    if (currentStudy.publication_operation_id) {
      const current = await runtime.operations.get(currentStudy.publication_operation_id);
      if (current) {
        if (current.status === 'failed_terminal') {
          await reconcileFailedPublication(runtime, current);
          const refreshedStudy = await runtime.studies.get(currentStudy.study_id);
          if (refreshedStudy?.status !== 'publishing') throw new Error('publication_operation_terminal');
          return runtime.operations.update(current, { status: 'running', error: undefined });
        }
        if (current.status === 'succeeded') await reconcilePublishedStudy(runtime, current);
        return current;
      }
    }
    if (currentStudy.status === 'retired') throw new Error('study_retired');
    const operationId = runtime.operations.operationIdFor('publish', currentStudy.study_id);
    const studyRevisionId = `str_${operationId.slice(4)}`;
    const operation = await runtime.operations.create({
      schema_version: 1,
      kind: 'publish',
      study_id: currentStudy.study_id,
      status: 'running',
      step: 'specification_frozen',
      specification_digest: currentStudy.specification_digest,
      specification: currentStudy.specification,
      website_endpoint: { baseUrl: runtime.config.websiteUrl },
      collection_endpoint: { baseUrl: runtime.config.collectionUrl },
      idempotency_keys: {
        artifact: keyFor(operationId, 'artifact'),
        deployment: keyFor(operationId, 'deployment'),
        collection: keyFor(operationId, 'collection'),
      },
      study_revision_id: studyRevisionId,
      remote_responses: {},
    }, operationId);
    await runtime.studies.update(currentStudy, {
      status: 'publishing', publication_operation_id: operation.operation_id,
      study_revision_id: operation.study_revision_id,
    });
    return operation;
  });
}

export async function runPublish(runtime: PublishRuntime, operationId: string): Promise<PublicationOperationRecord> {
  return withLock(`publish:${operationId}`, async () => {
    let operation = await runtime.operations.get(operationId);
    if (!operation) throw new Error('publication_operation_not_found');
    if (operation.status === 'succeeded') {
      await reconcilePublishedStudy(runtime, operation);
      return operation;
    }
    if (operation.status === 'failed_terminal') {
      await reconcileFailedPublication(runtime, operation);
      return operation;
    }
    let study = await runtime.studies.get(operation.study_id);
    if (!study) throw new Error('study_not_found');
    try {
      const specification = validateStudySpecification(operation.specification);
      if (requestDigest(specification) !== operation.specification_digest
        || specification.studyId !== operation.study_id
        || study.specification_digest !== operation.specification_digest) {
        throw new Error('frozen_specification_conflict');
      }
      if (study.publication_operation_id && study.publication_operation_id !== operation.operation_id) {
        throw new Error('publication_operation_conflict');
      }
      if (!study.publication_operation_id) {
        study = await runtime.studies.update(study, {
          status: 'publishing', publication_operation_id: operation.operation_id,
          study_revision_id: operation.study_revision_id,
        });
      }
      operation = await pinEndpoints(runtime, operation);
      await runtime.operations.update(operation, operation);

      let artifact = operation.artifact;
      let acquisition = operation.acquisition;
      if (!artifact || !acquisition) {
        const source = specification.websiteSource;
        if (source.kind === 'artifact') {
          if (!source.websiteArtifactId || !source.websiteAcquisitionId) throw new Error('artifact source IDs are required');
          artifact = await runtime.website.getArtifact(source.websiteArtifactId);
          acquisition = await runtime.website.getAcquisition(source.websiteAcquisitionId);
          if (artifact.websiteArtifactId !== source.websiteArtifactId || acquisition.websiteAcquisitionId !== source.websiteAcquisitionId) {
            throw new Error('artifact_source_mismatch');
          }
        } else {
          const remote = await runtime.website.resolveArtifact(sourceRequest(specification), operation.idempotency_keys.artifact);
          const ids = remote.result;
          if (!ids?.websiteArtifactId || !ids.websiteAcquisitionId) throw new Error('Website Service omitted artifact result');
          artifact = await runtime.website.getArtifact(ids.websiteArtifactId);
          acquisition = await runtime.website.getAcquisition(ids.websiteAcquisitionId);
        }
        assertArtifactAssociation(artifact, acquisition);
        operation = await runtime.operations.update(operation, {
          step: 'artifact_ready',
          website_artifact_id: artifact.websiteArtifactId,
          website_acquisition_id: acquisition.websiteAcquisitionId,
          artifact,
          acquisition,
        });
      }

      let deployment = operation.deployment;
      if (!deployment) {
        if (!operation.website_artifact_id) throw new Error('Artifact must be ready before deployment');
        deployment = await runtime.website.createDeployment(operation.website_artifact_id, operation.idempotency_keys.deployment);
        if (deployment.websiteArtifactId !== operation.website_artifact_id || deployment.artifactDigest !== artifact.artifactDigest) {
          throw new Error('Website deployment is bound to a different artifact');
        }
        operation = await runtime.operations.update(operation, {
          step: 'deployment_ready',
          website_deployment_id: deployment.websiteDeploymentId,
          deployment,
        });
      }

      let revision = operation.revision;
      if (!revision) {
        if (!operation.study_revision_id || !artifact || !acquisition || !deployment) throw new Error('Publication inputs are incomplete');
        const generated: StudyRevisionDescriptor = validateStudyRevision({
          schemaVersion: 1,
          studyId: study.study_id,
          studyRevisionId: operation.study_revision_id,
          website: {
            websiteDeploymentId: deployment.websiteDeploymentId,
            websiteArtifactId: artifact.websiteArtifactId,
            websiteAcquisitionId: acquisition.websiteAcquisitionId,
            artifactDigest: artifact.artifactDigest,
            baseUrl: deployment.baseUrl,
            provenance: acquisition.source,
          },
          tasks: makeStudyRevisionTasks(artifact.tasks, specification.taskSelector, deployment.baseUrl),
          publishedAt: new Date().toISOString(),
        });
        revision = generated;
        operation = await runtime.operations.update(operation, {
          step: 'revision_prepared', revision, study_revision_digest: requestDigest(revision),
        });
      }

      if (!operation.registration) {
        const registration = await runtime.collection.registerRevision(revision, operation.idempotency_keys.collection);
        operation = await runtime.operations.update(operation, { step: 'collection_registered', registration });
      }
      operation = await runtime.operations.update(operation, { status: 'succeeded', step: 'succeeded' });
      await reconcilePublishedStudy(runtime, operation);
      return operation;
    } catch (error: unknown) {
      // Only downstream transport/service errors are safe to retry. Invalid
      // source IDs, digest mismatches, and contract violations are terminal
      // until an operator changes the Study Specification.
      const retryable = error instanceof ServiceClientError
        ? error.retryable || ['http_401', 'http_403'].includes(error.code)
        : false;
      const next = await runtime.operations.update(operation, {
        status: retryable ? 'failed_retryable' : 'failed_terminal',
        step: retryable ? 'failed_retryable' : 'failed_terminal',
        error: {
          code: error instanceof ServiceClientError ? error.code : 'publication_failed',
          message: error instanceof Error ? error.message : 'Publication failed',
          retryable,
          details: error instanceof ServiceClientError ? error.details : undefined,
        },
      });
      if (!retryable) await reconcileFailedPublication(runtime, next);
      return next;
    }
  });
}

export function startPublish(runtime: PublishRuntime, operation: PublicationOperationRecord): void {
  void runPublish(runtime, operation.operation_id).catch(() => {});
}
