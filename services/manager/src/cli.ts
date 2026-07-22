import crypto from 'node:crypto';
import path from 'node:path';
import { requestDigest } from '@ui-rater/contracts';
import { loadConfig } from './config.ts';
import { requestJson } from './clients/http.ts';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = await loadConfig();
  const command = args[0] || 'help';
  if (command === 'help') {
    console.log('manager create-study --study-id ID --artifact-id WSA --acquisition-id WAC [--tasks 1,3] [--dry-run]');
    console.log('manager publish --study-id ID');
    console.log('manager import-local --website-dir DIR --task-file FILE');
    return;
  }
  if (command === 'import-local') {
    const websiteDir = value(args, '--website-dir');
    if (!websiteDir) throw new Error('--website-dir is required');
    const source: Record<string, unknown> = { kind: 'local', path: path.resolve(websiteDir) };
    const taskFile = value(args, '--task-file');
    if (taskFile) source.taskFile = path.resolve(taskFile);
    const key = `operator-import:${requestDigest(source)}`;
    const response = await requestJson<{ operation: { operationId: string } }>(config.websiteUrl, '/api/v1/artifact-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(source),
    }, config.requestTimeoutMs);
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (command === 'create-study') {
    const studyId = value(args, '--study-id') || `study_${crypto.randomUUID()}`;
    const artifactId = value(args, '--artifact-id');
    const acquisitionId = value(args, '--acquisition-id');
    if (!artifactId || !acquisitionId) throw new Error('--artifact-id and --acquisition-id are required');
    const positions = value(args, '--tasks')?.split(',').filter(Boolean).map(Number);
    const specification = {
      schemaVersion: 1, studyId,
      websiteSource: { kind: 'artifact', websiteArtifactId: artifactId, websiteAcquisitionId: acquisitionId },
      taskSelector: positions?.length ? { kind: 'positions', positions } : { kind: 'all' },
    };
    if (args.includes('--dry-run')) { console.log(JSON.stringify({ study: specification, dryRun: true }, null, 2)); return; }
    const response = await requestJson(`http://${config.host}:${config.port}`, '/api/v1/studies', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `study:${studyId}` }, body: JSON.stringify(specification),
    }, config.requestTimeoutMs);
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (command === 'publish') {
    const studyId = value(args, '--study-id');
    if (!studyId) throw new Error('--study-id is required');
    const managerUrl = `http://${config.host}:${config.port}`;
    const response = await requestJson(managerUrl, `/api/v1/studies/${encodeURIComponent(studyId)}/publish`, { method: 'POST' }, config.requestTimeoutMs);
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  throw new Error(`Unknown manager command: ${command}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
