const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addWorkflowOutcome, beginRecordingOnTab, compareWorkflow, mergeSnapshotProgress,
  planTaskStart, resolveTaskView, snapshotAdmission,
} = require('../task-session.js');

test('reserves the final screenshot slot for task-end', () => {
  assert.deepEqual(snapshotAdmission(118, 120, 1, false), { allowed: true });
  assert.deepEqual(
    snapshotAdmission(119, 120, 1, false),
    { allowed: false, reason: 'reserved-for-task-end' }
  );
  assert.deepEqual(snapshotAdmission(119, 120, 1, true), { allowed: true });
  assert.deepEqual(
    snapshotAdmission(120, 120, 1, true),
    { allowed: false, reason: 'absolute-limit' }
  );
});

test('snapshot progress merges into the latest session without losing interactions', () => {
  const latest = {
    sessionId: 'session-1', interactions: [{ seq: 1 }, { seq: 2 }],
    snapshotCount: 1, lastSnapshotAt: 100,
  };
  const merged = mergeSnapshotProgress(latest, 'session-1', 2, 200);
  assert.deepEqual(merged.interactions, latest.interactions);
  assert.equal(merged.snapshotCount, 2);
  assert.equal(merged.lastSnapshotAt, 200);
  assert.equal(mergeSnapshotProgress(null, 'session-1', 2, 200), null);
  assert.equal(mergeSnapshotProgress(latest, 'different-session', 2, 200), null);
});

test('restores each persisted popup workflow phase', () => {
  assert.equal(resolveTaskView({ workflow: { phase: 'recording' } }), 'recording');
  assert.equal(resolveTaskView({
    workflow: { phase: 'finalizing_evidence' }, activeSession: { sessionId: 's' },
  }), 'finalizing_evidence');
  assert.equal(resolveTaskView({ workflow: { phase: 'awaiting_outcome' } }), 'awaiting_outcome');
  assert.equal(resolveTaskView({ workflow: { phase: 'awaiting_retry_choice' } }), 'awaiting_retry_choice');
  assert.equal(resolveTaskView({
    workflow: { phase: 'awaiting_outcome', intendedOutcome: 'skipped' },
  }), 'submitting_outcome');
  assert.equal(resolveTaskView({ activeSession: { sessionId: 'legacy' } }), 'finalizing_evidence');
  assert.equal(resolveTaskView({ tracking: true }), 'recording');
  assert.equal(resolveTaskView({
    workflow: { phase: 'finalizing_evidence' }, tracking: true,
  }), 'finalizing_evidence');
  assert.equal(resolveTaskView({
    workflow: { phase: 'submitting_outcome' }, tracking: true,
  }), 'submitting_outcome');
});

test('records the current tab when it already shows the task website', () => {
  const result = planTaskStart({
    currentTab: { id: 12, url: 'http://localhost:3000/apps/pilot/' },
    siteUrl: 'http://localhost:3000/apps/pilot',
  });

  assert.deepEqual(result, { action: 'record', tabId: 12 });
});
test('opens the task website without recording when the current tab is unrelated', () => {
  const result = planTaskStart({
    currentTab: { id: 3, url: 'https://example.com', windowId: 7 },
    siteUrl: 'http://localhost:3000/apps/pilot/',
  });

  assert.deepEqual(result, {
    action: 'open',
    createOptions: {
      url: 'http://localhost:3000/apps/pilot/',
      active: true,
      windowId: 7,
    },
  });
});

test('reuses the run task tab for the next task instead of opening another tab', () => {
  const result = planTaskStart({
    currentTab: { id: 12, url: 'http://localhost:43172/multi-ride', windowId: 7 },
    siteUrl: 'http://localhost:43172/',
    reusableTaskTabId: 12,
  });

  assert.deepEqual(result, {
    action: 'reuse', tabId: 12, url: 'http://localhost:43172/',
  });
});

test('can return to and reuse the run task tab from another active tab', () => {
  const result = planTaskStart({
    currentTab: { id: 99, url: 'https://example.com/', windowId: 7 },
    siteUrl: 'http://localhost:43172/',
    reusableTaskTabId: 12,
  });

  assert.deepEqual(result, {
    action: 'reuse', tabId: 12, url: 'http://localhost:43172/',
  });
});

test('never tries to record a Chrome internal page', () => {
  const result = planTaskStart({
    currentTab: { id: 4, url: 'chrome://newtab/', windowId: 8 },
    siteUrl: 'https://example.com/task',
  });

  assert.equal(result.action, 'open');
});

test('optional workflow comparison summarizes actions without input values', () => {
  const comparison = compareWorkflow(
    ['Open the form and submit it.'],
    [
      { kind: 'click', text: 'Open form' },
      { kind: 'input', field: 'email', value: 'secret@example.test' },
      { kind: 'input', field: 'email', value: 'secret2@example.test' },
      { kind: 'formsubmit' },
    ],
  );
  assert.deepEqual(comparison.referenceWorkflow, ['Open the form and submit it.']);
  assert.deepEqual(comparison.actualWorkflow, [
    'Click control 1', 'Edit field 2', 'Submit form',
  ]);
  assert.doesNotMatch(JSON.stringify(comparison), /secret@example/);
  assert.deepEqual(comparison.uxSignals, []);
});

test('workflow comparison does not expose page text or DOM identifiers', () => {
  const comparison = compareWorkflow([], [
    { kind: 'click', text: 'private-account@example.test', tag: 'button#secret-token' },
    { kind: 'input', field: 'private-phone', tag: 'input#private-phone', value: '555-0100' },
  ]);
  assert.deepEqual(comparison.actualWorkflow, ['Click control 1', 'Edit field 2']);
  assert.doesNotMatch(
    JSON.stringify(comparison),
    /private-account|secret-token|private-phone|555-0100/,
  );
});

test('workflow comparison reports conservative friction signals and outcome', () => {
  const comparison = compareWorkflow([], [
    { kind: 'click', text: 'Continue' },
    { kind: 'scroll' },
    { kind: 'click', text: 'Continue' },
    { kind: 'scroll' },
    { kind: 'click', text: 'Continue' },
  ]);
  const completed = addWorkflowOutcome(comparison, 'failed_no_retry');
  assert.match(completed.uxSignals.join(' '), /Repeated action/);
  assert.match(completed.uxSignals.join(' '), /No reference workflow/);
  assert.match(completed.uxSignals.join(' '), /failed no retry/);
});

test('records the pending task tab after the user invokes the extension on it', () => {
  const result = planTaskStart({
    currentTab: { id: 21, url: 'https://example.com/changed-by-spa' },
    siteUrl: 'https://example.com/task',
    pendingTaskTabId: 21,
  });

  assert.deepEqual(result, { action: 'record', tabId: 21 });
});

test('rejects recording from a different tab while a task tab is pending', () => {
  const result = planTaskStart({
    currentTab: { id: 22, url: 'https://other.example/' },
    siteUrl: 'https://example.com/task',
    pendingTaskTabId: 21,
  });

  assert.deepEqual(result, { action: 'wrong-tab', pendingTaskTabId: 21 });
});

test('starts recording and tracking on the already authorized tab', async () => {
  const calls = [];
  const recordingStart = { videoStartEpochMs: 900, startSource: 'mediarecorder-start-event' };
  const deps = {
    startRecording: async (tabId) => { calls.push(['record', tabId]); return recordingStart; },
    createSession: async (value) => { calls.push(['create', value]); return session; },
    storeSession: async (session) => calls.push(['store', session]),
    startTracking: async (tabId, session) => calls.push(['track', tabId, session]),
    stopTracking: async () => {},
    cancelRecording: async () => {},
    clearSession: async () => {},
  };
  const session = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    originTime: 1000,
    viewStart: '2026-07-16T12:00:00.000Z',
  };

  const result = await beginRecordingOnTab(deps, { tabId: 42 });

  assert.deepEqual(result, { tabId: 42, sessionId: session.sessionId });
  assert.deepEqual(calls, [
    ['record', 42],
    ['create', recordingStart],
    ['store', { ...session, taskTabId: 42 }],
    ['track', 42, session],
  ]);
});

test('leaves the task page open and pending when capture fails', async () => {
  const calls = [];
  const deps = {
    startRecording: async () => { throw new Error('activeTab missing'); },
    createSession: async () => calls.push('create'),
    storeSession: async () => calls.push('store'),
    startTracking: async () => calls.push('track'),
    stopTracking: async () => calls.push('stop-track'),
    cancelRecording: async () => calls.push('cancel-recording'),
    clearSession: async () => calls.push('clear'),
  };

  await assert.rejects(
    beginRecordingOnTab(deps, {
      tabId: 9,
      session: { originTime: 1, viewStart: 'now' },
    }),
    /activeTab missing/
  );
  assert.deepEqual(calls, []);
});

test('invalidates a server attempt when local session storage fails', async () => {
  const calls = [];
  const session = { sessionId: 'session-1', attemptId: 'attempt-1' };
  const deps = {
    startRecording: async () => calls.push('record'),
    createSession: async () => session,
    storeSession: async () => { throw new Error('storage unavailable'); },
    startTracking: async () => calls.push('track'),
    stopTracking: async () => calls.push('stop-track'),
    cancelRecording: async () => calls.push('cancel-recording'),
    clearSession: async (value) => calls.push(['clear', value]),
  };

  await assert.rejects(beginRecordingOnTab(deps, { tabId: 9 }), /storage unavailable/);
  assert.deepEqual(calls, [
    'record',
    'cancel-recording',
    ['clear', session],
  ]);
});
