const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';

const $ = (id) => document.getElementById(id);

let state = {
  participantId: '',
  serverUrl: DEFAULT_SERVER,
  tasks: null,
  currentTaskIndex: 0,
};

async function init() {
  const data = await chrome.storage.local.get([
    'participantId', 'serverUrl', 'tasks', 'currentTaskIndex',
  ]);

  if (data.participantId && data.tasks) {
    state = {
      participantId: data.participantId,
      serverUrl: data.serverUrl || DEFAULT_SERVER,
      tasks: data.tasks,
      currentTaskIndex: data.currentTaskIndex || 0,
    };
    if (state.currentTaskIndex >= state.tasks.length) {
      showDone();
    } else {
      showTask();
    }
  } else {
    showSetup();
    if (data.serverUrl) $('serverInput').value = data.serverUrl;
  }
}

function showSetup() {
  $('setupScreen').classList.remove('hidden');
  $('taskScreen').classList.add('hidden');
  $('doneScreen').classList.add('hidden');
  $('statusDot').classList.add('inactive');
}

function showTask() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.remove('hidden');
  $('doneScreen').classList.add('hidden');
  $('statusDot').classList.remove('inactive');

  const task = state.tasks[state.currentTaskIndex];
  $('progressText').textContent =
    `Task ${state.currentTaskIndex + 1} of ${state.tasks.length}`;
  $('taskPrompt').textContent = task.task_prompt;
  $('taskSite').textContent = task.site_url ? `→ ${task.site_url}` : '';

  // Check if tracking is active from storage (survives popup close/reopen)
  chrome.storage.local.get(['_tracking', '_pendingTaskTabId'], async (data) => {
    if (data._tracking) {
      showDuringTrack();
    } else {
      showPreTrack();
      await updateBeginTaskButton(task, data._pendingTaskTabId);
    }
  });
}

async function updateBeginTaskButton(task, pendingTaskTabId) {
  const button = $('beginTaskBtn');
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const plan = UiRaterTaskSession.planTaskStart({
      currentTab,
      siteUrl: task.site_url,
      pendingTaskTabId,
    });
    button.textContent = plan.action === 'record'
      ? 'Start Recording'
      : plan.action === 'wrong-tab'
        ? 'Return to Task Tab'
        : 'Open Task Website';
  } catch {
    button.textContent = 'Begin Task';
  }
}

function showPreTrack() {
  $('preTrackBtns').classList.remove('hidden');
  $('duringTrackBtns').classList.add('hidden');
  $('trackingStatus').classList.add('hidden');
}

function showDuringTrack() {
  $('preTrackBtns').classList.add('hidden');
  $('duringTrackBtns').classList.remove('hidden');
  $('trackingStatus').classList.remove('hidden');
}

function showDone() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.add('hidden');
  $('doneScreen').classList.remove('hidden');
  $('statusDot').classList.add('inactive');
}

function showError(containerId, msg) {
  const el = $(containerId);
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// Load tasks from server
$('startBtn').addEventListener('click', async () => {
  const pid = $('participantInput').value.trim();
  const server = $('serverInput').value.trim() || DEFAULT_SERVER;

  if (!pid) {
    showError('setupError', 'Please enter a participant ID.');
    return;
  }

  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Loading…';

  try {
    const res = await fetch(`${server}/api/tasks?participantId=${encodeURIComponent(pid)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }
    const data = await res.json();

    if (!data.tasks || data.tasks.length === 0) {
      throw new Error('No tasks found for this participant.');
    }

    state.participantId = pid;
    state.serverUrl = server;
    state.tasks = data.tasks;
    state.currentTaskIndex = data.currentTaskIndex || 0;

    await chrome.storage.local.set({
      participantId: pid,
      serverUrl: server,
      tasks: data.tasks,
      currentTaskIndex: state.currentTaskIndex,
    });

    if (state.currentTaskIndex >= state.tasks.length) {
      showDone();
    } else {
      showTask();
    }
  } catch (err) {
    showError('setupError', err.message);
  } finally {
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Load Tasks';
  }
});

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// First invocation opens the task page; the invocation on that page starts capture.
$('beginTaskBtn').addEventListener('click', async () => {
  const task = state.tasks[state.currentTaskIndex];
  $('beginTaskBtn').disabled = true;
  $('beginTaskBtn').textContent = 'Starting…';

  try {
    if (!task.site_url) throw new Error('This task does not have a website URL.');
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await sendRuntimeMessage({
      type: 'START_TASK_FLOW',
      siteUrl: task.site_url,
      currentTab: {
        id: currentTab.id,
        url: currentTab.url,
        windowId: currentTab.windowId,
      },
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Failed to start the task recording.');
    }
    if (result.status === 'recording') {
      showDuringTrack();
    }
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('beginTaskBtn').disabled = false;
    const pending = await chrome.storage.local.get(['_pendingTaskTabId']);
    await updateBeginTaskButton(task, pending._pendingTaskTabId);
  }
});

// Done — stop tracking and submit
$('doneBtn').addEventListener('click', async () => {
  $('doneBtn').disabled = true;
  $('doneBtn').textContent = 'Saving…';

  try {
    // Tell content script to flush remaining interactions and stop
    const stored = await chrome.storage.local.get([
      '_originTime', '_viewStart', '_taskTabId',
    ]);
    const taskTabId = stored._taskTabId;
    try {
      if (taskTabId) {
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(taskTabId, { type: 'STOP_TRACKING' }, () => resolve());
          setTimeout(resolve, 1000);
        });
      }
    } catch { /* content script may be on a different page */ }

    // Small delay to let the flush arrive at background
    await new Promise(r => setTimeout(r, 300));

    // Read timing from storage (persisted by Begin Task)
    const durationMs = Date.now() - (stored._originTime || Date.now());
    const viewStart = stored._viewStart || new Date().toISOString();

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'COMPLETE_TASK',
        viewStart,
        durationMs,
      }, resolve);
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || 'Failed to save.');
    }

    // Clear tracking state
    await chrome.storage.local.remove([
      '_tracking', '_originTime', '_viewStart', '_taskTabId', '_pendingTaskTabId',
    ]);

    state.currentTaskIndex++;
    if (result.finished) {
      showDone();
    } else {
      showTask();
    }
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('doneBtn').disabled = false;
    $('doneBtn').textContent = 'Done';
  }
});

// Skip task
$('skipBtn').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(['_taskTabId', '_pendingTaskTabId']);
  try {
    if (stored._taskTabId) {
      chrome.tabs.sendMessage(stored._taskTabId, { type: 'STOP_TRACKING' });
    }
  } catch { /* ignore */ }
  chrome.runtime.sendMessage({ type: 'SKIP_TASK' });
  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });
  await chrome.storage.local.remove([
    '_tracking', '_originTime', '_viewStart', '_taskTabId', '_pendingTaskTabId',
  ]);

  state.currentTaskIndex++;
  await chrome.storage.local.set({ currentTaskIndex: state.currentTaskIndex });

  if (state.currentTaskIndex >= state.tasks.length) {
    showDone();
  } else {
    showTask();
  }
});

// Reset
$('resetBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove([
    'participantId', 'tasks', 'currentTaskIndex',
    '_tracking', '_originTime', '_viewStart', '_taskTabId', '_pendingTaskTabId',
  ]);
  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });
  state = { participantId: '', serverUrl: state.serverUrl, tasks: null, currentTaskIndex: 0 };
  showSetup();
});

init();
