const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';

let collectedInteractions = [];

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
    // Periodic partial save to server
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

  if (msg.type === 'COMPLETE_TASK') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks', '_originTime', '_viewStart'], async (data) => {
      if (!data.participantId || !data.tasks) {
        sendResponse({ ok: false, error: 'Not configured' });
        return;
      }
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      const allInteractions = [...collectedInteractions];
      const viewStart = data._viewStart || msg.viewStart;
      const durationMs = data._originTime ? Date.now() - data._originTime : (msg.durationMs || 0);
      try {
        const res = await fetch(`${serverUrl}/api/complete-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId: data.participantId,
            trialIndex: (data.currentTaskIndex || 0) + 1,
            view_start: viewStart,
            duration_ms: durationMs,
            interactions: allInteractions,
          }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        collectedInteractions = [];

        const nextIndex = (data.currentTaskIndex || 0) + 1;
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
