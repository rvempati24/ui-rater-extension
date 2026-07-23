(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UiRaterTaskSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  function parseTaskUrl(siteUrl) {
    const url = new URL(siteUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Task website must use http:// or https://');
    }
    return url;
  }

  function isCapturableUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function comparableUrl(rawUrl) {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${pathname}${url.search}`;
  }

  function planTaskStart({ currentTab, siteUrl, pendingTaskTabId, reusableTaskTabId }) {
    const taskUrl = parseTaskUrl(siteUrl);
    const currentTabId = currentTab?.id;
    const currentUrl = currentTab?.url || '';
    const currentIsCapturable = Number.isInteger(currentTabId) && isCapturableUrl(currentUrl);
    const isPendingTab = currentIsCapturable && currentTabId === pendingTaskTabId;
    const isTaskUrl = currentIsCapturable
      && comparableUrl(currentUrl) === comparableUrl(taskUrl.href);

    if (isPendingTab || isTaskUrl) {
      return { action: 'record', tabId: currentTabId };
    }

    if (Number.isInteger(pendingTaskTabId)) {
      return { action: 'wrong-tab', pendingTaskTabId };
    }

    if (Number.isInteger(reusableTaskTabId)) {
      return { action: 'reuse', tabId: reusableTaskTabId, url: taskUrl.href };
    }

    const createOptions = { url: taskUrl.href, active: true };
    if (Number.isInteger(currentTab?.windowId)) createOptions.windowId = currentTab.windowId;
    return { action: 'open', createOptions };
  }

  async function beginRecordingOnTab(deps, options) {
    let recordingStarted = false;
    let trackingAttempted = false;
    let session;

    try {
      const recordingStart = await deps.startRecording(options.tabId);
      recordingStarted = true;

      // Timestamp zero is created only after MediaRecorder has acknowledged start.
      session = deps.createSession
        ? await deps.createSession(recordingStart)
        : options.session;
      if (!session) throw new Error('Task session was not created');

      await deps.storeSession({ ...session, taskTabId: options.tabId });

      trackingAttempted = true;
      await deps.startTracking(options.tabId, session);
      return { tabId: options.tabId, sessionId: session.sessionId };
    } catch (error) {
      if (trackingAttempted) await deps.stopTracking(options.tabId).catch(() => {});
      if (recordingStarted) await deps.cancelRecording().catch(() => {});
      if (session) await deps.clearSession(session).catch(() => {});
      throw error;
    }
  }

  function resolveTaskView(state) {
    const phase = state.workflow?.phase;
    if (phase === 'recording' || phase === 'finalizing_evidence'
      || phase === 'submitting_outcome' || phase === 'awaiting_retry_choice'
      || phase === 'starting' || phase === 'start_failed') return phase;
    if (phase === 'awaiting_outcome') {
      return state.workflow?.intendedOutcome ? 'submitting_outcome' : 'awaiting_outcome';
    }
    // Legacy fallback only. A persisted workflow phase is authoritative.
    if (state.tracking) return 'recording';
    if (state.activeSession) return 'finalizing_evidence';
    return 'ready';
  }

  function mergeSnapshotProgress(activeSession, expectedSessionId, snapshotCount, lastSnapshotAt) {
    if (!activeSession || activeSession.sessionId !== expectedSessionId) return null;
    return {
      ...activeSession,
      snapshotCount: Math.max(activeSession.snapshotCount || 0, snapshotCount),
      lastSnapshotAt: Math.max(activeSession.lastSnapshotAt || 0, lastSnapshotAt),
    };
  }

  function snapshotAdmission(snapshotCount, maxSnapshots, reservedTaskEndSnapshots, isTaskEnd) {
    if (snapshotCount >= maxSnapshots) {
      return { allowed: false, reason: 'absolute-limit' };
    }
    if (!isTaskEnd && snapshotCount >= maxSnapshots - reservedTaskEndSnapshots) {
      return { allowed: false, reason: 'reserved-for-task-end' };
    }
    return { allowed: true };
  }

  function numberedAction(controls, key, verb) {
    if (!controls.has(key)) controls.set(key, controls.size + 1);
    return `${verb} ${controls.get(key)}`;
  }

  function interactionLabel(event, controls) {
    const kind = event?.kind;
    if (kind === 'click' || kind === 'iframe_click') {
      const key = `click:${String(event.tag || '')}:${String(event.text || '')}`;
      return numberedAction(controls, key, 'Click control');
    }
    if (kind === 'input' || kind === 'change') {
      const key = `edit:${String(event.tag || '')}`;
      return numberedAction(controls, key, 'Edit field');
    }
    if (kind === 'formsubmit') return 'Submit form';
    if (kind === 'keydown' && ['Enter', 'Tab', 'Escape'].includes(event.key)) {
      return `Press ${event.key}`;
    }
    if (kind === 'navigate' || kind === 'pageload') return 'Navigate to another page';
    if (kind === 'scroll' || kind === 'iframe_scroll') return 'Scroll';
    return null;
  }

  function compareWorkflow(referenceWorkflow, interactions) {
    const reference = Array.isArray(referenceWorkflow)
      ? referenceWorkflow.filter((step) => typeof step === 'string' && step.trim()).slice(0, 10)
      : [];
    const actual = [];
    const controls = new Map();
    for (const event of Array.isArray(interactions) ? interactions : []) {
      const label = interactionLabel(event, controls);
      if (label && label !== actual[actual.length - 1]) actual.push(label);
      if (actual.length >= 30) break;
    }
    const counts = new Map();
    for (const label of actual) counts.set(label, (counts.get(label) || 0) + 1);
    const uxSignals = [];
    for (const [label, count] of counts) {
      if (count >= 3 && label.startsWith('Click ')) {
        uxSignals.push(`Repeated action: "${label}" appeared ${count} times.`);
      }
    }
    if (actual.length > 15) {
      uxSignals.push(`Long path: ${actual.length} summarized actions were recorded.`);
    }
    if (!actual.length) {
      uxSignals.push('No comparable click, edit, navigation, submit, or scroll action was recorded.');
    }
    if (!reference.length) {
      uxSignals.push('No reference workflow was provided for this task.');
    }
    return {
      schemaVersion: 1,
      referenceWorkflow: reference,
      actualWorkflow: actual,
      uxSignals,
    };
  }

  function addWorkflowOutcome(comparison, outcome) {
    if (!comparison) return null;
    const uxSignals = [...comparison.uxSignals];
    if (outcome && outcome !== 'succeeded') {
      uxSignals.push(`Task outcome was ${String(outcome).replaceAll('_', ' ')}.`);
    }
    return { ...comparison, outcome, uxSignals };
  }

  return {
    addWorkflowOutcome, beginRecordingOnTab, compareWorkflow,
    mergeSnapshotProgress, planTaskStart, resolveTaskView, snapshotAdmission,
  };
});
