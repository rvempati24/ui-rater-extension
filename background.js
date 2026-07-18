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
  recordingTabId = tabId;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', streamId }, (res) => {
      if (res?.ok) resolve();
      else reject(new Error(res?.error || 'Failed to start recording'));
    });
  });
}

async function stopRecording(serverUrl, participantId, taskIndex) {
  recordingTabId = null;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING',
      serverUrl,
      participantId,
      taskIndex,
    }, (res) => {
      resolve(res?.ok || false);
    });
  });
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

  if (msg.type === 'BEGIN_TASK') {
    (async () => {
      try {
        await startRecording(msg.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'SNAPSHOT_AND_STOP_RECORDING') {
    (async () => {
      try {
        // Save interactions to storage so they survive service worker restart
        await chrome.storage.local.set({ _snapshotInteractions: [...collectedInteractions] });
        collectedInteractions = [];

        // Stop recording and upload video now
        const data = await chrome.storage.local.get(['serverUrl', 'participantId', 'currentTaskIndex']);
        const serverUrl = data.serverUrl || DEFAULT_SERVER;
        const taskIndex = (data.currentTaskIndex || 0) + 1;
        await stopRecording(serverUrl, data.participantId, taskIndex);

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'COMPLETE_TASK') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks', '_snapshotInteractions'], async (data) => {
      if (!data.participantId || !data.tasks) {
        sendResponse({ ok: false, error: 'Not configured' });
        return;
      }
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      const allInteractions = data._snapshotInteractions || [...collectedInteractions];
      const viewStart = msg.viewStart;
      const durationMs = msg.durationMs || 0;
      const feedback = msg.feedback || '';
      const taskIndex = (data.currentTaskIndex || 0) + 1;
      const participantId = data.participantId;

      try {
        const res = await fetch(`${serverUrl}/api/complete-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId,
            trialIndex: taskIndex,
            view_start: viewStart,
            duration_ms: durationMs,
            interactions: allInteractions,
            feedback,
          }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        collectedInteractions = [];
        await chrome.storage.local.remove(['_snapshotInteractions']);

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
