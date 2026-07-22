# UI Rater

UI Rater is a local research toolkit for recording how a participant completes a task on a synthetic website. It captures an interaction trace, action-linked screenshots, tab video, task outcomes, and website provenance. The resulting evidence can be audited, exported, or used in a controlled UX-analysis experiment.

Use it only with synthetic or mocked websites. The project does not currently provide privacy redaction for real-user browsing data.

## How it works

```text
Manager Service :4310  --publish/retire-->  Website Service :4173
          |                                      |
          +------ Study Revision -------------> |
          |                                      v
          +------ register/run/evidence --> Collection Service :3000
                                                   ^
                                                   |
                                            Chrome extension
```

The repository has three services plus the extension and analysis tooling:

| Part | Responsibility |
| --- | --- |
| Chrome extension (repository root) | Participant workflow, interaction capture, screenshots, and tab recording |
| `services/manager/` | Study specifications, task selection, publication, and retirement |
| `services/website-server/` | Website artifacts, acquisitions, deployments, and static serving |
| `server/` (Collection Service) | Study registrations, participant runs/attempts, APIs, and local evidence |
| `scripts/` | Evidence audit, export, Hugging Face sync, case materialization, and UX analysis |

Each participant can have multiple runs. A run fixes one website and an ordered task list. A task can have multiple immutable attempts, but at most one accepted attempt. The local participant tree is the source of truth; uploads are always explicit.

The extension talks only to Collection. Website target URLs are immutable assignment data, and Manager may be stopped after publication. The full service setup and recovery contract are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start: run the three services

### Requirements

- Chrome 116+
- Node.js 20.9+
- Python 3.10+ only for Hugging Face, export, audit, and analysis scripts

### 1. Install dependencies

From the repository root:

```bash
npm install
```

For normal local development, start all three services with the unified supervisor:

```bash
npm run dev:all
```

It starts Website, Collection, and Manager as three independent child processes, waits for all readiness endpoints, prefixes their logs, and stops the full group on `Ctrl+C` or if one service exits. The default owned roots are `data/website`, `data/collection`, and `data/manager`; set `UI_RATER_DEV_DATA_ROOT` to move the common parent, or set the three service-specific data-root variables individually.

Inspect the resolved commands, URLs, and roots without starting anything:

```bash
npm run dev:all -- --print-config
```

Website, Collection, and Manager listen on `4173`, `3000`, and `4310` by default. The launcher is only a development supervisor: it does not merge service code, storage, or lifecycle state.

To operate the services separately, use three terminals:

```bash
WEBSITE_SERVICE_DATA_DIR="$PWD/data/website" npm run dev:website
UI_RATER_DATA_DIR="$PWD/data/collection" npm --workspace server run dev
MANAGER_DATA_DIR="$PWD/data/manager" npm run dev:manager
```

### 2. Load the Chrome extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the repository root, not `server/`.
4. Open the extension popup.
5. Enter `P001`, Collection URL `http://localhost:3000`, and the Study Revision ID printed by the Manager publication flow.
6. Click **Load Tasks**.

On a fresh Collection data root, valid participant IDs are bootstrapped from [`server/config/participants.json`](server/config/participants.json) into Collection-owned `data/collection/config/participants.json`. Later admin updates write only the Collection data root.

### 3. Complete the task

1. Follow the popup button to open the task website and start recording.
2. Complete the task naturally on the synthetic site.
3. Click **Done**, then choose **Task Succeeded** or **Task Failed**.
4. After the final task, choose **Keep Local Only**.

With the commands above, evidence is under `data/collection/participants/P001/`. Closing and reopening the popup restores an unfinished workflow from `chrome.storage.local`.

## Run a custom study

Use the Manager CLI to import a website through Website Service, create a Study Specification, and publish an immutable Study Revision. The compatibility `server/scripts/start-with-tasks.mjs` wrapper still accepts the historical selector flags, but it no longer starts or stops another service.

### Use a local website

The website directory must contain:

```text
website-run/
  dist/index.html
  trials-config.json
```

Import the website, then create and publish a study (source positions 1, 3, and 5):

```bash
npm run manager:cli -- import-local \
  --website-dir /absolute/path/to/website-run \
  --task-file /absolute/path/to/website-run/trials-config.json
# Copy operation.result.websiteArtifactId and websiteAcquisitionId from the poll result.
npm run manager:cli -- create-study --study-id study-pilot-01 \
  --artifact-id <website-artifact-id> --acquisition-id <website-acquisition-id> --tasks 1,3,5
npm run manager:cli -- publish --study-id study-pilot-01
```

Relative paths are resolved by the invoking CLI. Use an absolute path when sharing commands with other operators.

### Use a Hugging Face website

Install the optional downloader once:

```bash
python3 -m pip install huggingface_hub
```

`dev:tasks` remains the compatibility path for Hugging Face selectors (the three services must already be running):

```bash
npm --workspace server run dev:tasks -- \
  --hf-website "kimi-k2.7-code/amtrak/20260625-164105-amtrak" \
  --tasks 1 3 5
```

Or reproducibly choose a random website and three random tasks:

```bash
npm --workspace server run dev:tasks -- --random 3 --seed pilot-01
```

Public website downloads need no token. For a private source, set `HF_TOKEN` in the shell that starts Website Service, because that service owns the loader process; uploads are configured separately below.

### Task-selection options

| Option | Meaning |
| --- | --- |
| `--all` | Use all available tasks; this is the default |
| `--tasks 1 3 5` | Use exact 1-based positions from the source task file |
| `--random [N]` | Choose one task, or a sample of `N` tasks |
| `--seed <value>` | Make website/task sampling reproducible |
| `--mind2web` | Keep only tasks identified as Mind2Web tasks |
| `--dry-run` | Print the source request and selector without loading, publishing, or starting servers |

Run `npm --workspace server run dev:tasks -- --help` for the complete option list.

## What a normal participant run looks like

For every task, the participant opens the task site, starts recording, performs the task, and reports an outcome:

| Choice | Result |
| --- | --- |
| **Task Succeeded** | Accepts the attempt and completes the task |
| **Task Failed → Retry Task** | Retains the failed evidence and starts a new attempt |
| **Task Failed → Do Not Retry** | Retains the evidence and closes the task as failed |
| **Skip Task** | Closes the task without an accepted attempt |
| **Recording Problem** | Invalidates the recorder-failure attempt and leaves the task available to retry |

Retries never overwrite earlier attempts. If the same participant needs a new task selection, enable **Start a new run** before loading tasks. Use a fresh participant ID for a clean pilot.

The compatibility wrapper delegates to the already-running services and does not control their lifetime; use the service terminals to stop or restart them.

## Evidence and storage

The canonical layout is:

```text
data/participants/<participant-id>/
  participant.json
  runs/<run-id>/
    run.json
    tasks/<position>-<assignment-id>/
      task.json
      attempts/<number>-<attempt-id>/
        attempt.json
        manifest.json
        trace.json
        recording.webm
        snapshots/
```

`data/sessions/`, `data/recordings/`, and `data/results.json` are compatibility outputs. Clearing the extension cache never deletes server-side evidence.

The recorder captures important actions, edits, submissions, navigation states, settled scroll states, and task boundaries. “Before” screenshots are best effort; their timing metadata must be checked before treating them as guaranteed pre-action evidence.

Current operating boundaries:

- one host and one shared local data directory;
- one task tab per attempt; multi-tab stitching is not supported;
- filesystem-backed state rather than a database or distributed lock service;
- no automated website modification and no real-site privacy redaction.

See [`docs/REPAIR_CONTRACT.md`](docs/REPAIR_CONTRACT.md) for the full reliability and analysis contract.

## Audit, export, and upload

Run the read-only integrity audit from the repository root:

```bash
sh scripts/audit-evidence.sh
```

Preview a local export, then create it:

```bash
sh scripts/export-traces.sh --dry-run
sh scripts/export-traces.sh
```

The default accepted export is written to `exports/ux-task-trace/`. Use `--mode audit` to include failed and invalidated terminal attempts. Export behavior is configured in [`scripts/trace-export.example.json`](scripts/trace-export.example.json); copy it to the ignored `scripts/trace-export.local.json` before making local changes.

Hugging Face upload is opt-in. Put the following in `server/.env.local` to enable the completion-screen upload:

```dotenv
HF_TOKEN=hf_your_write_token
HF_DATASET_REPO=uxBench/ux-task-trace
HF_DATASET_REVISION=participant-v3-integrity
```

For a command-line upload, set the same environment variables and run:

```bash
sh scripts/export-traces.sh --upload-hf
```

The token remains in the server or script process and is not sent to the extension. Uploading never deletes local evidence.

PowerShell wrappers are available for export, migration, reconciliation, case materialization, and agent analysis. On Windows, run the evidence audit directly with `python scripts\audit_evidence.py`.

## Analyze one accepted attempt

Materialize an immutable case from the local participant tree:

```bash
sh scripts/materialize-case.sh \
  --attempt-id <attempt-id> \
  --output .cases/<attempt-id>
```

If the original local website cannot be resolved from run metadata, also pass `--website-source /absolute/path/to/website-run`. The materializer can instead read from Hugging Face with `--hf-repo` and `--hf-revision`.

Run Method 1 with an authenticated Codex CLI:

```bash
codex login status
sh scripts/run-ux-experiment.sh \
  --case .cases/<attempt-id> \
  --methods 1
```

The primary controlled comparison uses `--methods 1,3`. Method 3 additionally requires a loopback CLIProxyAPI Responses endpoint (default `http://127.0.0.1:8317/v1`). Results are written inside the immutable case revision under `output/`.

See [`docs/UX_ANALYSIS_HARNESS.md`](docs/UX_ANALYSIS_HARNESS.md) for method definitions, isolation rules, and comparison requirements.

## Configuration

| File or variable | Purpose |
| --- | --- |
| `server/config/participants.json` | Bootstrap participant IDs for a fresh Collection data root |
| `server/.env.local` | Local secrets and environment overrides |
| `UI_RATER_DATA_DIR` | Override the entire local data directory |
| `UI_RATER_SESSION_DIR` | Override only compatibility session storage |
| `UI_RATER_ADMIN_TOKEN` | Protect admin APIs outside localhost |
| `UI_RATER_CAPABILITY_SECRET` | Required for scoped capabilities in production |

Start from `server/.env.example` for deployment-related settings. Never commit `.env.local` or access tokens.

## Development checks

Run the same workspace checks used by CI from the repository root:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e

module load python/3.9.5
python -m unittest discover -s tests -p 'test_*.py' -v
```

## Further documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — services, runtime flows, local setup, storage, and recovery
- [`docs/REPAIR_CONTRACT.md`](docs/REPAIR_CONTRACT.md) — current reliability, integrity, and scope contract
- [`docs/PARTICIPANT_MANAGEMENT_V2.md`](docs/PARTICIPANT_MANAGEMENT_V2.md) — participant/run/task/attempt model
- [`docs/HF_PARTICIPANT_DATASET_V2.md`](docs/HF_PARTICIPANT_DATASET_V2.md) — export layout and synchronization model
- [`docs/LLM_AGENT_SANDBOX_V2.md`](docs/LLM_AGENT_SANDBOX_V2.md) — immutable analysis-case contract
- [`docs/UX_ANALYSIS_HARNESS.md`](docs/UX_ANALYSIS_HARNESS.md) — Method 1–4 analysis harness

Files under `docs/superpowers/` are historical design records and do not override the current contract.
