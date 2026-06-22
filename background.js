const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'tasks', 'currentTaskIndex', 'taskData'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === 'SAVE_INTERACTIONS') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks'], (data) => {
      if (!data.participantId || !data.tasks) return;
      const task = data.tasks[data.currentTaskIndex];
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      fetch(`${serverUrl}/api/partial-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: data.participantId,
          trialIndex: data.currentTaskIndex + 1,
          view_start: msg.viewStart,
          interactions: msg.interactions,
        }),
      }).catch(() => {});
    });
    return false;
  }

  if (msg.type === 'COMPLETE_TASK') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks'], async (data) => {
      if (!data.participantId || !data.tasks) {
        sendResponse({ ok: false, error: 'Not configured' });
        return;
      }
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      try {
        const res = await fetch(`${serverUrl}/api/complete-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId: data.participantId,
            trialIndex: data.currentTaskIndex + 1,
            view_start: msg.viewStart,
            duration_ms: msg.durationMs,
            interactions: msg.interactions,
          }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        const nextIndex = data.currentTaskIndex + 1;
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
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (!data.serverUrl) {
      chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });
    }
  });
});
