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
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(background, /MAX_SNAPSHOTS = 20/);
  assert.match(background, /SNAPSHOT_DEBOUNCE_MS = 750/);
  assert.match(background, /api\/sessions\/\$\{session\.sessionId\}\/snapshot/);
  assert.match(
    content,
    /await flushToBackground\(\);[\s\S]*await requestSnapshot\('task-end'\)[\s\S]*tracking = false;/,
    'task-end screenshot must be requested before tracking is marked inactive'
  );
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

test('evidence completion and outcome submission are separate APIs', () => {
  const completeRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'complete-task', 'route.ts'
  ), 'utf8');
  const outcomeRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'attempts', '[attemptId]', 'outcome', 'route.ts'
  ), 'utf8');
  const outcomeService = fs.readFileSync(path.join(
    root, 'server', 'lib', 'attempt-outcomes.ts'
  ), 'utf8');
  assert.match(completeRoute, /completeAttemptEvidence/);
  assert.match(completeRoute, /completed_pending_outcome/);
  assert.match(outcomeRoute, /recordAttemptOutcome/);
  assert.match(outcomeRoute, /idempotent/);
  assert.match(outcomeService, /applyAttemptOutcome/);
  assert.match(outcomeService, /updateManifest/);
  assert.match(outcomeService, /withResultsLock/);
});

test('all attempt result routes use the same outcome service and admin actions are allowlisted', () => {
  const routes = [
    path.join(root, 'server', 'app', 'api', 'attempts', '[attemptId]', 'outcome', 'route.ts'),
    path.join(root, 'server', 'app', 'api', 'attempts', '[attemptId]', 'invalidate', 'route.ts'),
    path.join(root, 'server', 'app', 'api', 'admin', 'attempts', '[attemptId]', 'route.ts'),
  ].map((file) => fs.readFileSync(file, 'utf8'));
  for (const route of routes) {
    assert.match(route, /recordAttemptOutcome/);
    assert.doesNotMatch(route, /applyAttemptOutcome|invalidateAttempt|decideAttempt/);
  }
  assert.match(routes[2], /body\.action !== 'accept' && body\.action !== 'invalidate'/);
});

test('recording upload validates managed IDs before any compatibility path is built', () => {
  const uploadRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'upload-recording', 'route.ts'
  ), 'utf8');
  const validation = uploadRoute.indexOf('if (!participantId || !SAFE_ID.test(participantId)');
  const compatibilityPath = uploadRoute.indexOf('path.join(RECORDINGS_DIR');
  assert.ok(validation >= 0, 'managed ID validation must exist');
  assert.ok(compatibilityPath > validation, 'validation must precede legacy path construction');
  assert.match(uploadRoute, /flag:\s*'wx'/);
  assert.match(uploadRoute, /already exists with different content/);
});

test('duplicate complete and delayed partial requests cannot rewrite finalized projections', () => {
  const completeRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'complete-task', 'route.ts'
  ), 'utf8');
  const partialRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'partial-save', 'route.ts'
  ), 'utf8');
  const completeGuard = completeRoute.indexOf("canonical.attempt.status !== 'recording'");
  assert.ok(completeGuard >= 0);
  assert.ok(completeGuard < completeRoute.indexOf('await saveSessionTrace'));
  assert.match(partialRoute, /canonical\.attempt\.status !== 'recording'/);
  assert.match(partialRoute, /ignored: 'attempt_finalized'/);
});

test('task loading repairs a legacy results projection left on another run', () => {
  const tasksRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'tasks', 'route.ts'
  ), 'utf8');
  assert.match(tasksRoute, /existingResults\?\.run_id !== managed\.run\.run_id/);
  assert.match(tasksRoute, /current\?\.run_id === managed\.run\.run_id/);
  assert.match(tasksRoute, /run_id: managed\.run\.run_id/);
});

test('task launcher auto-closes only after the run-completion marker is written', () => {
  const launcher = fs.readFileSync(path.join(
    root, 'server', 'scripts', 'start-with-tasks.mjs'
  ), 'utf8');
  const outcomeService = fs.readFileSync(path.join(
    root, 'server', 'lib', 'attempt-outcomes.ts'
  ), 'utf8');
  assert.match(launcher, /--keep-open/);
  assert.match(launcher, /UI_RATER_SHUTDOWN_FILE/);
  assert.match(launcher, /child\.kill\('SIGINT'\)/);
  assert.match(launcher, /spawnSync\('taskkill', \['\/PID'.*'\/T', '\/F'\]/);
  assert.match(outcomeService, /if \(result\.runCompleted\) await requestLauncherShutdown/);
});
