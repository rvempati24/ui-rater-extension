const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('task completion retains retryable video and only permits missing video for a recording problem', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  assert.match(source, /const recordingResult\s*=\s*await stopRecording/);
  assert.match(source, /if\s*\(!recordingResult\.ok\)/);
  assert.match(source, /msg\.outcome === 'recording_problem'/);
  assert.match(source, /recordingResult\.retryable !== true/);
  assert.match(source, /Recording upload failed/);
  assert.match(source, /await snapshotWriteLock/);
});

test('background creates and propagates stable run assignment and attempt IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  assert.match(source, /api\/assignments\/.*\/attempts/);
  assert.match(source, /runId:\s*finalSession\.runId/);
  assert.match(source, /assignmentId:\s*finalSession\.assignmentId/);
  assert.match(source, /attemptId:\s*finalSession\.attemptId/);
  assert.match(source, /api\/attempts\/.*\/outcome/);
  assert.match(source, /phase:\s*'awaiting_outcome'/);
  assert.doesNotMatch(source, /_pendingOutcome|outcomePhase|pendingFailureReason/);
  assert.match(source, /!\['starting', 'start_failed'\]\.includes\(existingPhase\)/);
  assert.match(source, /existingPhase === 'starting'\) await cancelRecording/);
  assert.doesNotMatch(source, /CLEAR_INTERACTIONS/);
});

test('background reuses one website tab across tasks in a run', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  assert.match(source, /_runTaskTabId/);
  assert.match(source, /reusePendingTask/);
  assert.match(source, /chrome\.tabs\.update\(tabId, \{ url, active: true \}\)/);
});

test('offscreen recorder keeps a failed upload available for retry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');

  assert.match(source, /pendingBlob/);
  assert.match(source, /recorder \|\| pendingBlob/);
  assert.match(source, /type === ['"]CANCEL_RECORDING['"]/);
  assert.match(source, /code: 'upload_failed', retryable: true/);
  assert.match(source, /code: 'recorder_unavailable', retryable: false/);
});

test('offscreen recorder permits completion retry after a successful video upload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');

  assert.match(source, /lastUploadedTask/);
  assert.match(source, /alreadyUploaded/);
});
