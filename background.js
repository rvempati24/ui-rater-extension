importScripts('task-session.js');

const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';
const ACTIVE_SESSION_KEY = '_activeSession';
const WORKFLOW_KEY = '_taskWorkflow';
// A task normally produces paired before/after images for important actions.
// This is a last-resort storage guard, not an analysis sampling policy.
const MAX_SNAPSHOTS = 120;
const SNAPSHOT_DEBOUNCE_MS = 400;

let sessionWriteLock = Promise.resolve();
let snapshotWriteLock = Promise.resolve();
let workflowOperationLock = Promise.resolve();

function withWorkflowOperation(fn) {
  const next = workflowOperationLock.then(fn, fn);
  workflowOperationLock = next.catch(() => {});
  return next;
}

async function setWorkflow(patch) {
  const data = await chrome.storage.local.get([WORKFLOW_KEY]);
  const workflow = { ...(data[WORKFLOW_KEY] || {}), ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [WORKFLOW_KEY]: workflow });
  return workflow;
}

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
        resolve();
      } else reject(new Error(res?.error || 'Failed to start recording'));
    });
  });
}

async function stopRecording(serverUrl, participantId, taskIndex, managed = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING', serverUrl, participantId, taskIndex, ...managed,
    }, (res) => {
      resolve(res || { ok: false, error: 'Recorder did not respond' });
    });
  });
}

async function cancelRecording() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' }, (res) => {
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

async function reusePendingTask(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await chrome.storage.local.set({ _pendingTaskTabId: tabId });
  return { status: 'pending', tabId };
}

async function createSession() {
  const data = await chrome.storage.local.get([
    'participantId', 'serverUrl', 'runId', 'tasks', 'currentTaskIndex', WORKFLOW_KEY,
  ]);
  const task = data.tasks?.[data.currentTaskIndex || 0];
  if (!data.participantId || !data.runId || !task?.assignment_id) {
    throw new Error('Participant run is not configured');
  }
  const session = {
    sessionId: data[WORKFLOW_KEY]?.sessionId || crypto.randomUUID(),
    originTime: Date.now(),
    viewStart: new Date().toISOString(),
  };
  const response = await fetch(
    `${data.serverUrl || DEFAULT_SERVER}/api/assignments/${encodeURIComponent(task.assignment_id)}/attempts`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId: data.participantId, runId: data.runId, sessionId: session.sessionId }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Could not create attempt: ${response.status}`);
  return {
    ...session, runId: data.runId, assignmentId: task.assignment_id,
    attemptId: body.attempt.attempt_id, attemptNumber: body.attempt.attempt_number,
  };
}

async function startTaskFlow(msg) {
  const stored = await chrome.storage.local.get([
    '_pendingTaskTabId', '_runTaskTabId', ACTIVE_SESSION_KEY, WORKFLOW_KEY,
  ]);
  const existingPhase = stored[WORKFLOW_KEY]?.phase;
  if (stored[ACTIVE_SESSION_KEY]
    || (existingPhase && !['starting', 'start_failed'].includes(existingPhase))) {
    throw new Error('Finish or recover the current attempt first');
  }
  if (existingPhase === 'starting') await cancelRecording();
  const plan = UiRaterTaskSession.planTaskStart({
    currentTab: msg.currentTab,
    siteUrl: msg.siteUrl,
    pendingTaskTabId: stored._pendingTaskTabId,
    reusableTaskTabId: stored._runTaskTabId,
  });

  if (plan.action === 'open') return openPendingTask(plan.createOptions);
  if (plan.action === 'reuse') {
    try {
      return await reusePendingTask(plan.tabId, plan.url);
    } catch {
      await chrome.storage.local.remove(['_runTaskTabId']);
      const retryPlan = UiRaterTaskSession.planTaskStart({
        currentTab: msg.currentTab,
        siteUrl: msg.siteUrl,
      });
      return openPendingTask(retryPlan.createOptions);
    }
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

  const sessionId = stored[WORKFLOW_KEY]?.sessionId || crypto.randomUUID();
  await setWorkflow({ phase: 'starting', sessionId, lastError: undefined });
  let attemptInvalidated = false;
  try {
    const result = await UiRaterTaskSession.beginRecordingOnTab({
    startRecording,
    createSession,
    storeSession: async ({ sessionId, originTime, viewStart, taskTabId, runId, assignmentId, attemptId, attemptNumber }) => {
      const taskTab = await chrome.tabs.get(taskTabId);
      await chrome.storage.local.set({
        _tracking: true,
        _sessionId: sessionId,
        _originTime: originTime,
        _viewStart: viewStart,
        _taskTabId: taskTabId,
        _runTaskTabId: taskTabId,
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
          runId, assignmentId, attemptId, attemptNumber,
        },
        [WORKFLOW_KEY]: {
          phase: 'recording', sessionId, runId, assignmentId, attemptId, attemptNumber,
          updatedAt: new Date().toISOString(),
        },
      });
    },
    startTracking: (tabId, activeSession) => sendTrackingMessage(tabId, {
      type: 'START_TRACKING', session: activeSession,
    }),
    stopTracking: (tabId) => sendTabMessage(tabId, { type: 'STOP_TRACKING' }),
    cancelRecording,
    clearSession: async (failedSession) => {
      const data = await chrome.storage.local.get(['participantId', 'serverUrl']);
      let invalidated = false;
      if (failedSession?.attemptId) {
        const response = await fetch(`${data.serverUrl || DEFAULT_SERVER}/api/attempts/${encodeURIComponent(failedSession.attemptId)}/outcome`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId: data.participantId, runId: failedSession.runId,
            assignmentId: failedSession.assignmentId, outcome: 'recording_problem',
            reason: 'recording_start_failed',
          }),
        }).catch(() => null);
        invalidated = Boolean(response?.ok);
      }
      if (invalidated) {
        await chrome.storage.local.remove([
          '_tracking', '_sessionId', '_originTime', '_viewStart', '_taskTabId', ACTIVE_SESSION_KEY,
          WORKFLOW_KEY,
        ]);
        attemptInvalidated = true;
      } else {
        await chrome.storage.local.set({ _tracking: false });
      }
    },
  }, { tabId: plan.tabId });

    await chrome.storage.local.remove(['_pendingTaskTabId']);
    return { status: 'recording', ...result };
  } catch (error) {
    if (!attemptInvalidated) {
      const recovery = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
      if (recovery[ACTIVE_SESSION_KEY]) {
        const failed = recovery[ACTIVE_SESSION_KEY];
        const attemptIdentity = {
          participantId: (await chrome.storage.local.get(['participantId'])).participantId,
          runId: failed.runId, assignmentId: failed.assignmentId, attemptId: failed.attemptId,
          attemptNumber: failed.attemptNumber, sessionId: failed.sessionId,
        };
        await chrome.storage.local.set({ [WORKFLOW_KEY]: {
          phase: 'submitting_outcome', ...attemptIdentity,
          intendedOutcome: 'recording_problem', reason: 'recording_start_failed',
          lastError: error.message, updatedAt: new Date().toISOString(),
        } });
      } else {
        await setWorkflow({ phase: 'start_failed', sessionId, lastError: error.message });
      }
    }
    throw error;
  }
}

function withSessionWrite(fn) {
  const next = sessionWriteLock.then(fn);
  sessionWriteLock = next.catch(() => {});
  return next;
}

function withSnapshotWrite(fn) {
  const next = snapshotWriteLock.then(fn);
  snapshotWriteLock = next.catch(() => {});
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
      fetch(`${serverUrl}/api/partial-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          participantId: data.participantId,
          trialIndex: (data.currentTaskIndex || 0) + 1,
          view_start: session.viewStart,
          interactions: session.interactions,
          runId: session.runId,
          assignmentId: session.assignmentId,
          attemptId: session.attemptId,
          attemptNumber: session.attemptNumber,
        }),
      }).catch(() => {});
    }
    return { ok: true, interactionCount: session.interactions.length };
  });
}

async function captureSnapshot(msg, sender) {
  return withSnapshotWrite(async () => {
    const data = await chrome.storage.local.get([ACTIVE_SESSION_KEY, 'serverUrl']);
    const session = data[ACTIVE_SESSION_KEY];
    if (!session) return { ok: false, error: 'No active session' };
    if (sender.tab?.id !== session.taskTabId) return { ok: false, error: 'Snapshot came from another tab' };
    if (!sender.tab.active) return { ok: false, error: 'Task tab is not active' };

    const now = Date.now();
    if (session.snapshotCount >= MAX_SNAPSHOTS) return { ok: true, skipped: 'limit' };
    const isActionPair = msg.phase === 'before' || msg.phase === 'after';
    if (now - session.lastSnapshotAt < SNAPSHOT_DEBOUNCE_MS
      && msg.reason !== 'task-end' && !isActionPair) {
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
        actionId: msg.actionId,
        phase: msg.phase,
        eventKind: msg.eventKind,
        ts: msg.ts,
        url: msg.url,
        title: msg.title,
        viewport: msg.viewport,
        scroll: msg.scroll,
        elements: msg.elements || [],
      }),
    });
    if (!response.ok) throw new Error(`Snapshot upload failed: ${response.status}`);

    await withSessionWrite(async () => {
      const latestData = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
      const updated = UiRaterTaskSession.mergeSnapshotProgress(
        latestData[ACTIVE_SESSION_KEY], session.sessionId, session.snapshotCount + 1, now
      );
      // Never resurrect a finalized session or overwrite interactions that arrived
      // while the screenshot upload was in flight.
      if (updated) await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: updated });
    });
    return { ok: true, snapshotId };
  });
}

async function finishAttemptEvidence(msg) {
  const data = await chrome.storage.local.get([
    ACTIVE_SESSION_KEY, 'participantId', 'serverUrl', 'currentTaskIndex', 'tasks',
  ]);
  const session = data[ACTIVE_SESSION_KEY];
  if (!data.participantId || !data.tasks || !session) throw new Error('Not configured');

  const serverUrl = data.serverUrl || DEFAULT_SERVER;
  const taskIndex = (data.currentTaskIndex || 0) + 1;
  const participantId = data.participantId;
  await setWorkflow({
    phase: 'finalizing_evidence',
    sessionId: session.sessionId,
    runId: session.runId,
    assignmentId: session.assignmentId,
    attemptId: session.attemptId,
    attemptNumber: session.attemptNumber,
    intendedOutcome: msg.outcome,
    reason: msg.reason,
    viewStart: session.viewStart || msg.viewStart,
    durationMs: msg.durationMs || 0,
    finalFlushStatus: msg.finalFlushStatus,
    finalFlushError: msg.finalFlushError,
    lastError: undefined,
  });

  const managed = {
    runId: session.runId, assignmentId: session.assignmentId, attemptId: session.attemptId,
  };
  const recordingResult = await stopRecording(serverUrl, participantId, taskIndex, managed);
  let recordingStatus = 'saved';
  let recordingError;
  if (!recordingResult.ok) {
    recordingError = recordingResult.error || 'Recording upload failed';
    if (msg.outcome === 'recording_problem' && recordingResult.retryable !== true) {
      // No recorder or pending blob remains to retry. Keep the other evidence and
      // make the missing video explicit instead of trapping the participant.
      recordingStatus = 'missing';
    } else {
      await setWorkflow({ lastError: recordingError });
      throw new Error(`Recording upload failed: ${recordingError}`);
    }
  }

  await snapshotWriteLock;
  await sessionWriteLock;
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
      runId: finalSession.runId,
      assignmentId: finalSession.assignmentId,
      attemptId: finalSession.attemptId,
      attemptNumber: finalSession.attemptNumber,
      recording_status: recordingStatus,
      recording_error: recordingError,
      final_flush_status: msg.finalFlushStatus || 'complete',
      final_flush_error: msg.finalFlushError,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await setWorkflow({ lastError: body.error || `Server error: ${res.status}` });
    throw new Error(body.error || `Server error: ${res.status}`);
  }

  const attemptIdentity = {
    participantId,
    runId: finalSession.runId,
    assignmentId: finalSession.assignmentId,
    attemptId: finalSession.attemptId,
    attemptNumber: finalSession.attemptNumber,
    sessionId: finalSession.sessionId,
  };
  if (!body.pendingOutcome) {
    let refreshed = null;
    try {
      const taskResponse = await fetch(
        `${serverUrl}/api/tasks?participantId=${encodeURIComponent(participantId)}`
          + `&runId=${encodeURIComponent(finalSession.runId)}`
      );
      if (taskResponse.ok) refreshed = await taskResponse.json();
    } catch { /* the canonical outcome is already saved */ }
    if (refreshed?.tasks) {
      await chrome.storage.local.set({
        tasks: refreshed.tasks, currentTaskIndex: refreshed.currentTaskIndex,
      });
    }
    await chrome.storage.local.remove([
      ACTIVE_SESSION_KEY, WORKFLOW_KEY, '_sessionId', '_originTime', '_viewStart',
      '_taskTabId', '_pendingTaskTabId', '_tracking',
    ]);
    return {
      ok: true, finalized: true, attemptStatus: body.attemptStatus, outcome: body.outcome,
      currentTaskIndex: refreshed?.currentTaskIndex,
      finished: refreshed ? refreshed.currentTaskIndex >= refreshed.tasks.length : false,
    };
  }
  await chrome.storage.local.set({
    _tracking: false,
    [WORKFLOW_KEY]: {
      phase: 'awaiting_outcome',
      ...attemptIdentity,
      intendedOutcome: msg.outcome,
      reason: msg.reason,
      updatedAt: new Date().toISOString(),
    },
  });
  await chrome.storage.local.remove([
    ACTIVE_SESSION_KEY, '_sessionId', '_originTime', '_viewStart', '_taskTabId', '_pendingTaskTabId',
  ]);
  return {
    ok: true,
    sessionId: finalSession.sessionId,
    attemptStatus: body.attemptStatus,
    pendingOutcome: true,
  };
}

async function prepareFinalization(msg) {
  const data = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
  const session = data[ACTIVE_SESSION_KEY];
  if (!session) throw new Error('No active attempt to finalize');
  await setWorkflow({
    phase: 'finalizing_evidence', sessionId: session.sessionId,
    runId: session.runId, assignmentId: session.assignmentId,
    attemptId: session.attemptId, attemptNumber: session.attemptNumber,
    intendedOutcome: msg.outcome, reason: msg.reason,
    viewStart: msg.viewStart || session.viewStart, durationMs: msg.durationMs || 0,
    finalFlushStatus: msg.finalFlushStatus, finalFlushError: msg.finalFlushError,
    lastError: undefined,
  });
  return { ok: true };
}

async function submitAttemptOutcome(outcome, reason) {
  const data = await chrome.storage.local.get([
    'serverUrl', 'tasks', 'currentTaskIndex', WORKFLOW_KEY,
  ]);
  const pending = data[WORKFLOW_KEY];
  if (!pending?.attemptId) throw new Error('No attempt is waiting for an outcome');
  const intendedOutcome = data[WORKFLOW_KEY]?.intendedOutcome;
  if (intendedOutcome && intendedOutcome !== outcome) {
    throw new Error(`Outcome ${intendedOutcome} is already being submitted`);
  }
  await setWorkflow({
    phase: 'submitting_outcome',
    intendedOutcome: outcome, reason, lastError: undefined,
  });
  const serverUrl = data.serverUrl || DEFAULT_SERVER;
  const response = await fetch(`${serverUrl}/api/attempts/${encodeURIComponent(pending.attemptId)}/outcome`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      participantId: pending.participantId,
      runId: pending.runId,
      assignmentId: pending.assignmentId,
      outcome,
      reason,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    await setWorkflow({ lastError: body.error || `Could not save outcome: ${response.status}` });
    throw new Error(body.error || `Could not save outcome: ${response.status}`);
  }
  const tasks = Array.isArray(data.tasks) ? [...data.tasks] : [];
  const currentIndex = data.currentTaskIndex || 0;
  if (tasks[currentIndex]) {
    tasks[currentIndex] = {
      ...tasks[currentIndex],
      status: body.task.status,
      outcome: body.task.outcome,
      reason: body.task.reason,
      accepted_attempt_id: body.task.accepted_attempt_id,
    };
  }
  let nextIndex = currentIndex;
  if (body.advance) {
    nextIndex += 1;
    while (nextIndex < tasks.length && tasks[nextIndex]?.status !== 'pending') nextIndex += 1;
  }
  await chrome.storage.local.set({ tasks, currentTaskIndex: nextIndex });
  await chrome.storage.local.remove([
    WORKFLOW_KEY, ACTIVE_SESSION_KEY, '_tracking', '_sessionId', '_originTime',
    '_viewStart', '_taskTabId',
  ]);
  if (body.runCompleted || nextIndex >= tasks.length) {
    await chrome.storage.local.remove(['_runTaskTabId', '_pendingTaskTabId']);
  }
  return {
    ok: true,
    outcome,
    advance: body.advance,
    retry: body.retry,
    runCompleted: body.runCompleted,
    currentTaskIndex: nextIndex,
    finished: body.runCompleted || nextIndex >= tasks.length,
  };
}

async function finishWithOutcome(msg) {
  const stored = await chrome.storage.local.get([WORKFLOW_KEY]);
  const phase = stored[WORKFLOW_KEY]?.phase;
  await setWorkflow({ intendedOutcome: msg.outcome, reason: msg.reason });
  if (!['awaiting_outcome', 'awaiting_retry_choice', 'submitting_outcome'].includes(phase)) {
    await finishAttemptEvidence(msg);
  }
  return submitAttemptOutcome(msg.outcome, msg.reason);
}

async function setRetryChoice(reason) {
  const data = await chrome.storage.local.get([WORKFLOW_KEY]);
  const workflow = data[WORKFLOW_KEY];
  if (workflow?.phase !== 'awaiting_outcome' || !workflow.attemptId) {
    throw new Error('No attempt is waiting for a retry decision');
  }
  await setWorkflow({
    phase: 'awaiting_retry_choice', reason,
    intendedOutcome: undefined, lastError: undefined,
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'APPEND_INTERACTIONS') {
    appendInteractions(msg).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_SNAPSHOT') {
    captureSnapshot(msg, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'START_TASK_FLOW') {
    withWorkflowOperation(() => startTaskFlow(msg)).then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'COMPLETE_TASK') {
    withWorkflowOperation(() => finishAttemptEvidence(msg)).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'PREPARE_FINALIZATION') {
    withWorkflowOperation(() => prepareFinalization(msg)).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'SUBMIT_OUTCOME') {
    withWorkflowOperation(() => submitAttemptOutcome(msg.outcome, msg.reason)).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'FINISH_WITH_OUTCOME') {
    withWorkflowOperation(() => finishWithOutcome(msg)).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'SET_RETRY_CHOICE') {
    withWorkflowOperation(() => setRetryChoice(msg.reason)).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (!data.serverUrl) chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });
  });
});
