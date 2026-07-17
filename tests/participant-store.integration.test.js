const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createSession(dataDir, sessionId) {
  const dir = path.join(dataDir, 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema_version: 1, session_id: sessionId, status: 'complete',
    attempt_status: 'completed_pending_outcome', task_status: 'pending',
  }));
  fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ interactions: [{ seq: 1 }] }));
}

test('participant store persists retries, repairs idempotent outcomes, and never overwrites recording', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-rater-store-'));
    process.env.UI_RATER_DATA_DIR = dataDir;
    process.env.UI_RATER_SHUTDOWN_FILE = path.join(dataDir, 'shutdown.json');
  try {
    const storeUrl = pathToFileURL(path.join(
      __dirname, '..', 'server', 'lib', 'participant-store.ts'
    )).href;
    const store = await import(storeUrl);
    const outcomes = await import(pathToFileURL(path.join(
      __dirname, '..', 'server', 'lib', 'attempt-outcomes.ts'
    )).href);
    const sessions = await import(pathToFileURL(path.join(
      __dirname, '..', 'server', 'lib', 'sessions.ts'
    )).href);
    const configs = [1, 2].map((position) => ({
      slug: `task-${position}`, group: 'site', plain_app: 'app',
      task_prompt: `Task ${position}`, site_url: 'http://example.test',
      source_position: position * 2 + 1,
      defects: [], suggested_flows: [],
    }));
    const created = await store.createRun('P001', configs);
    const [task1, task2] = created.tasks;
    assert.deepEqual(created.tasks.map((task) => task.source_position), [3, 5]);
    assert.deepEqual(created.tasks.map((task) => readJson(path.join(
      dataDir, 'participants', 'P001', 'runs', created.run.run_id, 'tasks',
      `${String(task.position).padStart(3, '0')}-${task.assignment_id}`, 'task.json'
    )).source_position), [3, 5]);
    fs.writeFileSync(path.join(dataDir, 'results.json'), JSON.stringify({
      P001: {
        run_id: created.run.run_id,
        trials: configs.map((config, index) => ({
          index: index + 1, task_prompt: config.task_prompt,
          completed: false, timestamp: null, interactions: [],
        })),
      },
    }));

    const snapshotSession = '44444444-4444-4444-8444-444444444444';
    createSession(dataDir, snapshotSession);
    const snapshotDir = path.join(dataDir, 'sessions', snapshotSession, 'snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 's0001.jpg'), Buffer.from('jpeg-bytes'));
    const snapshotInput = {
      snapshotId: 's0001', imageDataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
      reason: 'task-end', ts: 10, elements: [],
    };
    await sessions.saveSnapshot(snapshotSession, snapshotInput);
    assert.ok(fs.existsSync(path.join(snapshotDir, 's0001.json')),
      'snapshot replay repairs metadata missing after an interrupted image write');
    await sessions.saveSnapshot(snapshotSession, snapshotInput);
    await assert.rejects(sessions.saveSnapshot(snapshotSession, {
      ...snapshotInput,
      imageDataUrl: `data:image/jpeg;base64,${Buffer.from('different').toString('base64')}`,
    }), /different content/);

    const session1 = '11111111-1111-4111-8111-111111111111';
    createSession(dataDir, session1);
    const attempt1 = await store.createAttempt({
      participantId: 'P001', runId: created.run.run_id,
      assignmentId: task1.assignment_id, sessionId: session1,
    });
    assert.equal((await store.createAttempt({
      participantId: 'P001', runId: created.run.run_id,
      assignmentId: task1.assignment_id, sessionId: session1,
    })).attempt_id, attempt1.attempt_id, 'same session request is idempotent');
    assert.equal((await store.completeAttemptEvidence({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt1.attempt_id, sessionId: session1,
    })).attempt.status, 'completed_pending_outcome');
    const failed = await outcomes.recordAttemptOutcome({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt1.attempt_id, outcome: 'failed_retry', reason: 'try again',
    });
    assert.equal(failed.task.status, 'pending');
    assert.equal(readJson(path.join(dataDir, 'sessions', session1, 'manifest.json')).attempt_status, 'failed');

    const session2 = '22222222-2222-4222-8222-222222222222';
    createSession(dataDir, session2);
    const attempt2 = await store.createAttempt({
      participantId: 'P001', runId: created.run.run_id,
      assignmentId: task1.assignment_id, sessionId: session2,
    });
    assert.equal(attempt2.attempt_number, 2);
    await store.saveAttemptRecording({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt2.attempt_id, data: Buffer.from('video-2'),
    });
    await store.saveAttemptRecording({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt2.attempt_id, data: Buffer.from('video-2'),
    });
    await assert.rejects(store.saveAttemptRecording({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt2.attempt_id, data: Buffer.from('different'),
    }), /different content/);
    await store.completeAttemptEvidence({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt2.attempt_id, sessionId: session2,
    });
    await outcomes.recordAttemptOutcome({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt2.attempt_id, outcome: 'succeeded',
    });
    await sessions.updateManifest(session2, {
      status: 'complete', attempt_status: 'accepted', task_status: 'completed', outcome: 'succeeded',
    });
    await sessions.saveSessionTrace(session2, [{ seq: 1 }, { seq: 2 }], {
      status: 'recording', attempt_status: 'recording', task_status: 'pending',
    });
    const protectedManifest = readJson(path.join(dataDir, 'sessions', session2, 'manifest.json'));
    assert.equal(protectedManifest.attempt_status, 'accepted');
    assert.equal(protectedManifest.task_status, 'completed');
    assert.equal(readJson(path.join(dataDir, 'sessions', session2, 'trace.json')).interactions.length, 1);
    const oldReplay = await outcomes.recordAttemptOutcome({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt1.attempt_id, outcome: 'failed_retry', reason: 'try again',
    });
    assert.equal(oldReplay.task.status, 'completed', 'old failed replay does not regress the task');
    assert.equal(oldReplay.task.accepted_attempt_id, attempt2.attempt_id);

    const session3 = '33333333-3333-4333-8333-333333333333';
    createSession(dataDir, session3);
    const attempt3 = await store.createAttempt({
      participantId: 'P001', runId: created.run.run_id,
      assignmentId: task2.assignment_id, sessionId: session3,
    });
    await store.completeAttemptEvidence({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task2.assignment_id,
      attemptId: attempt3.attempt_id, sessionId: session3,
    });

    const runRoot = path.join(dataDir, 'participants', 'P001', 'runs', created.run.run_id);
    const attempt3Dir = path.join(
      runRoot, 'tasks', `002-${task2.assignment_id}`, 'attempts', `001-${attempt3.attempt_id}`
    );
    fs.writeFileSync(path.join(attempt3Dir, 'manifest.json'), JSON.stringify({
      attempt_status: 'recording', task_status: 'pending',
    }));
    await store.completeAttemptEvidence({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task2.assignment_id,
      attemptId: attempt3.attempt_id, sessionId: session3,
    });
    assert.equal(
      readJson(path.join(attempt3Dir, 'manifest.json')).attempt_status,
      'completed_pending_outcome',
      'repeated evidence completion repairs its manifest projection'
    );
    const interrupted = readJson(path.join(attempt3Dir, 'attempt.json'));
    fs.writeFileSync(path.join(attempt3Dir, 'attempt.json'), JSON.stringify({
      ...interrupted, status: 'accepted', outcome: 'succeeded', outcome_at: '2026-01-01T00:00:00Z',
    }));
    const repaired = await outcomes.recordAttemptOutcome({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task2.assignment_id,
      attemptId: attempt3.attempt_id, outcome: 'succeeded',
    });
    assert.equal(repaired.idempotent, true);
    assert.equal(repaired.task.status, 'completed');
    assert.equal(readJson(path.join(runRoot, 'run.json')).status, 'completed');
    assert.equal(readJson(path.join(dataDir, 'shutdown.json')).run_id, created.run.run_id);
    assert.equal(readJson(path.join(attempt3Dir, 'manifest.json')).attempt_status, 'accepted');
    assert.ok(fs.existsSync(path.join(
      runRoot, 'events', `${attempt3.attempt_id}-succeeded.json`
    )));

    await outcomes.recordAttemptOutcome({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task2.assignment_id,
      attemptId: attempt3.attempt_id, outcome: 'succeeded',
    });
    assert.equal(fs.existsSync(path.join(dataDir, 'index')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'sync-queue')), false);

    const resultsFile = path.join(dataDir, 'results.json');
    fs.writeFileSync(resultsFile, JSON.stringify({
      P001: { run_id: 'run_new', trials: [{ index: 1, task_status: 'pending' }] },
    }));
    await outcomes.recordAttemptOutcome({
      participantId: 'P001', runId: created.run.run_id, assignmentId: task1.assignment_id,
      attemptId: attempt2.attempt_id, outcome: 'succeeded',
    });
    assert.equal(
      readJson(resultsFile).P001.trials[0].task_status,
      'pending',
      'an old run replay cannot rewrite the current run compatibility projection'
    );

    await assert.rejects(store.createAttempt({
      participantId: '../escape', runId: created.run.run_id,
      assignmentId: task2.assignment_id, sessionId: session3,
    }), /Invalid participantId/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.UI_RATER_DATA_DIR;
    delete process.env.UI_RATER_SHUTDOWN_FILE;
  }
});
