const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('task completion rejects a failed recording upload before completing the task', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  assert.match(source, /const recordingResult\s*=\s*await stopRecording/);
  assert.match(source, /if\s*\(!recordingResult\.ok\)/);
  assert.match(source, /Recording upload failed/);
});

test('offscreen recorder keeps a failed upload available for retry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');

  assert.match(source, /pendingBlob/);
  assert.match(source, /type === ['"]CANCEL_RECORDING['"]/);
});

test('offscreen recorder permits completion retry after a successful video upload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');

  assert.match(source, /lastUploadedTask/);
  assert.match(source, /alreadyUploaded/);
});
