const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
function files(dir, suffix = '.ts') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full, suffix);
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}
function text(file) { return fs.readFileSync(file, 'utf8'); }

test('service ownership boundaries remain explicit', () => {
  const collection = files(path.join(root, 'server')).map(text).join('\n');
  const manager = files(path.join(root, 'services', 'manager')).map(text).join('\n');
  const website = files(path.join(root, 'services', 'website-server')).map(text).join('\n');
  assert.doesNotMatch(collection, /services\/(website-server|manager)/);
  assert.doesNotMatch(collection, /UI_RATER_(SHUTDOWN_FILE|DEFER_SHUTDOWN_FOR_COMPLETION_CHOICE)/);
  assert.doesNotMatch(manager, /server\/lib|server\/app|services\/website-server/);
  assert.doesNotMatch(website, /server\/public|PARTICIPANT_DATA_DIR|UI_RATER_DATA_DIR/);
  assert.doesNotMatch(website, /GeneratorProvider|generator-provider|generator_not_configured/);
  assert.doesNotMatch(manager, /kind:\s*['"]generator['"]|generator_not_configured/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'packages', 'contracts', 'src', 'website.ts'), 'utf8'), /['"]generator['"]/);
  assert.match(website, /validateWebsiteSourceRequest/);
  assert.doesNotMatch(collection, /getTrialConfigs|generateTrials|getActiveWebsiteMetadata|UI_RATER_TRIALS_CONFIG|UI_RATER_WEBSITE_METADATA_FILE|UI_RATER_WEBSITE_RUN_ID/);
  assert.match(text(path.join(root, 'server', 'app', 'api', 'tasks', 'route.ts')), /legacy_tasks_route_removed/);
  assert.match(text(path.join(root, 'server', 'app', 'api', 'participants', '[participantId]', 'runs', 'route.ts')), /legacy_participant_runs_route_removed/);
  assert.equal(fs.existsSync(path.join(root, 'server', 'config', 'apps-manifest.json')), false);
  assert.deepEqual(files(path.join(root, 'server', 'public', 'apps'), ''), []);
});

test('extension has one control origin and treats target URLs as assignment data', () => {
  const extension = ['background.js', 'popup.js', 'offscreen.js', 'content.js'].map((name) => text(path.join(root, name))).join('\n');
  assert.doesNotMatch(extension, /api\/v1\/(studies|publication-operations)/);
  assert.match(extension, /collectorUrl/);
  assert.match(text(path.join(root, 'popup.js')), /studyRevisionId/);
});

test('new deployment routing uses a dedicated origin label', () => {
  const deployment = text(path.join(root, 'services', 'website-server', 'src', 'storage', 'deployment-store.ts'));
  assert.match(deployment, /routingLabel/);
  assert.match(deployment, /runtimeSuffix/);
  assert.doesNotMatch(deployment, /\/sites\//);
});

test('canonical Method 3 materialization is Collection-only and source-free', () => {
  const materializer = text(path.join(root, 'scripts', 'materialize_method3_case.py'));
  const wrapper = text(path.join(root, 'scripts', 'materialize-case.sh'));
  assert.match(wrapper, /materialize_method3_case\.py/);
  assert.doesNotMatch(materializer, /resolve_source|--website-source|hf-websites|website source/i);
  assert.doesNotMatch(materializer, /services\/website-server|services\/manager|Manager client|Website Service client/);
  assert.match(materializer, /study_revision_digest/);
  assert.match(materializer, /recording\.webm/);
});
