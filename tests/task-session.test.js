const test = require('node:test');
const assert = require('node:assert/strict');

const { beginRecordingOnTab, planTaskStart } = require('../task-session.js');

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

test('never tries to record a Chrome internal page', () => {
  const result = planTaskStart({
    currentTab: { id: 4, url: 'chrome://newtab/', windowId: 8 },
    siteUrl: 'https://example.com/task',
  });

  assert.equal(result.action, 'open');
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
  const deps = {
    startRecording: async (tabId) => calls.push(['record', tabId]),
    storeSession: async (session) => calls.push(['store', session]),
    startTracking: async (tabId, session) => calls.push(['track', tabId, session]),
    stopTracking: async () => {},
    cancelRecording: async () => {},
    clearSession: async () => {},
  };
  const session = { originTime: 1000, viewStart: '2026-07-16T12:00:00.000Z' };

  const result = await beginRecordingOnTab(deps, { tabId: 42, session });

  assert.deepEqual(result, { tabId: 42 });
  assert.deepEqual(calls, [
    ['record', 42],
    ['store', { ...session, taskTabId: 42 }],
    ['track', 42, session],
  ]);
});

test('leaves the task page open and pending when capture fails', async () => {
  const calls = [];
  const deps = {
    startRecording: async () => { throw new Error('activeTab missing'); },
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
