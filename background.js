importScripts('task-session.js');

const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';
const ACTIVE_SESSION_KEY = '_activeSession';
const MAX_SNAPSHOTS = 20;
const SNAPSHOT_DEBOUNCE_MS = 750;

let recordingTabId = null;
let sessionWriteLock = Promise.resolve();

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording tab video for the study',
    });
  }
}

async function startRecording(tabId) {
  await ensureOffscreen();
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', streamId }, (res) => {
      if (res?.ok) {
        recordingTabId = tabId;
        resolve();
      } else reject(new Error(res?.error || 'Failed to start recording'));
    });
  });
}

async function stopRecording(serverUrl, participantId, taskIndex) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING', serverUrl, participantId, taskIndex,
    }, (res) => {
      if (res?.ok) recordingTabId = null;
      resolve(res || { ok: false, error: 'Recorder did not respond' });
    });
  });
}

async function cancelRecording() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' }, (res) => {
      recordingTabId = null;
      resolve(res || { ok: false });
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Task tracker did not respond'));
      else resolve(response);
    });
  });
}

async function sendTrackingMessage(tabId, message) {
  try {
    return await sendTabMessage(tabId, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return sendTabMessage(tabId, message).catch(() => { throw firstError; });
  }
}

async function openPendingTask(createOptions) {
  const taskTab = await chrome.tabs.create(createOptions);
  if (!Number.isInteger(taskTab?.id)) throw new Error('Chrome did not create a task tab');
  await chrome.storage.local.set({ _pendingTaskTabId: taskTab.id });
  return { status: 'pending', tabId: taskTab.id };
}

function createSession() {
  return {
    sessionId: crypto.randomUUID(),
    originTime: Date.now(),
    viewStart: new Date().toISOString(),
  };
}

async function startTaskFlow(msg) {
  const stored = await chrome.storage.local.get(['_pendingTaskTabId']);
  const plan = UiRaterTaskSession.planTaskStart({
    currentTab: msg.currentTab,
    siteUrl: msg.siteUrl,
    pendingTaskTabId: stored._pendingTaskTabId,
  });

  if (plan.action === 'open') return openPendingTask(plan.createOptions);
  if (plan.action === 'wrong-tab') {
    try {
      await chrome.tabs.update(plan.pendingTaskTabId, { active: true });
      return { status: 'pending', tabId: plan.pendingTaskTabId };
    } catch {
      await chrome.storage.local.remove(['_pendingTaskTabId']);
      const retryPlan = UiRaterTaskSession.planTaskStart({
        currentTab: msg.currentTab,
        siteUrl: msg.siteUrl,
      });
      return openPendingTask(retryPlan.createOptions);
    }
  }

  const result = await UiRaterTaskSession.beginRecordingOnTab({
    startRecording,
    createSession,
    storeSession: async ({ sessionId, originTime, viewStart, taskTabId }) => {
      const taskTab = await chrome.tabs.get(taskTabId);
      await chrome.storage.local.set({
        _tracking: true,
        _sessionId: sessionId,
        _originTime: originTime,
        _viewStart: viewStart,
        _taskTabId: taskTabId,
        [ACTIVE_SESSION_KEY]: {
          sessionId,
          originTime,
          viewStart,
          taskTabId,
          windowId: taskTab.windowId,
          interactions: [],
          nextEventSeq: 1,
          snapshotCount: 0,
          lastSnapshotAt: 0,
        },
      });
    },
    startTracking: (tabId, activeSession) => sendTrackingMessage(tabId, {
      type: 'START_TRACKING', session: activeSession,
    }),
    stopTracking: (tabId) => sendTabMessage(tabId, { type: 'STOP_TRACKING' }),
    cancelRecording,
    clearSession: () => chrome.storage.local.remove([
      '_tracking', '_sessionId', '_originTime', '_viewStart', '_taskTabId', ACTIVE_SESSION_KEY,
    ]),
  }, { tabId: plan.tabId });

  await chrome.storage.local.remove(['_pendingTaskTabId']);
  return { status: 'recording', ...result };
}

function withSessionWrite(fn) {
  const next = sessionWriteLock.then(fn);
  sessionWriteLock = next.catch(() => {});
  return next;
}

async function appendInteractions(msg) {
  return withSessionWrite(async () => {
    const data = await chrome.storage.local.get([
      ACTIVE_SESSION_KEY, 'participantId', 'serverUrl', 'currentTaskIndex', 'tasks',
    ]);
    const session = data[ACTIVE_SESSION_KEY];
    if (!session || !Array.isArray(msg.interactions)) return { ok: false, error: 'No active session' };

    for (const event of msg.interactions) {
      session.interactions.push({ ...event, seq: session.nextEventSeq++ });
    }
    await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: session });

    if (data.participantId && data.tasks) {
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      await fetch(`${serverUrl}/api/partial-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          participantId: data.participantId,
          trialIndex: (data.currentTaskIndex || 0) + 1,
          view_start: session.viewStart,
          interactions: session.interactions,
        }),
      }).catch(() => {});
    }
    return { ok: true, interactionCount: session.interactions.length };
  });
}

async function captureSnapshot(msg, sender) {
  return withSessionWrite(async () => {
    const data = await chrome.storage.local.get([ACTIVE_SESSION_KEY, 'serverUrl']);
    const session = data[ACTIVE_SESSION_KEY];
    if (!session) return { ok: false, error: 'No active session' };
    if (sender.tab?.id !== session.taskTabId) return { ok: false, error: 'Snapshot came from another tab' };
    if (!sender.tab.active) return { ok: false, error: 'Task tab is not active' };

    const now = Date.now();
    if (session.snapshotCount >= MAX_SNAPSHOTS) return { ok: true, skipped: 'limit' };
    if (now - session.lastSnapshotAt < SNAPSHOT_DEBOUNCE_MS && msg.reason !== 'task-end') {
      return { ok: true, skipped: 'debounced' };
    }

    const imageDataUrl = await chrome.tabs.captureVisibleTab(session.windowId, {
      format: 'jpeg', quality: 70,
    });
    const snapshotId = `s${String(session.snapshotCount + 1).padStart(4, '0')}`;
    const serverUrl = data.serverUrl || DEFAULT_SERVER;
    const response = await fetch(`${serverUrl}/api/sessions/${session.sessionId}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshotId,
        imageDataUrl,
        reason: msg.reason || 'state-change',
        ts: msg.ts,
        url: msg.url,
        title: msg.title,
        viewport: msg.viewport,
        scroll: msg.scroll,
        elements: msg.elements || [],
      }),
    });
    if (!response.ok) throw new Error(`Snapshot upload failed: ${response.status}`);

    session.snapshotCount += 1;
    session.lastSnapshotAt = now;
    await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: session });
    return { ok: true, snapshotId };
  });
}

async function completeTask(msg) {
  const data = await chrome.storage.local.get([
    ACTIVE_SESSION_KEY, 'participantId', 'serverUrl', 'currentTaskIndex', 'tasks',
  ]);
  const session = data[ACTIVE_SESSION_KEY];
  if (!data.participantId || !data.tasks || !session) throw new Error('Not configured');

  const serverUrl = data.serverUrl || DEFAULT_SERVER;
  const taskIndex = (data.currentTaskIndex || 0) + 1;
  const participantId = data.participantId;

  const recordingResult = await stopRecording(serverUrl, participantId, taskIndex);
  if (!recordingResult.ok) {
    throw new Error(`Recording upload failed: ${recordingResult.error || 'unknown error'}`);
  }

  const latest = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
  const finalSession = latest[ACTIVE_SESSION_KEY] || session;
  const res = await fetch(`${serverUrl}/api/complete-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: finalSession.sessionId,
      participantId,
      trialIndex: taskIndex,
      view_start: finalSession.viewStart || msg.viewStart,
      duration_ms: msg.durationMs || 0,
      interactions: finalSession.interactions,
    }),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status}`);

  await chrome.storage.local.remove([ACTIVE_SESSION_KEY, '_sessionId']);
  const nextIndex = taskIndex;
  if (nextIndex < data.tasks.length) await chrome.storage.local.set({ currentTaskIndex: nextIndex });
  return { ok: true, sessionId: finalSession.sessionId, finished: nextIndex >= data.tasks.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'tasks', 'currentTaskIndex'], sendResponse);
    return true;
  }
  if (msg.type === 'APPEND_INTERACTIONS') {
    appendInteractions(msg).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_SNAPSHOT') {
    captureSnapshot(msg, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'START_TASK_FLOW') {
    startTaskFlow(msg).then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'COMPLETE_TASK') {
    completeTask(msg).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'SKIP_TASK') {
    chrome.storage.local.get(['serverUrl', 'participantId', 'currentTaskIndex'], async (data) => {
      const taskIndex = (data.currentTaskIndex || 0) + 1;
      await stopRecording(data.serverUrl || DEFAULT_SERVER, data.participantId, taskIndex);
    });
    return false;
  }
  if (msg.type === 'CLEAR_INTERACTIONS') {
    chrome.storage.local.remove([ACTIVE_SESSION_KEY, '_sessionId']);
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (!data.serverUrl) chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });
  });
});
