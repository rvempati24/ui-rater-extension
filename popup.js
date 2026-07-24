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
  $('headerResetBtn').classList.add('hidden');
}

function showTask() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.remove('hidden');
  $('feedbackScreen').classList.add('hidden');
  $('doneScreen').classList.add('hidden');
  $('headerResetBtn').classList.remove('hidden');
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
  $('headerResetBtn').classList.remove('hidden');
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
  $('headerResetBtn').classList.remove('hidden');
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

// Begin task — start recording on the current tab, then open the site
$('beginTaskBtn').addEventListener('click', async () => {
  const task = state.tasks[state.currentTaskIndex];

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const now = Date.now();
  const viewStart = new Date().toISOString();

  // Persist tracking state BEFORE navigating so the content script auto-resumes.
  await chrome.storage.local.set({
    _tracking: true,
    _originTime: now,
    _viewStart: viewStart,
  });

  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });

  showDuringTrack();

  // Start tab video recording on the current (capturable, invoked) tab.
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'BEGIN_TASK', tabId: tab.id },
      (r) => resolve(chrome.runtime.lastError ? null : r),
    );
  });

  if (!res?.ok) {
    showError(
      'taskError',
      `Screen recording could not start${res?.error ? `: ${res.error}` : ''}. Your interactions are still being tracked.`,
    );
  }

  // Now navigate to the task site (capture persists across navigation), or start
  // tracking in place when the task runs on the current page.
  if (task.site_url) {
    await chrome.tabs.update(tab.id, { url: task.site_url });
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'START_TRACKING' }, () => {
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
});

// Done — hand off to the background, which stops tracking + recording and opens
// the review/annotation editor window (same path the on-page Done control uses).
$('doneBtn').addEventListener('click', async () => {
  $('doneBtn').disabled = true;
  $('doneBtn').textContent = 'Stopping…';

  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FINISH_TASK' }, (r) => resolve(chrome.runtime.lastError ? null : r));
  });

  if (res?.ok) {
    window.close();
  } else {
    showError('taskError', res?.error || 'Failed to finish the task.');
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
    const stored = await chrome.storage.local.get(['_durationMs', '_viewStart']);

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'COMPLETE_TASK',
        viewStart: stored._viewStart,
        durationMs: stored._durationMs,
        feedback: feedback || '',
      }, resolve);
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || 'Failed to save.');
    }

    await chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart', '_durationMs']);

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

// Skip task — background stops recording and advances to the next task.
$('skipBtn').addEventListener('click', async () => {
  $('skipBtn').disabled = true;
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SKIP_TASK_FULL' }, (r) => resolve(chrome.runtime.lastError ? null : r));
  });
  $('skipBtn').disabled = false;

  const data = await chrome.storage.local.get(['currentTaskIndex']);
  state.currentTaskIndex = data.currentTaskIndex ?? (state.currentTaskIndex + 1);

  if (res?.finished || state.currentTaskIndex >= state.tasks.length) {
    showDone();
  } else {
    showTask();
  }
});

// Reset (shared logic for both reset buttons)
async function resetStudy() {
  await chrome.storage.local.remove([
    'participantId', 'tasks', 'currentTaskIndex',
    '_tracking', '_originTime', '_viewStart', '_durationMs', '_snapshotInteractions',
  ]);
  chrome.runtime.sendMessage({ type: 'CLEAR_INTERACTIONS' });
  state = { participantId: '', serverUrl: state.serverUrl, tasks: null, currentTaskIndex: 0 };
  showSetup();
}

$('resetBtn').addEventListener('click', resetStudy);

$('headerResetBtn').addEventListener('click', async () => {
  if (confirm('Reset the study? This will return you to the setup screen.')) {
    resetStudy();
  }
});

// Keep the persistent side panel in sync when the editor window advances the
// task (it updates currentTaskIndex and clears the tracking flag from storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('currentTaskIndex' in changes || 'tasks' in changes || 'participantId' in changes) {
    init();
  }
});

init();
