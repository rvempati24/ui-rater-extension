import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestDigest } from '@ui-rater/contracts';
import { CollectionClient } from '../src/clients/collection-client.ts';
import { WebsiteClient } from '../src/clients/website-client.ts';
import { createPublishOperation, runPublish } from '../src/workflows/publish-study.ts';
import { createRetirementOperation, runRetirement } from '../src/workflows/retire-study.ts';
import { OperationStore } from '../src/storage/operation-store.ts';
import { StudyStore } from '../src/storage/study-store.ts';

test('publication saga freezes revision bytes and converges on idempotent remote results', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-manager-'));
  const studies = new StudyStore(dataDir);
  const operations = new OperationStore(dataDir);
  await Promise.all([studies.init(), operations.init()]);
  const spec = {
    schemaVersion: 1 as const,
    studyId: 'study_fixture',
    websiteSource: { kind: 'artifact' as const, websiteArtifactId: 'wsa_fixture', websiteAcquisitionId: 'wac_fixture' },
    taskSelector: { kind: 'positions' as const, positions: [1, 3] },
  };
  const { study } = await studies.create(spec, 'study-create');
  const artifact = {
    schemaVersion: 1 as const, websiteArtifactId: 'wsa_fixture', artifactDigest: 'sha256:fixture', website: 'fixture',
    createdAt: '2026-07-22T00:00:00.000Z', tasks: [1, 2, 3].map((position) => ({
      websiteTaskId: `wst_${position}`, sourcePosition: position, prompt: `Task ${position}`, slug: `task-${position}`,
      group: 'fixture', startPath: position === 3 ? '/deep-route' : '/', suggestedFlows: [],
    })),
  };
  const acquisition = { schemaVersion: 1 as const, websiteAcquisitionId: 'wac_fixture', websiteArtifactId: 'wsa_fixture', artifactDigest: 'sha256:fixture', source: { kind: 'local' as const }, resolvedAt: '2026-07-22T00:00:00.000Z' };
  const deployment = { schemaVersion: 1 as const, websiteDeploymentId: 'wsd_fixture', websiteArtifactId: 'wsa_fixture', artifactDigest: 'sha256:fixture', routingLabel: 'd-fixture', baseUrl: 'http://d-fixture.localhost:4173/', status: 'ready' as const, createdAt: '2026-07-22T00:00:00.000Z' };
  const calls: string[] = [];
  let websiteIdentity = 'website-test';
  let collectionIdentity = 'collection-test';
  const website = {
    ready: async () => ({ serviceInstanceId: websiteIdentity }),
    getArtifact: async () => artifact,
    getAcquisition: async () => acquisition,
    createDeployment: async () => { calls.push('deployment'); return deployment; },
    releaseDeployment: async () => { calls.push('release'); },
  } as unknown as WebsiteClient;
  const collection = {
    ready: async () => ({ serviceInstanceId: collectionIdentity }),
    registerRevision: async (revision: unknown) => { calls.push('collection'); return { studyRevisionId: (revision as { studyRevisionId: string }).studyRevisionId, revisionDigest: requestDigest(revision), admission: 'accepting' as const }; },
    closeRevision: async () => { calls.push('close'); return { studyRevisionId: 'str_fixture', revisionDigest: 'sha256:fixture', admission: 'closed' as const }; },
    summary: async () => ({ registration: { studyRevisionId: 'str_fixture', revisionDigest: 'sha256:fixture', admission: 'closed' as const }, runCounts: { active: 0, completed: 0, aborted: 0, total: 0 } }),
    retireRevision: async () => { calls.push('retire'); return { studyRevisionId: 'str_fixture', revisionDigest: 'sha256:fixture', admission: 'retired' as const }; },
  } as unknown as CollectionClient;
  const runtime = {
    config: { dataDir, host: '127.0.0.1', port: 4310, websiteUrl: 'http://website', collectionUrl: 'http://collection', requestTimeoutMs: 1000, serviceInstanceId: 'manager-test' },
    studies, operations, website, collection,
  };
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => createPublishOperation(runtime, study)));
  assert.equal(new Set(concurrent.map((candidate) => candidate.operation_id)).size, 1);
  assert.equal((await operations.list()).length, 1);
  const operation = concurrent[0];
  const result = await runPublish(runtime, operation.operation_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.revision?.tasks.length, 2);
  assert.deepEqual(calls, ['deployment', 'collection']);
  const replay = await runPublish(runtime, result.operation_id);
  assert.equal(replay.operation_id, result.operation_id);
  assert.deepEqual(calls, ['deployment', 'collection']);

  const readyStudy = await studies.get(study.study_id);
  assert.ok(readyStudy);
  const retirement = await createRetirementOperation(runtime, readyStudy);
  websiteIdentity = 'website-replacement';
  const failedRetirement = await runRetirement(runtime, retirement.operation_id);
  assert.equal(failedRetirement.status, 'failed_terminal');
  assert.equal(failedRetirement.error?.code, 'website_service_identity_changed');
  assert.deepEqual(calls, ['deployment', 'collection']);
  assert.equal((await studies.get(study.study_id))?.status, 'retiring');
  const resumedRetirement = await createRetirementOperation(runtime, readyStudy);
  assert.equal(resumedRetirement.operation_id, retirement.operation_id);
  assert.equal(resumedRetirement.status, 'running');
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('terminal publication records repair the Study projection after a commit-point crash', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-manager-reconcile-'));
  try {
    const studies = new StudyStore(dataDir);
    const operations = new OperationStore(dataDir);
    await Promise.all([studies.init(), operations.init()]);
    const spec = {
      schemaVersion: 1 as const,
      studyId: 'study_reconcile',
      websiteSource: { kind: 'artifact' as const, websiteArtifactId: 'wsa_fixture', websiteAcquisitionId: 'wac_fixture' },
      taskSelector: { kind: 'all' as const },
    };
    const { study } = await studies.create(spec, 'reconcile-create');
    const runtime = {
      config: { dataDir, host: '127.0.0.1', port: 4310, websiteUrl: 'http://website', collectionUrl: 'http://collection', requestTimeoutMs: 1000, serviceInstanceId: 'manager-test' },
      studies, operations,
      website: {} as WebsiteClient,
      collection: {} as CollectionClient,
    };
    const succeeded = await createPublishOperation(runtime, study);
    await operations.update(succeeded, { status: 'succeeded', step: 'succeeded' });
    assert.equal((await studies.get(study.study_id))?.status, 'publishing');
    await runPublish(runtime, succeeded.operation_id);
    assert.equal((await studies.get(study.study_id))?.status, 'ready');

    const { study: failedStudy } = await studies.create({ ...spec, studyId: 'study_reconcile_failed' }, 'reconcile-failed-create');
    const failed = await createPublishOperation(runtime, failedStudy);
    await operations.update(failed, {
      status: 'failed_terminal', step: 'failed_terminal',
      error: { code: 'fixture_failure', message: 'fixture failure', retryable: false },
    });
    assert.equal((await studies.get(failedStudy.study_id))?.status, 'publishing');
    await runPublish(runtime, failed.operation_id);
    assert.equal((await studies.get(failedStudy.study_id))?.status, 'draft');

    const { study: progressedStudy } = await studies.create({ ...spec, studyId: 'study_reconcile_progressed' }, 'reconcile-progressed-create');
    const progressed = await createPublishOperation(runtime, progressedStudy);
    await operations.update(progressed, {
      status: 'failed_terminal', step: 'failed_terminal',
      website_deployment_id: 'wsd_committed',
      error: { code: 'fixture_failure', message: 'failure after deployment', retryable: false },
    });
    await runPublish(runtime, progressed.operation_id);
    assert.equal((await studies.get(progressedStudy.study_id))?.status, 'publishing');
    const resumed = await createPublishOperation(runtime, progressedStudy);
    assert.equal(resumed.operation_id, progressed.operation_id);
    assert.equal(resumed.status, 'running');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('study creation serializes immutable ID and idempotency-key races', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-rater-manager-create-'));
  try {
    const studies = new StudyStore(dataDir);
    await studies.init();
    const base = {
      schemaVersion: 1 as const,
      websiteSource: { kind: 'artifact' as const, websiteArtifactId: 'wsa_fixture', websiteAcquisitionId: 'wac_fixture' },
      taskSelector: { kind: 'all' as const },
    };
    const sameId = await Promise.allSettled([
      studies.create({ ...base, studyId: 'study_race' }, 'create-race-a'),
      studies.create({ ...base, studyId: 'study_race', taskSelector: { kind: 'positions' as const, positions: [1] } }, 'create-race-b'),
    ]);
    assert.equal(sameId.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(sameId.filter((result) => result.status === 'rejected').length, 1);

    const sameKey = await Promise.allSettled([
      studies.create({ ...base, studyId: 'study_key_a' }, 'shared-create-key'),
      studies.create({ ...base, studyId: 'study_key_b' }, 'shared-create-key'),
    ]);
    assert.equal(sameKey.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(sameKey.filter((result) => result.status === 'rejected').length, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
