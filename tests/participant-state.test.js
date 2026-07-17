const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function stateModule() {
  return import(pathToFileURL(path.join(
    __dirname, '..', 'server', 'lib', 'participant-state.ts'
  )).href);
}

function pendingAttempt(status = 'completed_pending_outcome') {
  return { attempt_id: 'att_1', status };
}

function pendingTask() {
  return { status: 'pending' };
}

test('Done evidence waits for an explicit outcome', async () => {
  const source = require('node:fs').readFileSync(path.join(
    __dirname, '..', 'server', 'lib', 'participant-store.ts'
  ), 'utf8');
  assert.match(source, /completeAttemptEvidence[\s\S]*status:\s*'completed_pending_outcome'/);
  assert.doesNotMatch(source.match(/export async function completeAttemptEvidence[\s\S]*?\n}\n/)?.[0] || '', /accepted_attempt_id/);
});

test('succeeded accepts the attempt and completes the task', async () => {
  const { applyOutcomeTransition } = await stateModule();
  const result = applyOutcomeTransition(pendingAttempt(), pendingTask(), 'succeeded', undefined, 'now');
  assert.equal(result.attempt.status, 'accepted');
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.accepted_attempt_id, 'att_1');
});

test('failed_retry preserves failed attempt and keeps task pending', async () => {
  const { applyOutcomeTransition, nextAttemptNumber } = await stateModule();
  const result = applyOutcomeTransition(pendingAttempt(), pendingTask(), 'failed_retry', 'wrong page', 'now');
  assert.equal(result.attempt.status, 'failed');
  assert.equal(result.attempt.reason, 'wrong page');
  assert.equal(result.task.status, 'pending');
  assert.equal(result.task.accepted_attempt_id, undefined);
  assert.equal(nextAttemptNumber([{ attempt_number: 1 }]), 2);
});

test('failed_no_retry, skipped, and recording_problem have distinct transitions', async () => {
  const { applyOutcomeTransition, isTerminalTask } = await stateModule();
  const noRetry = applyOutcomeTransition(pendingAttempt(), pendingTask(), 'failed_no_retry', undefined, 'now');
  assert.equal(noRetry.task.status, 'failed_no_retry');
  const skipped = applyOutcomeTransition(pendingAttempt(), pendingTask(), 'skipped', undefined, 'now');
  assert.equal(skipped.attempt.status, 'failed');
  assert.equal(skipped.task.status, 'skipped');
  assert.equal(skipped.attempt.reason, 'participant_skipped');
  const problem = applyOutcomeTransition(pendingAttempt(), pendingTask(), 'recording_problem', undefined, 'now');
  assert.equal(problem.attempt.status, 'invalidated');
  assert.equal(problem.task.status, 'pending');
  assert.equal(isTerminalTask('completed'), true);
  assert.equal(isTerminalTask('skipped'), true);
  assert.equal(isTerminalTask('failed_no_retry'), true);
  assert.equal(isTerminalTask('pending'), false);
});

test('outcome is idempotent and a task cannot accept two attempts', async () => {
  const { applyOutcomeTransition } = await stateModule();
  const first = applyOutcomeTransition(pendingAttempt(), pendingTask(), 'succeeded', undefined, 'now');
  assert.equal(applyOutcomeTransition(first.attempt, first.task, 'succeeded', undefined, 'later').idempotent, true);
  assert.throws(() => applyOutcomeTransition(
    { attempt_id: 'att_2', status: 'completed_pending_outcome' },
    { status: 'pending', accepted_attempt_id: 'att_1' },
    'succeeded', undefined, 'now'
  ), /another accepted attempt/);
});

test('legacy projection follows canonical task and ignores an old failed replay', async () => {
  const { projectLegacyTrial } = await stateModule();
  const current = {
    session_id: 'session-2', outcome: 'succeeded', attempt_status: 'accepted',
    task_status: 'completed', completed: true,
  };
  const unchanged = projectLegacyTrial(
    current,
    { attempt_id: 'att-1', session_id: 'session-1', status: 'failed', outcome: 'failed_retry' },
    { status: 'pending', outcome: 'failed_retry' }
  );
  assert.deepEqual(unchanged, current);
  const terminalUnchanged = projectLegacyTrial(
    current,
    { attempt_id: 'att-1', session_id: 'session-1', status: 'failed', outcome: 'failed_retry' },
    { status: 'skipped', outcome: 'skipped', outcome_at: 'later' }
  );
  assert.deepEqual(terminalUnchanged, current);
  const projected = projectLegacyTrial(
    {},
    { attempt_id: 'att-2', session_id: 'session-2', status: 'accepted', outcome: 'succeeded' },
    { status: 'completed', accepted_attempt_id: 'att-2', outcome: 'succeeded', outcome_at: 'now' }
  );
  assert.equal(projected.completed, true);
  assert.equal(projected.attempt_status, 'accepted');
  assert.equal(projected.session_id, 'session-2');
});
