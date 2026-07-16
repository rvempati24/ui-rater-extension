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
  $('feedbackScreen').classList.add('hidden');
  $('doneScreen').classList.add('hidden');
  $('statusDot').classList.add('inactive');
}

function showTask() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.remove('hidden');
  $('feedbackScreen').classList.add('hidden');
  $('doneScreen').classList.add('hidden');
  $('statusDot').classList.remove('inactive');

  const task = state.tasks[state.currentTaskIndex];
  $('progressText').textContent =
    `Task ${state.currentTaskIndex + 1} of ${state.tasks.length}`;
  $('taskPrompt').textContent = task.task_prompt;
  $('taskSite').textContent = task.site_url ? `→ ${task.site_url}` : '';

  // Check if tracking is active from storage (survives popup close/reopen)
  chrome.storage.local.get(['_tracking'], (data) => {
    if (data._tracking) {
      showDuringTrack();
    } else {
      showPreTrack();
    }
  });
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

function showFeedback() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.add('hidden');
  $('feedbackScreen').classList.remove('hidden');
  $('doneScreen').classList.add('hidden');
  $('feedbackInput').value = '';
  $('feedbackProgress').textContent =
    `Task ${state.currentTaskIndex + 1} of ${state.tasks.length} — completed`;
}

function showDone() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.add('hidden');
  $('feedbackScreen').classList.add('hidden');
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

// Begin task — open site, start recording and tracking
$('beginTaskBtn').addEventListener('click', async () => {
  const task = state.tasks[state.currentTaskIndex];
  const now = Date.now();
  const viewStart = new Date().toISOString();

  // Persist tracking state BEFORE navigating
  await chrome.storage.local.set({
    _tracking: true,
    _originTime: now,
    _viewStart: viewStart,
  });

  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Start tab video recording
  chrome.runtime.sendMessage({ type: 'BEGIN_TASK', tabId: tab.id }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      console.warn('Recording failed to start:', res?.error || chrome.runtime.lastError?.message);
    }
  });

  if (task.site_url) {
    await chrome.tabs.update(tab.id, { url: task.site_url });
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'START_TRACKING' }, (res) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        }).then(() => {
          chrome.tabs.sendMessage(tab.id, { type: 'START_TRACKING' });
        });
      }
    });
  }

  showDuringTrack();
});

// Done — stop tracking and show feedback screen
$('doneBtn').addEventListener('click', async () => {
  $('doneBtn').disabled = true;
  $('doneBtn').textContent = 'Stopping…';

  try {
    // Tell content script to flush remaining interactions and stop
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'STOP_TRACKING' }, () => resolve());
        setTimeout(resolve, 1000);
      });
    } catch { /* content script may be on a different page */ }

    // Small delay to let the flush arrive at background
    await new Promise(r => setTimeout(r, 300));

    // Show feedback screen before submitting
    showFeedback();
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('doneBtn').disabled = false;
    $('doneBtn').textContent = 'Done';
  }
});

// Submit feedback and complete task
async function submitTaskWithFeedback(feedback) {
  $('submitFeedbackBtn').disabled = true;
  $('skipFeedbackBtn').disabled = true;
  $('submitFeedbackBtn').textContent = 'Saving…';

  try {
    const stored = await chrome.storage.local.get(['_originTime', '_viewStart']);
    const durationMs = Date.now() - (stored._originTime || Date.now());
    const viewStart = stored._viewStart || new Date().toISOString();

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'COMPLETE_TASK',
        viewStart,
        durationMs,
        feedback: feedback || '',
      }, resolve);
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || 'Failed to save.');
    }

    await chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart']);

    state.currentTaskIndex++;
    if (result.finished) {
      showDone();
    } else {
      showTask();
    }
  } catch (err) {
    showError('taskError', err.message);
    showTask();
  } finally {
    $('submitFeedbackBtn').disabled = false;
    $('skipFeedbackBtn').disabled = false;
    $('submitFeedbackBtn').textContent = 'Continue';
  }
}

$('submitFeedbackBtn').addEventListener('click', () => {
  submitTaskWithFeedback($('feedbackInput').value.trim());
});

$('skipFeedbackBtn').addEventListener('click', () => {
  submitTaskWithFeedback('');
});

// Skip task
$('skipBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_TRACKING' });
  } catch { /* ignore */ }
  chrome.runtime.sendMessage({ type: 'SKIP_TASK' });
  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });
  await chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart']);

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
    '_tracking', '_originTime', '_viewStart',
  ]);
  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });
  state = { participantId: '', serverUrl: state.serverUrl, tasks: null, currentTaskIndex: 0 };
  showSetup();
});

init();
