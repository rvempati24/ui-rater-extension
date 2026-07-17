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
