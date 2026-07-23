const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function revision(id, baseUrl) {
  return {
    schemaVersion: 1,
    studyId: `study_${id}`,
    studyRevisionId: `str_${id}`,
    website: {
      websiteDeploymentId: `wsd_${id}`,
      websiteArtifactId: `wsa_${id}`,
      websiteAcquisitionId: `wac_${id}`,
      artifactDigest: `sha256:${id}`,
      baseUrl,
      provenance: { source: 'fixture', id },
    },
    tasks: [1, 3].map((sourcePosition, index) => ({
      websiteTaskId: `wst_${id}_${sourcePosition}`,
      sourcePosition,
      position: index + 1,
      prompt: `Fixture task ${sourcePosition}`,
      slug: `fixture-${sourcePosition}`,
      group: 'fixture',
      targetUrl: `${baseUrl}${sourcePosition === 3 ? 'deep-route' : ''}`,
      isMind2Web: sourcePosition === 3,
      taskSource: sourcePosition === 3 ? 'mind2web' : undefined,
      legacyAppId: `legacy-${sourcePosition}`,
      suggestedFlows: [],
    })),
    publishedAt: '2026-07-22T00:00:00.000Z',
  };
}

test('Collection binds runs to immutable Study Revisions and serializes admission', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-rater-managed-'));
  process.env.UI_RATER_DATA_DIR = dataDir;
  try {
    const libDir = path.join(__dirname, '..', 'server', 'lib');
    const studies = await import(pathToFileURL(path.join(libDir, 'study-revisions.ts')).href);
    const store = await import(pathToFileURL(path.join(libDir, 'participant-store.ts')).href);
    const first = revision('one', 'http://d-one.localhost:4173/');
    await studies.registerStudyRevision(first, 'manager:pub_fixture:collection');
    const created = await store.createRunFromStudyRevision('P001', first, 'create-one');
    const replay = await store.createRunFromStudyRevision('P001', first, 'create-one');
    assert.equal(replay.created, false);
    assert.equal(replay.run.run_id, created.run.run_id);
    assert.equal(replay.tasks[0].target_url, first.tasks[0].targetUrl);
    const participantFile = path.join(dataDir, 'participants', 'P001', 'participant.json');
    const participantWithoutPointer = JSON.parse(fs.readFileSync(participantFile, 'utf8'));
    delete participantWithoutPointer.active_run_id;
    fs.writeFileSync(participantFile, `${JSON.stringify(participantWithoutPointer, null, 2)}\n`);
    await assert.rejects(
      store.createRunFromStudyRevision('P001', first, 'new-key-after-pointer-crash'),
      (error) => error.code === 'participant_run_active'
    );
    assert.equal(JSON.parse(fs.readFileSync(participantFile, 'utf8')).active_run_id, created.run.run_id);
    const second = revision('two', 'http://d-two.localhost:4173/');
    await assert.rejects(
      studies.registerStudyRevision(second, 'manager:pub_fixture:collection'),
      (error) => error.code === 'idempotency_key_reused'
    );
    await studies.registerStudyRevision(second, 'register-two');
    assert.equal((await studies.getCurrentStudyRevision()).revision.studyRevisionId, second.studyRevisionId);
    await assert.rejects(
      store.createRunFromStudyRevision('P001', second, 'create-two'),
      (error) => error.code === 'participant_run_active'
    );
    await studies.closeStudyRevision(first.studyRevisionId);
    assert.equal((await studies.getCurrentStudyRevision()).revision.studyRevisionId, second.studyRevisionId);
    const replayAfterClose = await store.createRunFromStudyRevision('P001', first, 'create-one');
    assert.equal(replayAfterClose.created, false);
    assert.equal(replayAfterClose.run.run_id, created.run.run_id);
    await assert.rejects(
      store.createRunFromStudyRevision('P002', first, 'create-closed'),
      (error) => error.code === 'study_admission_closed'
    );
    const summary = await studies.summarizeStudyRevision(first.studyRevisionId);
    assert.equal(summary.runCounts.active, 1);
    await assert.rejects(studies.retireStudyRevision(first.studyRevisionId), (error) => error.code === 'active_participant_runs');
    await store.updateRunStatus('P001', created.run.run_id, 'aborted');
    assert.equal(await store.getActiveRun('P001'), null);

    const corruptRunDir = path.join(dataDir, 'participants', 'P003', 'runs', 'run_corrupt');
    fs.mkdirSync(corruptRunDir, { recursive: true });
    await assert.rejects(
      studies.summarizeStudyRevision(second.studyRevisionId),
      (error) => error.code === 'study_run_state_unreadable'
    );

    const third = revision('three', 'http://d-three.localhost:4173/');
    await studies.registerStudyRevision(third, 'register-three');
    const archived = await store.createRunFromStudyRevision('P004', third, 'p004-first');
    await store.updateRunStatus('P004', archived.run.run_id, 'archived');
    const active = await store.createRunFromStudyRevision('P004', third, 'p004-second');
    await assert.rejects(
      store.updateRunStatus('P004', archived.run.run_id, 'active'),
      (error) => error.code === 'participant_run_active'
    );
    assert.equal((await store.getActiveRun('P004')).run.run_id, active.run.run_id);

    const fourth = revision('four', 'http://d-four.localhost:4173/');
    await studies.registerStudyRevision(fourth, 'register-four');
    fs.rmSync(path.join(dataDir, 'study-revisions', fourth.studyRevisionId, 'admission.json'));
    await assert.rejects(
      store.createRunFromStudyRevision('P005', fourth, 'missing-admission'),
      (error) => error.code === 'study_registration_corrupt'
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.UI_RATER_DATA_DIR;
  }
});
