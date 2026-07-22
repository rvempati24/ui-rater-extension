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
  assert.match(source, /const captureLocks = new Map/);
  assert.match(source, /await Promise\.all\(\[\.\.\.captureLocks\.values\(\)\]\)/);
  assert.match(source, /await snapshotUploadLock/);
  assert.match(source, /await persistCapture\(upload\)/);
  assert.match(source, /await drainPendingCaptures\(\)/);
  assert.match(source, /finalizationReport: msg\.finalizationReport/);
  assert.match(source, /finalSession\.pendingSnapshotCount/);
  const captureFunction = source.slice(
    source.indexOf('async function captureSnapshot'),
    source.indexOf('async function finishAttemptEvidence')
  );
  assert.ok(
    captureFunction.indexOf('return withSnapshotUpload')
      > captureFunction.indexOf('prepared = await withCaptureLock'),
    'capture preparation must precede the independent upload queue'
  );
  assert.match(captureFunction, /Release the capture lock before network I\/O/);
  assert.doesNotMatch(captureFunction, /pendingSnapshotCount:\s*Math\.max/);
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
  assert.match(source, /transaction\.oncomplete = \(\) => resolve\(result\)/);
});

test('offscreen recorder permits completion retry after a successful video upload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');

  assert.match(source, /lastUploadedTask/);
  assert.match(source, /alreadyUploaded/);
  assert.match(source, /persistPendingRecording\(pendingBlob, recordingTiming\)/);
  assert.match(source, /videoStartEpochMs: Date\.now\(\)/);
  assert.match(source, /videoStopEpochMs/);
  assert.match(source, /lastUploadedTask = \{ uploadKey, timing: recordingTiming \}/);
});
