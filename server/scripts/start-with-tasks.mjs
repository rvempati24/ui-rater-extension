/**
 * Compatibility operator wrapper.
 *
 * It keeps the old selector flags, but all runtime work now goes through the
 * Website Service and Manager APIs. It deliberately does not spawn Next.js,
 * copy into server/public/apps, or exchange task metadata through env/files.
 * Start the three services separately with `npm run dev:website`, the normal
 * Collection server command, and `npm run dev:manager`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `Usage: npm run dev:tasks -- [options]\n\n` +
    `  --website-dir <folder>    Import a local website through Website Service\n` +
    `  --tasks-json <file>       Task catalog for a local website\n` +
    `  --hf-website <path>       Exact remote website selector\n` +
    `  --hf-model <name>         Restrict remote selection by model\n` +
    `  --hf-site <name>          Restrict remote selection by website\n` +
    `  --hf-revision <revision>  Dataset revision\n` +
    `  --all                     Use all artifact tasks (default)\n` +
    `  --random [n]              Deterministic random selection\n` +
    `  --tasks <1 3 5|1,3,5>     Select source positions\n` +
    `  --mind2web                Keep only Mind2Web tasks\n` +
    `  --seed <text>             Reproduce random selection\n` +
    `  --dry-run                 Print the frozen specification without registering it\n` +
    `  --help                    Show this help`;
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseTaskNumbers(values) {
  const tokens = values.flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);
  if (!tokens.length) throw new Error('--tasks requires at least one task number.');
  const numbers = tokens.map(Number);
  if (numbers.some((number) => !Number.isInteger(number) || number < 1)) throw new Error('--tasks accepts positive integers.');
  if (new Set(numbers).size !== numbers.length) throw new Error('--tasks contains duplicate task numbers.');
  return numbers;
}

export function parseArgs(args) {
  const options = { taskValues: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') options.help = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--mind2web') options.mind2webOnly = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--website-dir') options.websiteDir = takeValue(args, index++, arg);
    else if (arg === '--tasks-json') options.taskFile = takeValue(args, index++, arg);
    else if (arg === '--hf-website') options.hfWebsite = takeValue(args, index++, arg);
    else if (arg === '--hf-model') options.hfModel = takeValue(args, index++, arg);
    else if (arg === '--hf-site') options.hfSite = takeValue(args, index++, arg);
    else if (arg === '--hf-revision') options.hfRevision = takeValue(args, index++, arg);
    else if (arg === '--seed') options.seed = takeValue(args, index++, arg);
    else if (arg === '--random') {
      const next = args[index + 1];
      options.randomCount = next && !next.startsWith('--') ? Number(args[++index]) : 1;
    } else if (arg === '--tasks') {
      while (args[index + 1] && !args[index + 1].startsWith('--')) options.taskValues.push(args[++index]);
      if (!options.taskValues.length) throw new Error('--tasks requires task numbers.');
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  }
  if (options.all && (options.randomCount != null || options.taskValues.length)) throw new Error('--all cannot be combined with --random or --tasks.');
  if (options.randomCount != null && options.taskValues.length) throw new Error('--random and --tasks are mutually exclusive.');
  if (options.websiteDir && (options.hfWebsite || options.hfModel || options.hfSite)) throw new Error('--website-dir cannot be combined with remote selectors.');
  return options;
}

async function requestJson(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${pathname}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error || `${response.status} ${response.statusText}`);
  return body;
}

async function waitForOperation(managerUrl, operationId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await requestJson(managerUrl, `/api/v1/publication-operations/${encodeURIComponent(operationId)}`);
    const operation = body.operation;
    if (operation.status === 'succeeded') return operation;
    if (operation.status === 'failed_terminal') throw new Error(operation.error?.message || 'Publication failed permanently');
    if (operation.status === 'failed_retryable') throw new Error(operation.error?.message || 'Publication needs retry');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for Manager publication');
}

function selectorFromOptions(options) {
  if (options.mind2webOnly) return { kind: 'mind2web' };
  if (options.taskValues.length) return { kind: 'positions', positions: parseTaskNumbers(options.taskValues) };
  if (options.randomCount != null) return { kind: 'random', count: options.randomCount, seed: options.seed || randomBytes(8).toString('hex') };
  return { kind: 'all' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const websiteUrl = (process.env.WEBSITE_SERVICE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
  const managerUrl = (process.env.MANAGER_SERVICE_URL || 'http://127.0.0.1:4310').replace(/\/$/, '');
  let websiteSource;
  if (options.websiteDir) {
    const source = { kind: 'local', path: path.resolve(serverDir, options.websiteDir), taskFile: options.taskFile ? path.resolve(serverDir, options.taskFile) : undefined };
    if (options.dryRun) {
      console.log(JSON.stringify({ websiteSource: source, taskSelector: selectorFromOptions(options), dryRun: true }, null, 2));
      return;
    }
    const job = await requestJson(websiteUrl, '/api/v1/artifact-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `compat-local:${source.path}:${source.taskFile || ''}` }, body: JSON.stringify(source),
    });
    let operation = job.operation;
    while (!['succeeded', 'failed_retryable', 'failed_terminal'].includes(operation.status)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      operation = (await requestJson(websiteUrl, `/api/v1/artifact-jobs/${encodeURIComponent(operation.operationId)}`)).operation;
    }
    if (operation.status !== 'succeeded') throw new Error(operation.error?.message || 'Website import failed');
    websiteSource = {
      kind: 'artifact', websiteArtifactId: operation.result.websiteArtifactId,
      websiteAcquisitionId: operation.result.websiteAcquisitionId,
    };
  } else {
    websiteSource = {
      kind: 'huggingface', repoId: 'uxBench/website-generation', revision: options.hfRevision,
      website: options.hfWebsite, model: options.hfModel, selector: options.hfSite,
    };
    if (options.dryRun) {
      console.log(JSON.stringify({ websiteSource, taskSelector: selectorFromOptions(options), dryRun: true }, null, 2));
      return;
    }
  }
  const study = {
    schemaVersion: 1,
    studyId: `study_${randomUUID()}`,
    websiteSource,
    taskSelector: selectorFromOptions(options),
  };
  const created = await requestJson(managerUrl, '/api/v1/studies', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `compat-study:${study.studyId}` }, body: JSON.stringify(study),
  });
  const published = await requestJson(managerUrl, `/api/v1/studies/${encodeURIComponent(created.study.study_id || created.study.studyId)}/publish`, { method: 'POST' });
  const operation = await waitForOperation(managerUrl, published.operation.operationId);
  const finalStudy = await requestJson(managerUrl, `/api/v1/studies/${encodeURIComponent(created.study.study_id || created.study.studyId)}`);
  console.log(`Study: ${finalStudy.study.study_id}`);
  console.log(`Study Revision: ${finalStudy.study.study_revision_id}`);
  console.log(`Collection URL: ${process.env.COLLECTION_SERVICE_URL || 'http://127.0.0.1:3000'}`);
  console.log(`Publication: ${operation.operationId}`);
}

main().catch((error) => { console.error(`Task selection failed: ${error.message}`); process.exitCode = 1; });
