const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('popup sends the invoked current tab through the two-stage task flow', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');

  assert.match(source, /type:\s*['"]START_TASK_FLOW['"]/);
  assert.match(source, /currentTab:\s*\{/);
  assert.match(source, /_pendingTaskTabId/);
  assert.match(source, /_taskTabId/);
  assert.doesNotMatch(source, /OPEN_AND_BEGIN_TASK/);
  assert.match(html, /<script src="task-session\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
});

test('popup supports participant runs and explicit task outcomes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');

  assert.match(source, /api\/v1\/participants\/.*\/runs/);
  assert.match(source, /studyRevisionId/);
  assert.match(source, /collectorUrl/);
  assert.match(source, /runId/);
  assert.match(source, /type:\s*['"]FINISH_WITH_OUTCOME['"]/);
  assert.match(source, /type:\s*['"]SUBMIT_OUTCOME['"]/);
  assert.match(source, /failed_retry/);
  assert.match(source, /failed_no_retry/);
  assert.match(source, /recording_problem/);
  assert.match(html, /Start a new run/);
  assert.match(html, /Task Succeeded/);
  assert.match(html, /Task Failed/);
  assert.match(html, /Retry Task/);
  assert.match(html, /Do Not Retry/);
  assert.match(html, /Mark Recording Problem/);
  assert.match(source, /finalFlushStatus = 'unavailable'/);
  assert.match(source, /finalizationReport: savedTiming\?\.finalizationReport/);
  assert.match(source, /!finalizationResponse && stored\._taskTabId/);
});

test('popup restores both post-recording decision phases', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  assert.match(source, /resolveTaskView/);
  assert.match(source, /_taskWorkflow/);
  assert.match(source, /showRecovery/);
  assert.doesNotMatch(source, /_pendingOutcome|outcomePhase|pendingFailureReason/);
});

test('popup can clear extension cache without calling a server reset', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');

  assert.match(html, /id="clearCacheBtn"/);
  assert.match(source, /chrome\.storage\.local\.clear\(\)/);
  assert.match(source, /Recording is active/);
  assert.match(source, /An attempt is unfinished/);
  assert.doesNotMatch(source, /fetch\([^\n]*\/api\/reset/);
});
