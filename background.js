importScripts('task-session.js');

const DEFAULT_SERVER = 'http://127.0.0.1:3000';
const ACTIVE_SESSION_KEY = '_activeSession';
const WORKFLOW_KEY = '_taskWorkflow';
// A task normally produces paired before/after images for important actions.
// This is a last-resort storage guard, not an analysis sampling policy.
const MAX_SNAPSHOTS = 120;
const RESERVED_TASK_END_SNAPSHOTS = 1;
const SNAPSHOT_DEBOUNCE_MS = 400;

let sessionWriteLock = Promise.resolve();
let snapshotUploadLock = Promise.resolve();
let workflowOperationLock = Promise.resolve();
const captureLocks = new Map();

function openCaptureDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ui-rater-captures-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('captures', { keyPath: 'captureRequestId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function captureStore(mode, operation) {
  const db = await openCaptureDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('captures', mode);
      const request = operation(transaction.objectStore('captures'));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Capture transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function persistCapture(record) {
  await captureStore('readwrite', (store) => store.put(record));
}

async function deleteCapture(captureRequestId) {
  await captureStore('readwrite', (store) => store.delete(captureRequestId));
}

async function pendingCaptures() {
  return captureStore('readonly', (store) => store.getAll());
}

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

async function installNavigationBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['navigation-bridge.js'], world: 'MAIN',
    });
  } catch {
    // History instrumentation is supplementary; trace ownership and ordinary
    // DOM event capture remain active if a page rejects MAIN-world injection.
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
    'participantId', 'serverUrl', 'runId', 'runCapability', 'tasks', 'currentTaskIndex', WORKFLOW_KEY,
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
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${data.runCapability || ''}`,
      },
      body: JSON.stringify({ participantId: data.participantId, runId: data.runId, sessionId: session.sessionId }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Could not create attempt: ${response.status}`);
  return {
    ...session, runId: data.runId, assignmentId: task.assignment_id,
    attemptId: body.attempt.attempt_id, attemptNumber: body.attempt.attempt_number,
    attemptCapability: body.attemptCapability,
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
    storeSession: async ({
      sessionId, originTime, viewStart, taskTabId, runId, assignmentId,
      attemptId, attemptNumber, attemptCapability,
    }) => {
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
          runId, assignmentId, attemptId, attemptNumber, attemptCapability,
        },
        [WORKFLOW_KEY]: {
          phase: 'recording', sessionId, runId, assignmentId, attemptId, attemptNumber,
          attemptCapability,
          updatedAt: new Date().toISOString(),
        },
      });
    },
    startTracking: async (tabId, activeSession) => {
      await installNavigationBridge(tabId);
      return sendTrackingMessage(tabId, {
        type: 'START_TRACKING', session: activeSession,
      });
    },
    stopTracking: (tabId) => sendTabMessage(tabId, { type: 'STOP_TRACKING' }),
    cancelRecording,
    clearSession: async (failedSession) => {
      const data = await chrome.storage.local.get(['participantId', 'serverUrl']);
      let invalidated = false;
      if (failedSession?.attemptId) {
        const response = await fetch(`${data.serverUrl || DEFAULT_SERVER}/api/attempts/${encodeURIComponent(failedSession.attemptId)}/outcome`, {
          method: 'POST', headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${failedSession.attemptCapability || ''}`,
          },
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
          attemptCapability: failed.attemptCapability,
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

function withSnapshotUpload(fn) {
  const next = snapshotUploadLock.then(fn, fn);
  snapshotUploadLock = next.catch(() => {});
  return next;
}

function withCaptureLock(windowId, fn) {
  const previous = captureLocks.get(windowId) || Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.then(() => {}, () => {});
  captureLocks.set(windowId, settled);
  return next.finally(() => {
    if (captureLocks.get(windowId) === settled) captureLocks.delete(windowId);
  });
}

async function activeTabId(windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  return tabs[0]?.id;
}

async function uploadCapture(record) {
  const response = await fetch(`${record.serverUrl}/api/sessions/${record.sessionId}/snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${record.attemptCapability || ''}`,
    },
    body: JSON.stringify(record.body),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseBody.error || `Snapshot upload failed: ${response.status}`);
  const snapshotId = responseBody.snapshot?.snapshot_id;
  await withSessionWrite(async () => {
    const latestData = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
    const latest = latestData[ACTIVE_SESSION_KEY];
    if (!latest || latest.sessionId !== record.sessionId) return;
    await chrome.storage.local.set({
      [ACTIVE_SESSION_KEY]: {
        ...latest,
        snapshotCount: Math.max(latest.snapshotCount || 0, Number(snapshotId?.slice(1)) || 0),
        pendingSnapshotCount: Math.max(0, (latest.pendingSnapshotCount || 1) - 1),
        captureFailures: (latest.captureFailures || []).filter(
          (failure) => failure.capture_request_id !== record.captureRequestId
        ),
      },
    });
  });
  // Keep the durable queue entry until both the remote acknowledgement and
  // the local projection update complete. Re-uploading is idempotent.
  await deleteCapture(record.captureRequestId);
  return { ok: true, snapshotId, capturedTs: record.capturedTs };
}

async function drainPendingCaptures() {
  const records = await pendingCaptures();
  for (const record of records) await withSnapshotUpload(() => uploadCapture(record));
}

async function postTraceBatch(data, session, batchId, events) {
  const serverUrl = data.serverUrl || DEFAULT_SERVER;
  const response = await fetch(`${serverUrl}/api/partial-save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.attemptCapability || ''}`,
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      participantId: data.participantId,
      trialIndex: (data.currentTaskIndex || 0) + 1,
      view_start: session.viewStart,
      batchId,
      events,
      runId: session.runId,
      assignmentId: session.assignmentId,
      attemptId: session.attemptId,
      attemptNumber: session.attemptNumber,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Partial save failed: ${response.status}`);
  return body;
}

async function reconcileTraceWithServer(data, session) {
  const events = Array.isArray(session.interactions) ? session.interactions : [];
  const chunkSize = 500;
  for (let start = 0; start < events.length; start += chunkSize) {
    const chunk = events.slice(start, start + chunkSize);
    const last = chunk.at(-1)?.event_id || chunk.at(-1)?.seq || start + chunk.length;
    const batchId = `${session.sessionId}:reconcile:${start}:${chunk.length}:${String(last).slice(-48)}`;
    await postTraceBatch(data, session, batchId, chunk);
  }
}

async function appendInteractions(msg, sender) {
  return withSessionWrite(async () => {
    const data = await chrome.storage.local.get([
      ACTIVE_SESSION_KEY, 'participantId', 'serverUrl', 'currentTaskIndex', 'tasks',
    ]);
    const session = data[ACTIVE_SESSION_KEY];
    if (!session || !Array.isArray(msg.interactions)) return { ok: false, error: 'No active session' };
    if (sender.tab?.id !== session.taskTabId || msg.sessionId !== session.sessionId) {
      return { ok: false, error: 'Interaction batch does not belong to the active task tab/session' };
    }
    if (typeof msg.batchId !== 'string' || !msg.batchId.startsWith(`${session.sessionId}:`)) {
      return { ok: false, error: 'Interaction batch has no valid batchId' };
    }

    const interactions = Array.isArray(session.interactions) ? session.interactions : [];
    const known = new Set(interactions.map((event) => event.event_id).filter(Boolean));
    let nextEventSeq = Number.isInteger(session.nextEventSeq)
      ? session.nextEventSeq : interactions.reduce(
        (highest, event) => Math.max(highest, Number(event.seq) || 0), 0
      ) + 1;
    for (const event of msg.interactions) {
      if (event.event_id && known.has(event.event_id)) continue;
      if (event.event_id) known.add(event.event_id);
      interactions.push({ ...event, seq: nextEventSeq++ });
    }
    session.interactions = interactions;
    session.nextEventSeq = nextEventSeq;
    // Persist locally before the network acknowledgement. If a navigation
    // destroys the content script, the service worker still retains the batch.
    await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: session });

    if (data.participantId && data.tasks) {
      await postTraceBatch(data, session, msg.batchId, msg.interactions);
    }
    return { ok: true, interactionCount: session.interactions.length };
  });
}

async function rememberCaptureFailure(sessionId, captureRequestId, reason, error) {
  await withSessionWrite(async () => {
    const data = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
    const session = data[ACTIVE_SESSION_KEY];
    if (!session || session.sessionId !== sessionId) return;
    const failures = (session.captureFailures || []).filter(
      (failure) => failure.capture_request_id !== captureRequestId
    );
    failures.push({
      capture_request_id: captureRequestId,
      reason,
      error: String(error?.message || error).slice(0, 300),
    });
    await chrome.storage.local.set({
      [ACTIVE_SESSION_KEY]: { ...session, captureFailures: failures.slice(-20) },
    });
  });
}

async function captureSnapshot(msg, sender) {
  const initial = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
  const initialSession = initial[ACTIVE_SESSION_KEY];
  if (!initialSession) return { ok: false, error: 'No active session' };
  const captureRequestId = msg.captureRequestId || crypto.randomUUID();
  let prepared;
  try {
    prepared = await withCaptureLock(initialSession.windowId, async () => {
      const data = await chrome.storage.local.get([
        ACTIVE_SESSION_KEY, 'serverUrl', 'participantId',
      ]);
      const session = data[ACTIVE_SESSION_KEY];
      if (!session) return { response: { ok: false, error: 'No active session' } };
      if (msg.sessionId !== session.sessionId || sender.tab?.id !== session.taskTabId) {
        return { response: { ok: false, error: 'Snapshot came from another tab/session' } };
      }
      if (await activeTabId(session.windowId) !== session.taskTabId) {
        throw new Error('Task tab is not active');
      }

      const now = Date.now();
      const isTaskEnd = msg.reason === 'task-end';
      const admission = UiRaterTaskSession.snapshotAdmission(
        (session.snapshotCount || 0) + (session.pendingSnapshotCount || 0),
        MAX_SNAPSHOTS, RESERVED_TASK_END_SNAPSHOTS, isTaskEnd
      );
      if (!admission.allowed) return { response: { ok: true, skipped: admission.reason } };
      const isActionPair = msg.phase === 'before' || msg.phase === 'after';
      if (now - session.lastSnapshotAt < SNAPSHOT_DEBOUNCE_MS
        && msg.reason !== 'task-end' && !isActionPair) {
        return { response: { ok: true, skipped: 'debounced' } };
      }

      const captureStartedAt = Date.now();
      const sessionOriginTime = Number.isFinite(session.originTime)
        ? session.originTime : captureStartedAt - (Number.isFinite(msg.ts) ? msg.ts : 0);
      const captureStartedTs = Math.max(0, captureStartedAt - sessionOriginTime);
      const imageDataUrl = await chrome.tabs.captureVisibleTab(session.windowId, {
        format: 'jpeg', quality: 70,
      });
      const capturedAt = Date.now();
      if (await activeTabId(session.windowId) !== session.taskTabId) {
        throw new Error('Active tab changed during screenshot capture; image was discarded');
      }
      const capturedTs = Math.max(0, capturedAt - sessionOriginTime);
      const upload = {
        captureRequestId,
        sessionId: session.sessionId,
        serverUrl: data.serverUrl || DEFAULT_SERVER,
        attemptCapability: session.attemptCapability,
        capturedTs,
        reason: msg.reason,
        body: {
          captureRequestId,
          participantId: data.participantId,
          runId: session.runId,
          assignmentId: session.assignmentId,
          attemptId: session.attemptId,
          imageDataUrl,
          reason: msg.reason || 'state-change',
          actionId: msg.actionId,
          phase: msg.phase,
          eventKind: msg.eventKind,
          ts: capturedTs,
          requestedTs: msg.ts,
          captureStartedTs,
          captureLatencyMs: Math.max(0, capturedAt - captureStartedAt),
          timingGuarantee: msg.phase === 'before' ? 'best-effort-before' : 'observed-state',
          url: msg.url,
          title: msg.title,
          viewport: msg.viewport,
          scroll: msg.scroll,
          elements: msg.elements || [],
        },
      };
      // Durably queue the image before it becomes eligible for upload.
      await persistCapture(upload);
      await withSessionWrite(async () => {
        const latestData = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
        const latest = latestData[ACTIVE_SESSION_KEY];
        if (!latest || latest.sessionId !== session.sessionId) {
          throw new Error('Attempt finalized while screenshot capture was in progress');
        }
        await chrome.storage.local.set({
          [ACTIVE_SESSION_KEY]: {
            ...latest,
            pendingSnapshotCount: (latest.pendingSnapshotCount || 0) + 1,
            lastSnapshotAt: Math.max(latest.lastSnapshotAt || 0, now),
          },
        });
      });
      return { upload, sessionId: session.sessionId };
    });
  } catch (error) {
    await rememberCaptureFailure(
      initialSession.sessionId, captureRequestId, msg.reason, error
    ).catch(() => {});
    throw error;
  }
  if (prepared.response) return prepared.response;

  // Release the capture lock before network I/O. Uploads remain serialized,
  // but the next important action can capture the correct active tab promptly.
  return withSnapshotUpload(async () => {
    try {
      return await uploadCapture(prepared.upload);
    } catch (error) {
      await rememberCaptureFailure(
        prepared.sessionId, captureRequestId, msg.reason, error
      ).catch(() => {});
      throw error;
    }
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
  await drainPendingCaptures();
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
    finalizationReport: msg.finalizationReport,
    lastError: undefined,
  });

  const managed = {
    runId: session.runId, assignmentId: session.assignmentId, attemptId: session.attemptId,
    attemptCapability: session.attemptCapability,
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

  await Promise.all([...captureLocks.values()]);
  await snapshotUploadLock;
  await sessionWriteLock;
  const latest = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
  const finalSession = latest[ACTIVE_SESSION_KEY] || session;
  await reconcileTraceWithServer(data, finalSession);
  if (msg.finalFlushStatus !== 'unavailable' && msg.finalizationReport?.interaction_flush !== 'acknowledged') {
    throw new Error('Final interaction batch was not acknowledged');
  }
  if (msg.finalFlushStatus !== 'unavailable' && msg.finalizationReport?.task_end_snapshot !== 'acknowledged') {
    throw new Error('Final task screenshot was not acknowledged');
  }
  if ((finalSession.captureFailures || []).length && msg.outcome !== 'recording_problem') {
    throw new Error('One or more important screenshots failed; mark a recording problem or retry finalization');
  }
  if ((finalSession.pendingSnapshotCount || 0) > 0 && msg.outcome !== 'recording_problem') {
    throw new Error('One or more captured screenshots remain unacknowledged');
  }
  if (finalSession.integrityStatus === 'unsupported_multi_tab' && msg.outcome !== 'recording_problem') {
    throw new Error('This attempt opened another tab and is unsupported; mark a recording problem');
  }
  const res = await fetch(`${serverUrl}/api/complete-task`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${finalSession.attemptCapability || ''}`,
    },
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
      finalization_report: msg.finalizationReport,
      intended_outcome: msg.outcome,
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
    attemptCapability: finalSession.attemptCapability,
  };
  if (!body.pendingOutcome) {
    let refreshed = null;
    try {
      const taskResponse = await fetch(
        `${serverUrl}/api/tasks?participantId=${encodeURIComponent(participantId)}`
          + `&runId=${encodeURIComponent(finalSession.runId)}`,
        { headers: { 'Authorization': `Bearer ${(await chrome.storage.local.get(['runCapability'])).runCapability || ''}` } }
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
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${pending.attemptCapability || ''}`,
    },
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
    appendInteractions(msg, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_SNAPSHOT') {
    captureSnapshot(msg, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'RESUME_TRACKING') {
    chrome.storage.local.get([ACTIVE_SESSION_KEY, WORKFLOW_KEY]).then((data) => {
      const session = data[ACTIVE_SESSION_KEY];
      const allowed = session && data[WORKFLOW_KEY]?.phase === 'recording'
        && sender.tab?.id === session.taskTabId;
      if (!allowed) {
        sendResponse({ ok: false, error: 'This tab does not own the active task session' });
        return;
      }
      installNavigationBridge(session.taskTabId).then(() => sendResponse({
          ok: true,
          session: {
            sessionId: session.sessionId,
            originTime: session.originTime,
            viewStart: session.viewStart,
          },
        }));
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
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

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.openerTabId)) return;
  withSessionWrite(async () => {
    const data = await chrome.storage.local.get([ACTIVE_SESSION_KEY, WORKFLOW_KEY]);
    const session = data[ACTIVE_SESSION_KEY];
    if (!session || tab.openerTabId !== session.taskTabId) return;
    const updated = {
      ...session,
      integrityStatus: 'unsupported_multi_tab',
      integrityDetails: {
        openedTabId: tab.id,
        detectedAt: new Date().toISOString(),
      },
    };
    await chrome.storage.local.set({
      [ACTIVE_SESSION_KEY]: updated,
      [WORKFLOW_KEY]: {
        ...(data[WORKFLOW_KEY] || {}),
        integrityStatus: 'unsupported_multi_tab',
        updatedAt: new Date().toISOString(),
      },
    });
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (!data.serverUrl) chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });
  });
  void drainPendingCaptures().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void drainPendingCaptures().catch(() => {});
});
