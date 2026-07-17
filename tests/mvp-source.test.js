const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('active trace is persisted and restored through chrome.storage.local', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(background, /ACTIVE_SESSION_KEY/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[ACTIVE_SESSION_KEY\]: session \}\)/);
  assert.match(content, /_sessionId/);
  assert.match(content, /if \(data\._tracking\) startTracking/);
});

test('server protects completed sessions from delayed partial saves', () => {
  const partialRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'partial-save', 'route.ts'
  ), 'utf8');
  const sessions = fs.readFileSync(path.join(root, 'server', 'lib', 'sessions.ts'), 'utf8');
  assert.match(partialRoute, /if \(trial\.completed\) return/);
  assert.match(sessions, /current\.status === 'complete'/);
  assert.match(sessions, /interactions\.length >= current\.interactions\.length/);
});

test('new trials retain the configured site URL for analysis context', () => {
  const trials = fs.readFileSync(path.join(root, 'server', 'lib', 'trials.ts'), 'utf8');
  assert.match(trials, /site_url:\s*config\.site_url/);
});

test('key snapshots are capped, debounced, and uploaded by session ID', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /MAX_SNAPSHOTS = 20/);
  assert.match(background, /SNAPSHOT_DEBOUNCE_MS = 750/);
  assert.match(background, /api\/sessions\/\$\{session\.sessionId\}\/snapshot/);
});

test('analysis and export entrypoints exist without automatic external writes', () => {
  assert.ok(fs.existsSync(path.join(root, 'server', 'app', 'api', 'sessions', '[sessionId]', 'analyze', 'route.ts')));
  assert.ok(fs.existsSync(path.join(root, 'server', 'lib', 'ux-analysis', 'source-context.ts')));
  assert.ok(fs.existsSync(path.join(root, 'server', 'lib', 'ux-analysis', 'openai.ts')));
  const exportConfig = JSON.parse(fs.readFileSync(
    path.join(root, 'scripts', 'trace-export.example.json'), 'utf8'
  ));
  assert.equal(exportConfig.upload_hf, false);
  assert.equal(exportConfig.hf_repo_id, 'uxBench/ux-task-trace');
});

test('completed sessions retain website provenance and attempt metadata', () => {
  const completeRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'complete-task', 'route.ts'
  ), 'utf8');
  const launcher = fs.readFileSync(path.join(
    root, 'server', 'scripts', 'start-with-tasks.mjs'
  ), 'utf8');
  const metadata = fs.readFileSync(path.join(
    root, 'server', 'lib', 'website-metadata.ts'
  ), 'utf8');
  assert.match(completeRoute, /getActiveWebsiteMetadata/);
  assert.match(completeRoute, /attempt_id:/);
  assert.match(launcher, /UI_RATER_WEBSITE_METADATA_FILE/);
  assert.match(launcher, /UI_RATER_WEBSITE_SOURCE_DIR/);
  assert.match(launcher, /UI_RATER_WEBSITE_RUN_ID/);
  assert.match(metadata, /delete portable\.source_dir/);
});
