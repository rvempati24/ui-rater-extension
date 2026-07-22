const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function runWriter(serverDir, moduleUrl, dataDir) {
  const program = `
    import { withResultsLock } from ${JSON.stringify(moduleUrl)};
    await withResultsLock(async (data) => {
      const current = Number(data.P001?.counter || 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      data.P001 = { ...(data.P001 || { trials: [] }), counter: current + 1 };
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', program,
    ], {
      cwd: serverDir,
      env: { ...process.env, UI_RATER_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`writer exited ${code}: ${stderr}`));
    });
  });
}

test('cross-process results mutations are serialized without losing an update', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-rater-lock-'));
  const serverDir = path.join(__dirname, '..', 'server');
  const moduleUrl = pathToFileURL(path.join(serverDir, 'lib', 'results.ts')).href;
  fs.writeFileSync(path.join(dataDir, 'results.json'), JSON.stringify({
    P001: { trials: [], counter: 0 },
  }));
  try {
    await Promise.all([
      runWriter(serverDir, moduleUrl, dataDir),
      runWriter(serverDir, moduleUrl, dataDir),
    ]);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'results.json'), 'utf8'));
    assert.equal(stored.P001.counter, 2);
    assert.deepEqual(stored.P001.trials, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
