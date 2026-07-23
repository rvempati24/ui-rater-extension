const DEFAULT_COLLECTOR = 'http://127.0.0.1:3000';

const $ = (id) => document.getElementById(id);

let state = {
  participantId: '',
  collectorUrl: DEFAULT_COLLECTOR,
  studyRevisionId: '',
  tasks: null,
  currentTaskIndex: 0,
  runId: '',
  runCapability: '',
  showWorkflowComparison: false,
};
let operationInFlight = false;
const ACTION_BUTTON_IDS = [
  'beginTaskBtn', 'doneBtn', 'skipBtn', 'recordingProblemBtn', 'taskSucceededBtn',
  'taskFailedBtn', 'retryTaskBtn', 'doNotRetryBtn', 'retryPendingBtn', 'markProblemBtn',
  'uploadHfBtn', 'keepLocalBtn',
];

function setOperationInFlight(value) {
  operationInFlight = value;
  for (const id of ACTION_BUTTON_IDS) $(id).disabled = value;
}

async function runExclusive(operation) {
  if (operationInFlight) return;
  setOperationInFlight(true);
  try { return await operation(); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'The operation failed.';
    if (!$('taskScreen').classList.contains('hidden')) showError('taskError', message);
    else if (!$('doneScreen').classList.contains('hidden')) setCompletionStatus(message, true);
    else showError('setupError', message);
  }
  finally { setOperationInFlight(false); }
}

async function init() {
  const data = await chrome.storage.local.get([
    'participantId', 'collectorUrl', 'serverUrl', 'studyRevisionId', 'tasks', 'currentTaskIndex', 'runId', 'runCapability',
    'showWorkflowComparison', '_pendingWorkflowComparison',
  ]);
  const collectorUrl = data.collectorUrl || data.serverUrl || DEFAULT_COLLECTOR;
  if (data.participantId && data.tasks && data.studyRevisionId) {
    if (!data.runCapability) {
      try {
        const response = await fetch(
          `${collectorUrl}/api/v1/participants/${encodeURIComponent(data.participantId)}/runs/resume`,
          {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studyRevisionId: data.studyRevisionId }),
          }
        );
        if (!response.ok) throw new Error(`Collection returned ${response.status}`);
        const refreshed = await response.json();
        data.tasks = refreshed.tasks;
        data.currentTaskIndex = refreshed.currentTaskIndex;
        data.runId = refreshed.runId;
        data.runCapability = refreshed.runCapability;
        await chrome.storage.local.set({
          collectorUrl,
          tasks: data.tasks, currentTaskIndex: data.currentTaskIndex,
          runId: data.runId, runCapability: data.runCapability,
        });
      } catch {
        showSetup();
        $('participantInput').value = data.participantId;
        $('serverInput').value = collectorUrl;
        $('studyRevisionInput').value = data.studyRevisionId || '';
        showError('setupError', 'Please resume this Study Revision from Collection to refresh authorization.');
        return;
      }
    }
    state = {
      participantId: data.participantId,
      collectorUrl,
      studyRevisionId: data.studyRevisionId,
      tasks: data.tasks,
      currentTaskIndex: data.currentTaskIndex || 0,
      runId: data.runId || '',
      runCapability: data.runCapability || '',
      showWorkflowComparison: data.showWorkflowComparison === true,
    };
    $('workflowComparisonInput').checked = state.showWorkflowComparison;
    if (data._pendingWorkflowComparison?.runId === state.runId) {
      showWorkflowComparison(data._pendingWorkflowComparison);
      return;
    }
    if (state.currentTaskIndex >= state.tasks.length) await showDone();
    else await showTask();
    return;
  }
  showSetup();
  if (collectorUrl) $('serverInput').value = collectorUrl;
  if (data.studyRevisionId) $('studyRevisionInput').value = data.studyRevisionId;
  $('workflowComparisonInput').checked = data.showWorkflowComparison === true;
  await fillCurrentStudyRevision().catch(() => {});
}

function showSetup() {
  $('setupScreen').classList.remove('hidden');
  $('taskScreen').classList.add('hidden');
  $('doneScreen').classList.add('hidden');
  $('workflowComparisonScreen').classList.add('hidden');
  $('statusDot').classList.add('inactive');
}

async function fillCurrentStudyRevision() {
  if ($('studyRevisionInput').value.trim()) return;
  const collectorUrl = $('serverInput').value.trim() || DEFAULT_COLLECTOR;
  const response = await fetch(`${collectorUrl}/api/v1/study-revisions/current`);
  if (!response.ok) return;
  const data = await response.json();
  if (!data.studyRevisionId) return;
  $('studyRevisionInput').value = data.studyRevisionId;
  await chrome.storage.local.set({ collectorUrl, studyRevisionId: data.studyRevisionId });
}

async function resumeOrCreateRun(collectorUrl, participantId, studyRevisionId) {
  const baseUrl = `${collectorUrl}/api/v1/participants/${encodeURIComponent(participantId)}/runs`;
  const resumeResponse = await fetch(`${baseUrl}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studyRevisionId }),
  });
  if (resumeResponse.ok) {
    await chrome.storage.local.remove(['_runCreationKey']);
    return resumeResponse.json();
  }
  const resumeError = await resumeResponse.json().catch(() => ({}));
  if (resumeResponse.status !== 404 || resumeError.error?.code !== 'active_run_not_found') {
    throw new Error(resumeError.error?.message || resumeError.error || `Collection returned ${resumeResponse.status}`);
  }

  const pending = await chrome.storage.local.get(['_runCreationKey']);
  const runCreationKey = pending._runCreationKey || `runreq_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ _runCreationKey: runCreationKey });
  const createResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': runCreationKey },
    body: JSON.stringify({ studyRevisionId }),
  });
  if (!createResponse.ok) {
    const error = await createResponse.json().catch(() => ({}));
    throw new Error(error.error?.message || error.error || `Collection returned ${createResponse.status}`);
  }
  const data = await createResponse.json();
  await chrome.storage.local.remove(['_runCreationKey']);
  return data;
}

function hideTaskActions() {
  for (const id of ['preTrackBtns', 'duringTrackBtns', 'outcomeBtns', 'retryChoiceBtns',
    'recoveryBtns', 'trackingStatus', 'outcomePrompt', 'retryPrompt', 'recoveryPrompt']) {
    $(id).classList.add('hidden');
  }
}

function showPreTrack() {
  hideTaskActions();
  $('preTrackBtns').classList.remove('hidden');
}

function showDuringTrack() {
  hideTaskActions();
  $('duringTrackBtns').classList.remove('hidden');
  $('trackingStatus').classList.remove('hidden');
}

function showOutcomeChoice() {
  hideTaskActions();
  $('outcomePrompt').classList.remove('hidden');
  $('outcomeBtns').classList.remove('hidden');
}

function showRetryChoice() {
  hideTaskActions();
  $('retryPrompt').classList.remove('hidden');
  $('retryChoiceBtns').classList.remove('hidden');
}

function showRecovery(workflow) {
  hideTaskActions();
  const label = workflow?.lastError
    ? `The previous operation did not finish: ${workflow.lastError}`
    : 'This attempt has an unfinished save operation.';
  $('recoveryPrompt').textContent = label;
  $('recoveryPrompt').classList.remove('hidden');
  $('recoveryBtns').classList.remove('hidden');
  $('markProblemBtn').classList.toggle('hidden', workflow?.phase !== 'finalizing_evidence');
}

async function showTask() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.remove('hidden');
  $('doneScreen').classList.add('hidden');
  $('workflowComparisonScreen').classList.add('hidden');
  $('statusDot').classList.remove('inactive');

  const task = state.tasks[state.currentTaskIndex];
  $('progressText').textContent = `Task ${state.currentTaskIndex + 1} of ${state.tasks.length}`;
  $('taskPrompt').textContent = task.task_prompt;
  $('taskSite').textContent = (task.target_url || task.site_url) ? `→ ${task.target_url || task.site_url}` : '';

  const data = await chrome.storage.local.get([
    '_tracking', '_pendingTaskTabId', '_runTaskTabId', '_activeSession', '_taskWorkflow',
  ]);
  const view = UiRaterTaskSession.resolveTaskView({
    workflow: data._taskWorkflow,
    tracking: data._tracking,
    activeSession: data._activeSession,
  });
  $('outcomePrompt').textContent = 'Was the task completed successfully?';
  if (view === 'awaiting_retry_choice') {
    showRetryChoice();
  } else if (view === 'awaiting_outcome') {
    showOutcomeChoice();
  } else if (view === 'recording') {
    showDuringTrack();
  } else if (['finalizing_evidence', 'submitting_outcome'].includes(view)) {
    showRecovery(data._taskWorkflow || {});
  } else if (view === 'starting' || view === 'start_failed') {
    showPreTrack();
    $('beginTaskBtn').textContent = 'Retry Start';
    if (data._taskWorkflow?.lastError) showError('taskError', data._taskWorkflow.lastError);
  } else {
    showPreTrack();
    await updateBeginTaskButton(task, data._pendingTaskTabId, data._runTaskTabId);
  }
}

async function updateBeginTaskButton(task, pendingTaskTabId, reusableTaskTabId) {
  const button = $('beginTaskBtn');
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const plan = UiRaterTaskSession.planTaskStart({
      currentTab, siteUrl: task.target_url || task.site_url, pendingTaskTabId, reusableTaskTabId,
    });
    button.textContent = plan.action === 'record'
      ? 'Start Recording'
      : plan.action === 'wrong-tab' ? 'Return to Task Tab'
        : plan.action === 'reuse' ? 'Open Next Task in Current Tab' : 'Open Task Website';
  } catch {
    button.textContent = 'Begin Task';
  }
}

function setCompletionStatus(message, isError = false) {
  $('hfUploadStatus').textContent = message;
  $('hfUploadStatus').style.color = isError ? '#dc2626' : '#15803d';
  $('hfUploadStatus').classList.remove('hidden');
}

async function showDone() {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.add('hidden');
  $('doneScreen').classList.remove('hidden');
  $('workflowComparisonScreen').classList.add('hidden');
  $('statusDot').classList.add('inactive');
  $('hfUploadChoice').classList.remove('hidden');
  $('hfUploadStatus').classList.add('hidden');
  $('uploadHfBtn').textContent = 'Upload to Hugging Face';
  $('uploadHfBtn').disabled = false;
  $('keepLocalBtn').textContent = 'Keep Local Only';
  const stored = await chrome.storage.local.get(['_completedRunDecision']);
  const decision = stored._completedRunDecision;
  if (decision?.runId === state.runId) {
    $('hfUploadChoice').classList.add('hidden');
    setCompletionStatus(decision.message);
    return;
  }
  try {
    const response = await fetch(
      `${state.collectorUrl}/api/runs/${encodeURIComponent(state.runId)}/hf-upload?participantId=${encodeURIComponent(state.participantId)}`,
      { headers: { 'Authorization': `Bearer ${state.runCapability}` } }
    );
    if (!response.ok) return;
    const status = await response.json();
    if (status.sync) {
      $('uploadHfBtn').textContent = 'Already Uploaded';
      $('uploadHfBtn').disabled = true;
      $('keepLocalBtn').textContent = 'Finish Locally';
      setCompletionStatus(`Uploaded to ${status.sync.repo_id}@${status.sync.revision}. Choose Finish Locally to retain the evidence.`);
    } else if (status.nothing_to_upload) {
      $('uploadHfBtn').textContent = 'No Accepted Attempts';
      $('uploadHfBtn').disabled = true;
      setCompletionStatus('This run has no accepted attempts to upload. Choose Keep Local Only to finish.');
    } else if (!status.available) {
      $('uploadHfBtn').textContent = 'HF Token Not Configured';
      $('uploadHfBtn').disabled = true;
    }
  } catch {
    // The launcher may already be closed after a previously recorded decision.
  }
}

function fillWorkflowList(id, values, emptyText) {
  const list = $(id);
  list.textContent = '';
  const items = values?.length ? values : [emptyText];
  for (const value of items) {
    const item = document.createElement('li');
    item.textContent = value;
    list.appendChild(item);
  }
}

function showWorkflowComparison(review) {
  $('setupScreen').classList.add('hidden');
  $('taskScreen').classList.add('hidden');
  $('doneScreen').classList.add('hidden');
  $('workflowComparisonScreen').classList.remove('hidden');
  const comparison = review.comparison || review;
  fillWorkflowList(
    'referenceWorkflowList', comparison.referenceWorkflow,
    'No reference workflow was provided.'
  );
  fillWorkflowList(
    'actualWorkflowList', comparison.actualWorkflow,
    'No comparable actions were recorded.'
  );
  fillWorkflowList(
    'workflowSignalList', comparison.uxSignals,
    'No obvious heuristic UX signal was detected.'
  );
}

async function continueAfterWorkflowComparison() {
  const stored = await chrome.storage.local.get(['_pendingWorkflowComparison']);
  const review = stored._pendingWorkflowComparison;
  await chrome.storage.local.remove(['_pendingWorkflowComparison']);
  if (review?.currentTaskIndex !== undefined) {
    state.currentTaskIndex = review.currentTaskIndex;
  }
  if (review?.finished || state.currentTaskIndex >= state.tasks.length) await showDone();
  else await showTask();
}

function showError(containerId, msg) {
  const el = $(containerId);
  el.style.color = '#dc2626';
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function stopContentTracking(outcome, reason, savedTiming) {
  const stored = await chrome.storage.local.get(['_originTime', '_viewStart', '_taskTabId']);
  const timing = {
    durationMs: savedTiming?.durationMs ?? (Date.now() - (stored._originTime || Date.now())),
    viewStart: savedTiming?.viewStart || stored._viewStart || new Date().toISOString(),
    finalizationReport: savedTiming?.finalizationReport,
    finalFlushStatus: savedTiming?.finalFlushStatus,
    finalFlushError: savedTiming?.finalFlushError,
  };
  const prepared = await sendRuntimeMessage({
    type: 'PREPARE_FINALIZATION', outcome, reason, ...timing,
  });
  if (!prepared?.ok) throw new Error(prepared?.error || 'Could not prepare evidence finalization.');
  let finalizationResponse = timing.finalizationReport
    ? { finalizationReport: timing.finalizationReport } : null;
  try {
    if (!finalizationResponse && stored._taskTabId) {
      finalizationResponse = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out while flushing final interactions.')), 10000);
        chrome.tabs.sendMessage(stored._taskTabId, { type: 'STOP_TRACKING' }, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!response?.ok) reject(new Error(response?.error || 'Final interaction flush failed.'));
          else resolve(response);
        });
      });
    }
  } catch (error) {
    if (outcome !== 'recording_problem') throw error;
    timing.finalFlushStatus = 'unavailable';
    timing.finalFlushError = error instanceof Error ? error.message : 'Final interaction flush failed.';
  }
  if (finalizationResponse?.finalizationReport) {
    timing.finalizationReport = finalizationResponse.finalizationReport;
    timing.finalFlushStatus = 'complete';
  } else if (outcome === 'recording_problem') {
    timing.finalFlushStatus = 'unavailable';
    timing.finalFlushError = 'The content tracker was unavailable during recovery.';
  } else {
    throw new Error('The content tracker did not provide an evidence finalization report.');
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return timing;
}

async function finishAndSubmit(outcome, reason) {
  const timing = await stopContentTracking(outcome, reason);
  const result = await sendRuntimeMessage({ type: 'FINISH_WITH_OUTCOME', outcome, reason, ...timing });
  if (!result?.ok) throw new Error(result?.error || 'Could not save this outcome.');
  await applyOutcomeResult(result);
}

async function submitOutcome(outcome, reason) {
  const result = await sendRuntimeMessage({ type: 'SUBMIT_OUTCOME', outcome, reason });
  if (!result?.ok) throw new Error(result?.error || 'Could not save this outcome.');
  await applyOutcomeResult(result);
}

async function applyOutcomeResult(result) {
  state.currentTaskIndex = result.currentTaskIndex ?? state.currentTaskIndex;
  if (result.workflowComparison) {
    showWorkflowComparison({
      comparison: result.workflowComparison,
      currentTaskIndex: state.currentTaskIndex,
      finished: result.finished,
    });
    return;
  }
  if (result.finished || state.currentTaskIndex >= state.tasks.length) await showDone();
  else await showTask();
}

$('startBtn').addEventListener('click', async () => {
  const pid = $('participantInput').value.trim();
  const collectorUrl = $('serverInput').value.trim() || DEFAULT_COLLECTOR;
  await fillCurrentStudyRevision().catch(() => {});
  const studyRevisionId = $('studyRevisionInput').value.trim();
  const showWorkflowComparisonOption = $('workflowComparisonInput').checked;
  if (!pid) {
    showError('setupError', 'Please enter a participant ID.');
    return;
  }
  if (!studyRevisionId) {
    showError('setupError', 'Please enter a Study Revision ID.');
    return;
  }
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Loading…';
  try {
    const data = await resumeOrCreateRun(collectorUrl, pid, studyRevisionId);
    if (!data.tasks?.length) throw new Error('No tasks found for this participant.');
    state = {
      participantId: pid,
      collectorUrl,
      studyRevisionId,
      tasks: data.tasks,
      currentTaskIndex: data.currentTaskIndex || 0,
      runId: data.runId,
      runCapability: data.runCapability,
      showWorkflowComparison: showWorkflowComparisonOption,
    };
    await chrome.storage.local.set(state);
    await chrome.storage.local.set({
      collectorUrl, studyRevisionId,
      showWorkflowComparison: showWorkflowComparisonOption,
    });
    if (state.currentTaskIndex >= state.tasks.length) await showDone();
    else await showTask();
  } catch (err) {
    showError('setupError', err.message);
  } finally {
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Load Tasks';
  }
});

$('serverInput').addEventListener('change', () => {
  fillCurrentStudyRevision().catch(() => {});
});

async function clearExtensionCache() {
  const stored = await chrome.storage.local.get([
    '_tracking', '_activeSession', '_taskWorkflow',
  ]);
  if (stored._tracking || stored._activeSession || stored._taskWorkflow) {
    const message = stored._tracking
      ? 'Recording is active. Finish or report the recording problem before clearing the cache.'
      : 'An attempt is unfinished. Complete its pending save or result decision before clearing the cache.';
    if (!$('taskScreen').classList.contains('hidden')) showError('taskError', message);
    else window.alert(message);
    return;
  }
  if (!window.confirm('Clear this extension cache? Saved server traces, screenshots, and videos will not be deleted.')) return;
  await chrome.storage.local.clear();
  state = {
    participantId: '', collectorUrl: DEFAULT_COLLECTOR, studyRevisionId: '', tasks: null,
    currentTaskIndex: 0, runId: '', runCapability: '', showWorkflowComparison: false,
  };
  showSetup();
  $('participantInput').value = '';
  $('serverInput').value = DEFAULT_COLLECTOR;
  $('studyRevisionInput').value = '';
  $('workflowComparisonInput').checked = false;
  $('setupError').textContent = 'Extension cache cleared. Server recordings were not changed.';
  $('setupError').style.color = '#15803d';
  $('setupError').classList.remove('hidden');
  setTimeout(() => $('setupError').classList.add('hidden'), 5000);
}

$('clearCacheBtn').addEventListener('click', () => clearExtensionCache().catch((error) => {
  const message = error instanceof Error ? error.message : 'Could not clear extension cache.';
  if (!$('taskScreen').classList.contains('hidden')) showError('taskError', message);
  else showError('setupError', message);
}));

$('beginTaskBtn').addEventListener('click', () => runExclusive(async () => {
  const task = state.tasks[state.currentTaskIndex];
  $('beginTaskBtn').disabled = true;
  $('beginTaskBtn').textContent = 'Starting…';
  try {
    if (!(task.target_url || task.site_url)) throw new Error('This assignment does not have a target URL.');
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await sendRuntimeMessage({
      type: 'START_TASK_FLOW',
      siteUrl: task.target_url || task.site_url,
      currentTab: { id: currentTab.id, url: currentTab.url, windowId: currentTab.windowId },
    });
    if (!result?.ok) throw new Error(result?.error || 'Failed to start the task recording.');
    if (result.status === 'recording') showDuringTrack();
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('beginTaskBtn').disabled = false;
    const pending = await chrome.storage.local.get(['_pendingTaskTabId', '_runTaskTabId']);
    await updateBeginTaskButton(task, pending._pendingTaskTabId, pending._runTaskTabId);
  }
}));

$('doneBtn').addEventListener('click', () => runExclusive(async () => {
  $('doneBtn').disabled = true;
  $('doneBtn').textContent = 'Saving…';
  try {
    const timing = await stopContentTracking();
    const result = await sendRuntimeMessage({ type: 'COMPLETE_TASK', ...timing });
    if (!result?.ok) throw new Error(result?.error || 'Failed to save evidence.');
    if (result.finalized) await applyOutcomeResult(result);
    else showOutcomeChoice();
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('doneBtn').disabled = false;
    $('doneBtn').textContent = 'Done';
  }
}));

$('skipBtn').addEventListener('click', () => runExclusive(async () => {
  $('skipBtn').disabled = true;
  try {
    await finishAndSubmit('skipped', 'participant_skipped');
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('skipBtn').disabled = false;
  }
}));

$('recordingProblemBtn').addEventListener('click', () => runExclusive(async () => {
  $('recordingProblemBtn').disabled = true;
  try {
    const reason = window.prompt('Optional short description of the recording problem:', 'recording_problem')
      || 'recording_problem';
    await finishAndSubmit('recording_problem', reason.slice(0, 500));
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('recordingProblemBtn').disabled = false;
  }
}));

$('taskSucceededBtn').addEventListener('click', () => runExclusive(async () => {
  $('taskSucceededBtn').disabled = true;
  try {
    await submitOutcome('succeeded');
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('taskSucceededBtn').disabled = false;
  }
}));

$('taskFailedBtn').addEventListener('click', () => runExclusive(async () => {
  const reason = window.prompt('Optional short reason the task failed:', 'participant_reported_failure')
    || 'participant_reported_failure';
  const result = await sendRuntimeMessage({ type: 'SET_RETRY_CHOICE', reason: reason.slice(0, 500) });
  if (!result?.ok) throw new Error(result?.error || 'Could not save the retry choice.');
  showRetryChoice();
}));

$('retryTaskBtn').addEventListener('click', () => runExclusive(async () => {
  $('retryTaskBtn').disabled = true;
  try {
    const data = await chrome.storage.local.get(['_taskWorkflow']);
    await submitOutcome('failed_retry', data._taskWorkflow?.reason);
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('retryTaskBtn').disabled = false;
  }
}));

$('doNotRetryBtn').addEventListener('click', () => runExclusive(async () => {
  $('doNotRetryBtn').disabled = true;
  try {
    const data = await chrome.storage.local.get(['_taskWorkflow']);
    await submitOutcome('failed_no_retry', data._taskWorkflow?.reason);
  } catch (err) {
    showError('taskError', err.message);
  } finally {
    $('doNotRetryBtn').disabled = false;
  }
}));

$('retryPendingBtn').addEventListener('click', () => runExclusive(async () => {
  const data = await chrome.storage.local.get(['_taskWorkflow']);
  const workflow = data._taskWorkflow;
  if (!workflow) throw new Error('No pending operation was found.');
  let result;
  if (workflow.phase === 'finalizing_evidence') {
    const timing = await stopContentTracking(workflow.intendedOutcome, workflow.reason, workflow);
    const message = workflow.intendedOutcome
      ? {
        type: 'FINISH_WITH_OUTCOME', outcome: workflow.intendedOutcome, reason: workflow.reason,
        ...timing,
      }
      : { type: 'COMPLETE_TASK', ...timing };
    result = await sendRuntimeMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Could not finish saving evidence.');
    if (result.pendingOutcome) showOutcomeChoice();
    else if (result.currentTaskIndex !== undefined) await applyOutcomeResult(result);
    return;
  }
  if (workflow.phase === 'submitting_outcome'
    || (workflow.phase === 'awaiting_outcome' && workflow.intendedOutcome)) {
    result = await sendRuntimeMessage({
      type: 'SUBMIT_OUTCOME', outcome: workflow.intendedOutcome, reason: workflow.reason,
    });
    if (!result?.ok) throw new Error(result?.error || 'Could not finish saving the outcome.');
    await applyOutcomeResult(result);
    return;
  }
  throw new Error(`Workflow phase ${workflow.phase} cannot be retried here.`);
}));

$('markProblemBtn').addEventListener('click', () => runExclusive(async () => {
  const data = await chrome.storage.local.get(['_taskWorkflow']);
  const workflow = data._taskWorkflow;
  if (workflow?.phase !== 'finalizing_evidence') {
    throw new Error('Only an unfinished evidence save can be marked as a recording problem.');
  }
  const reason = window.prompt(
    'Optional short description of the recording problem:',
    'recording_problem_recovery'
  ) || 'recording_problem_recovery';
  const timing = await stopContentTracking(
    'recording_problem', reason.slice(0, 500), workflow
  );
  const result = await sendRuntimeMessage({
    type: 'FINISH_WITH_OUTCOME', outcome: 'recording_problem',
    reason: reason.slice(0, 500), ...timing,
  });
  if (!result?.ok) throw new Error(result?.error || 'Could not mark this recording problem.');
  await applyOutcomeResult(result);
}));

$('uploadHfBtn').addEventListener('click', () => runExclusive(async () => {
  setCompletionStatus('Uploading accepted attempts…');
  const response = await fetch(`${state.collectorUrl}/api/runs/${encodeURIComponent(state.runId)}/hf-upload`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.runCapability}`,
    },
    body: JSON.stringify({ participantId: state.participantId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    setCompletionStatus(body.error || `Upload failed: ${response.status}`, true);
    return;
  }
  const message = `Uploaded to ${body.sync.repo_id}@${body.sync.revision}. Local evidence was retained.`;
  await chrome.storage.local.set({
    _completedRunDecision: { runId: state.runId, choice: 'uploaded', message },
  });
  $('hfUploadChoice').classList.add('hidden');
  setCompletionStatus(message);
}));

$('keepLocalBtn').addEventListener('click', () => runExclusive(async () => {
  const message = $('uploadHfBtn').disabled && $('uploadHfBtn').textContent === 'Already Uploaded'
    ? 'Run finished. The Hugging Face copy and local evidence were retained.'
    : 'Kept locally without a new Hugging Face upload.';
  await chrome.storage.local.set({
    _completedRunDecision: { runId: state.runId, choice: 'local', message },
  });
  $('hfUploadChoice').classList.add('hidden');
  setCompletionStatus(message);
}));

$('continueAfterComparisonBtn').addEventListener('click', () => runExclusive(
  continueAfterWorkflowComparison
));

$('resetBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove([
    'participantId', 'studyRevisionId', 'tasks', 'currentTaskIndex', 'runId', 'runCapability', '_tracking', '_sessionId',
    '_originTime', '_viewStart', '_taskTabId', '_runTaskTabId', '_pendingTaskTabId', '_activeSession',
    '_taskWorkflow',
    '_completedRunDecision',
    '_pendingWorkflowComparison', 'showWorkflowComparison',
  ]);
  state = {
    participantId: '', collectorUrl: state.collectorUrl, studyRevisionId: '', tasks: null,
    currentTaskIndex: 0, runId: '', runCapability: '', showWorkflowComparison: false,
  };
  showSetup();
});

init();
