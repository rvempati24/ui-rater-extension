const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('active trace resumes only through a tab-owned background handshake', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(background, /ACTIVE_SESSION_KEY/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[ACTIVE_SESSION_KEY\]: session \}\)/);
  assert.match(content, /type: 'RESUME_TRACKING'/);
  assert.doesNotMatch(content, /if \(data\._tracking\) startTracking/);
  assert.match(background, /sender\.tab\?\.id === session\.taskTabId/);
  assert.match(background, /phase === 'recording'/);
  assert.match(background, /installNavigationBridge\(session\.taskTabId\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
});

test('content trace flushes are serialized and failed batches retain order', () => {
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(content, /let flushLock = Promise\.resolve\(\)/);
  assert.match(content, /const next = flushLock\.then\(flush, flush\)/);
  assert.match(content, /interactions = \[\.\.\.batch, \.\.\.interactions\]/);
  assert.match(content, /attachListeners\(\);[\s\S]*saveInterval = setInterval/);
});

test('server protects completed sessions from delayed partial saves', () => {
  const partialRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'partial-save', 'route.ts'
  ), 'utf8');
  const sessions = fs.readFileSync(path.join(root, 'server', 'lib', 'sessions.ts'), 'utf8');
  assert.match(partialRoute, /canonical\.attempt\.status !== 'recording'/);
  assert.match(partialRoute, /ignored: 'attempt_finalized'/);
  assert.match(sessions, /manifest\.status === 'complete'/);
  assert.match(sessions, /processed_batch_ids/);
  assert.match(sessions, /new Set\(current\.interactions\.map\(\(event\) => event\.event_id\)/);
});

test('managed v1 runs retain the revision website URL for participant context', () => {
  const runRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'v1', 'participants', '[participantId]', 'runs', 'route.ts'
  ), 'utf8');
  const store = fs.readFileSync(path.join(root, 'server', 'lib', 'participant-store.ts'), 'utf8');
  assert.match(runRoute, /target_url: task\.target_url \|\| task\.site_url/);
  assert.match(store, /website_snapshot: revision\.website/);
});

test('important actions receive paired snapshots with a high safety guard', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(background, /MAX_SNAPSHOTS = 120/);
  assert.match(background, /RESERVED_TASK_END_SNAPSHOTS = 1/);
  assert.match(background, /UiRaterTaskSession\.snapshotAdmission/);
  assert.match(background, /msg\.phase === 'before' \|\| msg\.phase === 'after'/);
  assert.match(content, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(content, /actionCounter/);
  assert.match(content, /requestSnapshotWithFailureRecord\('before-activate'/);
  assert.match(content, /'after-click'/);
  assert.match(content, /requestSnapshotWithFailureRecord\('before-edit'/);
  assert.match(content, /'after-edit'/);
  assert.match(content, /'after-scroll'/);
  assert.match(content, /record\('snapshot-skipped'/);
  assert.match(background, /actionId: msg\.actionId/);
  assert.match(background, /phase: msg\.phase/);
  assert.match(background, /timingGuarantee: msg\.phase === 'before' \? 'best-effort-before'/);
  assert.match(background, /ts: capturedTs/);
  assert.match(background, /api\/sessions\/\$\{record\.sessionId\}\/snapshot/);
  assert.match(
    content,
    /await flushToBackground\(\);[\s\S]*await requestSnapshot\('task-end',[\s\S]*tracking = false;/,
    'task-end screenshot must be requested before tracking is marked inactive'
  );
});

test('the server analyzer is retired in favor of the controlled experiment entrypoint', () => {
  assert.ok(fs.existsSync(path.join(root, 'server', 'app', 'api', 'sessions', '[sessionId]', 'analyze', 'route.ts')));
  const route = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'sessions', '[sessionId]', 'analyze', 'route.ts'
  ), 'utf8');
  assert.match(route, /status: 410/);
  assert.match(route, /run-ux-experiment\.sh/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'run_ux_experiment.py')));
  const exportConfig = JSON.parse(fs.readFileSync(
    path.join(root, 'scripts', 'trace-export.example.json'), 'utf8'
  ));
  assert.equal(exportConfig.upload_hf, false);
  assert.equal(exportConfig.hf_repo_id, 'uxBench/ux-task-trace');
});

test('Method 1 exposes all screenshots for agent selection without pre-attaching them', () => {
  const runner = fs.readFileSync(path.join(root, 'scripts', 'run_agent_analysis.py'), 'utf8');
  assert.match(runner, /agent-selective/);
  assert.match(runner, /workspace \/ "screenshots"/);
  assert.doesNotMatch(runner, /command\.extend\(\["-i"/);
});

test('Methods 1 and 3 share the problem-only contract', () => {
  const materializer = fs.readFileSync(path.join(root, 'scripts', 'materialize_case.py'), 'utf8');
  const experiment = fs.readFileSync(path.join(root, 'scripts', 'run_ux_experiment.py'), 'utf8');
  assert.match(materializer, /ux_problem/);
  assert.match(materializer, /task_impact/);
  assert.match(materializer, /Do not propose code changes or implementation fixes/);
  assert.match(experiment, /"1"[\s\S]*"primary": True/);
  assert.match(experiment, /"3"[\s\S]*"primary": True/);
});

test('completed sessions retain website provenance and attempt metadata', () => {
  const completeRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'complete-task', 'route.ts'
  ), 'utf8');
  const launcher = fs.readFileSync(path.join(
    root, 'server', 'scripts', 'start-with-tasks.mjs'
  ), 'utf8');
  assert.match(completeRoute, /const website = managedRun\?\.run\.website/);
  assert.match(completeRoute, /attempt_id:/);
  assert.match(launcher, /api\/v1\/artifact-jobs/);
  assert.match(launcher, /MANAGER_SERVICE_URL/);
  assert.equal(fs.existsSync(path.join(root, 'server', 'lib', 'website-metadata.ts')), false);
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
  const sessions = fs.readFileSync(path.join(root, 'server', 'lib', 'sessions.ts'), 'utf8');
  assert.match(completeRoute, /await completeAttemptEvidence/);
  assert.match(sessions, /manifest\.status === 'complete'[\s\S]*current\.interactions/);
  assert.match(partialRoute, /canonical\.attempt\.status !== 'recording'/);
  assert.match(partialRoute, /ignored: 'attempt_finalized'/);
});

test('the legacy task bootstrap route is an explicit migration sentinel', () => {
  const tasksRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'tasks', 'route.ts'
  ), 'utf8');
  assert.match(tasksRoute, /legacy_tasks_route_removed/);
  assert.match(tasksRoute, /status: 410/);
  assert.doesNotMatch(tasksRoute, /getTrialConfigs|generateTrials|getActiveWebsiteMetadata/);
});

test('the legacy participant run route is an explicit migration sentinel', () => {
  const route = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'participants', '[participantId]', 'runs', 'route.ts'
  ), 'utf8');
  assert.match(route, /legacy_participant_runs_route_removed/);
  assert.match(route, /status: 410/);
  assert.doesNotMatch(route, /getTrialConfigs|generateTrials|getActiveWebsiteMetadata/);
});

test('task completion has no launcher or service lifecycle side effect', () => {
  const launcher = fs.readFileSync(path.join(
    root, 'server', 'scripts', 'start-with-tasks.mjs'
  ), 'utf8');
  const outcomeService = fs.readFileSync(path.join(
    root, 'server', 'lib', 'attempt-outcomes.ts'
  ), 'utf8');
  assert.doesNotMatch(launcher, /UI_RATER_SHUTDOWN_FILE|UI_RATER_DEFER_SHUTDOWN/);
  assert.doesNotMatch(outcomeService, /requestLauncherShutdown|UI_RATER_SHUTDOWN/);
});

test('completed run offers an explicit server-side Hugging Face upload choice', () => {
  const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'server', 'lib', 'hf-run-upload.ts'), 'utf8');
  const uploadRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'runs', '[runId]', 'hf-upload', 'route.ts'
  ), 'utf8');
  const finishRoute = fs.readFileSync(path.join(
    root, 'server', 'app', 'api', 'runs', '[runId]', 'finish', 'route.ts'
  ), 'utf8');
  assert.match(html, /id="uploadHfBtn"/);
  assert.match(html, /id="keepLocalBtn"/);
  assert.match(popup, /\/api\/runs\/\$\{encodeURIComponent\(state\.runId\)\}\/hf-upload/);
  assert.doesNotMatch(popup, /\/api\/runs\/\$\{encodeURIComponent\(state\.runId\)\}\/finish/);
  assert.match(service, /process\.env\.HF_TOKEN/);
  assert.doesNotMatch(popup, /HF_TOKEN/);
  assert.match(service, /found\.run\.status|statusBeforeUpload\.run_status/);
  assert.match(uploadRoute, /SAFE_ID/);
  assert.match(finishRoute, /launcher_lifecycle_removed/);
});

test('compatibility launcher delegates website serving to Website Service', () => {
  const launcher = fs.readFileSync(path.join(
    root, 'server', 'scripts', 'start-with-tasks.mjs'
  ), 'utf8');
  assert.doesNotMatch(launcher, /startWebsiteServer|createServer/);
  assert.match(launcher, /WEBSITE_SERVICE_URL/);
  assert.match(launcher, /api\/v1\/artifact-jobs/);
});
