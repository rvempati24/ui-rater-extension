const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('source context includes bounded source files and excludes build output', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-rater-source-'));
  try {
    fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'src', 'App.jsx'), 'export default function App() {}');
    fs.writeFileSync(path.join(fixture, 'dist', 'bundle.js'), 'generated');
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(fixture, 'notes.txt'), 'not source');

    const moduleUrl = pathToFileURL(path.join(
      __dirname, '..', 'server', 'lib', 'ux-analysis', 'source-context.ts'
    )).href;
    const module = await import(moduleUrl);
    const result = await module.collectSourceContext(fixture, path.basename(fixture));

    assert.equal(result.status, 'loaded');
    assert.deepEqual(result.files.map((file) => file.path).sort(), ['package.json', 'src/App.jsx']);
    assert.equal(result.truncated, false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('source context rejects a root for a different app', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-rater-source-'));
  try {
    const moduleUrl = pathToFileURL(path.join(
      __dirname, '..', 'server', 'lib', 'ux-analysis', 'source-context.ts'
    )).href;
    const module = await import(moduleUrl);
    await assert.rejects(
      module.collectSourceContext(fixture, 'another-app'),
      /does not match session app/
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('source context accepts a server-declared run id for a differently named local folder', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-rater-source-'));
  try {
    fs.mkdirSync(path.join(fixture, 'src'));
    fs.writeFileSync(path.join(fixture, 'src', 'App.jsx'), 'export default 1');
    const moduleUrl = pathToFileURL(path.join(
      __dirname, '..', 'server', 'lib', 'ux-analysis', 'source-context.ts'
    )).href;
    const module = await import(moduleUrl);
    const result = await module.collectSourceContext(fixture, 'remote-run-id', 'remote-run-id');
    assert.equal(result.status, 'loaded');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
