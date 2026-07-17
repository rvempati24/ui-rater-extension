importScripts('task-session.js');

const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';

let collectedInteractions = [];
let recordingTabId = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
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
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', streamId }, (res) => {
      if (res?.ok) {
        recordingTabId = tabId;
        resolve();
      }
      else reject(new Error(res?.error || 'Failed to start recording'));
    });
  });
}

async function stopRecording(serverUrl, participantId, taskIndex) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING',
      serverUrl,
      participantId,
      taskIndex,
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
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || 'Task tracker did not respond'));
      } else {
        resolve(response);
      }
    });
  });
}

async function sendTrackingMessage(tabId, message) {
  try {
    return await sendTabMessage(tabId, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    return sendTabMessage(tabId, message).catch(() => { throw firstError; });
  }
}

async function openPendingTask(createOptions) {
  const taskTab = await chrome.tabs.create(createOptions);
  if (!Number.isInteger(taskTab?.id)) throw new Error('Chrome did not create a task tab');
  await chrome.storage.local.set({ _pendingTaskTabId: taskTab.id });
  return { status: 'pending', tabId: taskTab.id };
}

async function startTaskFlow(msg) {
  const stored = await chrome.storage.local.get(['_pendingTaskTabId']);
  const plan = UiRaterTaskSession.planTaskStart({
    currentTab: msg.currentTab,
    siteUrl: msg.siteUrl,
    pendingTaskTabId: stored._pendingTaskTabId,
  });

  if (plan.action === 'open') {
    return openPendingTask(plan.createOptions);
  }

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

  collectedInteractions = [];
  const session = {
    originTime: Date.now(),
    viewStart: new Date().toISOString(),
  };
  const result = await UiRaterTaskSession.beginRecordingOnTab({
    startRecording,
    storeSession: ({ originTime, viewStart, taskTabId }) => chrome.storage.local.set({
      _tracking: true,
      _originTime: originTime,
      _viewStart: viewStart,
      _taskTabId: taskTabId,
    }),
    startTracking: (tabId, activeSession) => sendTrackingMessage(tabId, {
      type: 'START_TRACKING',
      session: activeSession,
    }),
    stopTracking: (tabId) => sendTabMessage(tabId, { type: 'STOP_TRACKING' }),
    cancelRecording,
    clearSession: () => chrome.storage.local.remove([
      '_tracking', '_originTime', '_viewStart', '_taskTabId',
    ]),
  }, {
    tabId: plan.tabId,
    session,
  });

  await chrome.storage.local.remove(['_pendingTaskTabId']);
  return { status: 'recording', ...result };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'tasks', 'currentTaskIndex'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === 'APPEND_INTERACTIONS') {
    if (Array.isArray(msg.interactions)) {
      collectedInteractions.push(...msg.interactions);
    }
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks'], (data) => {
      if (!data.participantId || !data.tasks) return;
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      fetch(`${serverUrl}/api/partial-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: data.participantId,
          trialIndex: (data.currentTaskIndex || 0) + 1,
          view_start: msg.viewStart,
          interactions: collectedInteractions,
        }),
      }).catch(() => {});
    });
    return false;
  }

  if (msg.type === 'START_TASK_FLOW') {
    startTaskFlow(msg)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'COMPLETE_TASK') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks'], async (data) => {
      if (!data.participantId || !data.tasks) {
        sendResponse({ ok: false, error: 'Not configured' });
        return;
      }
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      const allInteractions = [...collectedInteractions];
      const viewStart = msg.viewStart;
      const durationMs = msg.durationMs || 0;
      const taskIndex = (data.currentTaskIndex || 0) + 1;
      const participantId = data.participantId;

      try {
        // Stop recording and require a successful upload before completing the task.
        const recordingResult = await stopRecording(serverUrl, participantId, taskIndex);
        if (!recordingResult.ok) {
          throw new Error(`Recording upload failed: ${recordingResult.error || 'unknown error'}`);
        }

        const res = await fetch(`${serverUrl}/api/complete-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId,
            trialIndex: taskIndex,
            view_start: viewStart,
            duration_ms: durationMs,
            interactions: allInteractions,
          }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        collectedInteractions = [];

        const nextIndex = taskIndex;
        if (nextIndex < data.tasks.length) {
          await chrome.storage.local.set({ currentTaskIndex: nextIndex });
        }
        sendResponse({ ok: true, finished: nextIndex >= data.tasks.length });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  if (msg.type === 'SKIP_TASK') {
    (async () => {
      chrome.storage.local.get(['serverUrl', 'participantId', 'currentTaskIndex'], async (data) => {
        const taskIndex = (data.currentTaskIndex || 0) + 1;
        await stopRecording(data.serverUrl || DEFAULT_SERVER, data.participantId, taskIndex);
      });
    })();
    return false;
  }

  if (msg.type === 'CLEAR_INTERACTIONS') {
    collectedInteractions = [];
    return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (!data.serverUrl) {
      chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });
    }
  });
});
