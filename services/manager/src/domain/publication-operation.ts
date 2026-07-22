import type { CollectionStudyRegistration, PublicationStep, StudyRevisionDescriptor, StudyStatus, WebsiteArtifactDescriptor, WebsiteAcquisitionDescriptor, WebsiteDeploymentDescriptor } from '@ui-rater/contracts';

export type ManagerOperationKind = 'publish' | 'retire';
export type ManagerOperationStatus = 'running' | 'failed_retryable' | 'failed_terminal' | 'succeeded';

export interface PublicationOperationRecord {
  schema_version: 1;
  operation_id: string;
  kind: ManagerOperationKind;
  study_id: string;
  status: ManagerOperationStatus;
  step: PublicationStep;
  specification_digest: string;
  specification: unknown;
  website_endpoint: { baseUrl: string; serviceInstanceId?: string };
  collection_endpoint: { baseUrl: string; serviceInstanceId?: string };
  idempotency_keys: Record<string, string>;
  website_artifact_id?: string;
  website_acquisition_id?: string;
  website_deployment_id?: string;
  study_revision_id?: string;
  study_revision_digest?: string;
  revision?: StudyRevisionDescriptor;
  artifact?: WebsiteArtifactDescriptor;
  acquisition?: WebsiteAcquisitionDescriptor;
  deployment?: WebsiteDeploymentDescriptor;
  registration?: CollectionStudyRegistration;
  remote_responses?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  created_at: string;
  updated_at: string;
}

export function operationView(operation: PublicationOperationRecord) {
  return {
    operationId: operation.operation_id,
    kind: operation.kind,
    studyId: operation.study_id,
    status: operation.status,
    step: operation.step,
    result: operation.status === 'succeeded' ? {
      websiteArtifactId: operation.website_artifact_id,
      websiteAcquisitionId: operation.website_acquisition_id,
      websiteDeploymentId: operation.website_deployment_id,
      websiteBaseUrl: operation.deployment?.baseUrl,
      studyRevisionId: operation.study_revision_id,
      studyRevisionDigest: operation.study_revision_digest,
      collectionUrl: operation.collection_endpoint.baseUrl,
      registration: operation.registration,
    } : undefined,
    error: operation.error || null,
  };
}
