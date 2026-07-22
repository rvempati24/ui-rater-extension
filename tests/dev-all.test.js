const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('unified development launcher preserves three service processes and data roots', async () => {
  const launcher = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'dev-all.mjs')).href);
  const config = launcher.buildDevAllConfig({ UI_RATER_DEV_DATA_ROOT: '/tmp/ui-rater-dev-all-test' });
  assert.deepEqual(config.services.map((service) => service.name), ['website', 'collection', 'manager']);
  assert.equal(config.services[1].cwd, path.join(__dirname, '..', 'server'));
  assert.deepEqual(config.services.map((service) => service.healthUrl), [
    'http://127.0.0.1:4173/api/v1/health/ready',
    'http://127.0.0.1:3000/api/v1/health/ready',
    'http://127.0.0.1:4310/api/v1/health/ready',
  ]);
  const roots = [
    config.services[0].env.WEBSITE_SERVICE_DATA_DIR,
    config.services[1].env.UI_RATER_DATA_DIR,
    config.services[2].env.MANAGER_DATA_DIR,
  ];
  assert.equal(new Set(roots).size, 3);
  assert.deepEqual(roots, ['website', 'collection', 'manager'].map((name) => path.join(config.dataRoot, name)));
  assert.equal(config.services[2].env.WEBSITE_SERVICE_URL, 'http://127.0.0.1:4173');
  assert.equal(config.services[2].env.COLLECTION_SERVICE_URL, 'http://127.0.0.1:3000');
});
