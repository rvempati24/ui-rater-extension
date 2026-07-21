# UI Rater Extension - UX Analysis Baseline

This Chrome extension records interaction traces, tab video, and action-linked screenshots while a user completes a task on a synthetic website. Important activations, edits, submissions, and navigations are captured before and after when the browser permits it; settled scroll states and task boundaries are also captured. Pre-action captures are explicitly best-effort and record request/start/completion timing so analysis can verify whether the image actually preceded the linked action. The local Next.js server stores one directory per task and can send the trace plus screenshots to an LLM for task-specific UX problem identification.

## Baseline scope

The current version includes:

- durable task traces backed by `chrome.storage.local`;
- one immutable `data/sessions/<session-id>/` directory per recording attempt;
- before/after screenshots for important actions, plus task boundaries and settled scroll states;
- globally unique action IDs across full-page navigations and a reserved final screenshot slot for `task-end`;
- one-pass multimodal UX analysis with evidence IDs;
- optional bounded website source context and ranked source-file candidates;
- optional local export and optional upload to [`uxBench/ux-task-trace`](https://huggingface.co/datasets/uxBench/ux-task-trace).

It intentionally does not include a database, job queue, multi-agent pipeline, autonomous repository exploration, automatic code changes, or privacy redaction for real websites. The model can receive a bounded read-only source snapshot, but it cannot browse or edit the repository. Use it only with the current synthetic test sites unless those safeguards are added.

## Feature quick reference

| Goal | Entry point |
| --- | --- |
| Start the default local server | `cd server && npm run dev` |
| Select local website tasks | `npm run dev:tasks -- --website-dir <dir> --tasks-json <file> --tasks 1 3 5` |
| Randomly select one or N tasks | add `--random` or `--random N`; add `--seed <value>` for reproducibility |
| Select all or Mind2Web tasks | add `--all` or `--mind2web` |
| Select/download an HF website | add `--hf-website <model/site/run>` or use `--hf-model`/`--hf-site`; omit all three for a random run |
| Preview selection only | add `--dry-run` |
| Start another run for the same participant | check **Start a new run** in the extension |
| Report a broken recording and retry | click **Recording Problem**; if a save is stuck, use **Mark Recording Problem**; the invalidated attempt is retained |
| Prepare LLM input without a model call | `POST /api/sessions/<session-id>/analyze?prepareOnly=1` |
| Run LLM analysis | `POST /api/sessions/<session-id>/analyze` |
| Preview/export/upload traces | use `scripts/export-traces.ps1` on Windows or `scripts/export-traces.sh` on Linux/macOS |
| Build a coding-agent case | use `scripts/materialize-case.ps1` or `scripts/materialize-case.sh` |
| Compare evidence-only vs source-explore UX analysis | use `scripts/run-agent-analysis.ps1` or `scripts/run-agent-analysis.sh` |

The sections below give complete commands, configuration, expected outputs, and validation steps for each entry point.

## Requirements

- Chrome 116+
- Node.js 18+
- Python 3.10+ for Hugging Face website download and trace export
- `huggingface_hub` for website download or trace upload

## Quick Start: test a Hugging Face website and upload the trace

This path downloads a synthetic website from [`uxBench/website-generation`](https://huggingface.co/datasets/uxBench/website-generation/tree/prompt-userflow-regen-20260624), lets a participant complete selected tasks, stores the evidence locally, and optionally uploads the accepted attempts to [`uxBench/ux-task-trace`](https://huggingface.co/datasets/uxBench/ux-task-trace/tree/participant-v2).

### 1. Install the local dependencies

Windows PowerShell:

```powershell
cd D:\LTL-UI\third_party\ui-rater-extension
cd server
npm install
python -m pip install huggingface_hub
```

Linux/macOS:

```bash
cd /path/to/ui-rater-extension/server
npm install
python3 -m pip install huggingface_hub
```

If `python` is not discoverable, set `PYTHON` to the absolute Python executable before running `dev:tasks`; the same interpreter is used for website download and completion-screen upload.

Create `server/.env.local` if you want the completion screen to offer a live upload:

```dotenv
HF_TOKEN=hf_your_write_token
HF_DATASET_REPO=uxBench/ux-task-trace
HF_DATASET_REVISION=participant-v2
```

The token stays in the server process and is never sent to the Chrome extension. Omit `HF_TOKEN` when you only want local recording.

### 2. Preview or start a website

To reproducibly choose a random website and three random tasks, preview the selection first:

```powershell
npm run dev:tasks -- --random 3 --seed pilot-01 --dry-run
```

Remove `--dry-run` to download, serve, and test that selection:

```powershell
npm run dev:tasks -- --random 3 --seed pilot-01
```

The same commands work in Linux/macOS shells. The seed controls both the website and task sample.

To test an exact website-generation run and task numbers 1, 3, and 5:

```powershell
npm run dev:tasks -- `
  --hf-website "kimi-k2.7-code/amtrak/20260625-164105-amtrak" `
  --tasks 1 3 5
```

Linux/macOS:

```bash
npm run dev:tasks -- \
  --hf-website "kimi-k2.7-code/amtrak/20260625-164105-amtrak" \
  --tasks 1 3 5
```

You can also randomly choose a run within a model/site subset:

```powershell
npm run dev:tasks -- --hf-model "qwen3.7-plus" --hf-site "amtrak" --random 3 --seed pilot-01
```

Useful task selectors are:

- `--random` for one random task;
- `--random N` for N random tasks;
- `--tasks 1 3 5` for exact 1-based source task numbers;
- `--mind2web` to keep only original Mind2Web tasks;
- `--all` for every available task.

The terminal prints the exact model, website, run ID, dataset revision, selected source task numbers, task prompts, and local URLs. Leave this terminal running during the test.

### 3. Load the Chrome extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `ui-rater-extension` repository root, not `server/`.
4. Open the extension and enter a participant ID such as `P001`.
5. Set **Server URL** to `http://localhost:3000`.
6. Check **Start a new run** when reusing a participant after changing the website or task selection.
7. Click **Load Tasks**.

### 4. Record the tasks

For each task:

1. Click **Open Task Website** or **Start Recording**.
2. Complete the task on the synthetic website.
3. Click **Done**.
4. Choose **Task Succeeded** or **Task Failed**. Use **Skip Task** for an intentional skip and **Recording Problem** only for recorder/software failures.
5. Continue to the next task. The extension reuses the same website tab.

Every attempt is saved under `data/participants/<participant-id>/runs/<run-id>/`, including its trace, screenshots, video, task metadata, outcome, and website provenance.

### 5. Upload or keep the completed run local

After the final task, choose one completion action:

- **Upload to Hugging Face** validates and uploads only the current completed run's accepted attempts. It retains all local evidence and merges the remote participant/run/attempt indexes.
- **Keep Local Only** performs no Hugging Face write and retains the same local evidence.

Without `--keep-open`, localhost closes after the choice completes. If upload fails, localhost stays available so you can retry or choose **Keep Local Only**.

After a successful upload, verify the local sync receipt:

```powershell
$runId = "run_replace_with_the_reported_id"
Get-Content "..\data\sync-state\$runId.json"
```

Linux/macOS:

```bash
run_id="run_replace_with_the_reported_id"
cat "../data/sync-state/$run_id.json"
```

For a read-only remote checksum comparison, return to the repository root and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\reconcile-hf.ps1
```

```bash
sh scripts/reconcile-hf.sh --hf-repo uxBench/ux-task-trace --hf-revision participant-v2
```

## Codex authentication on the analysis worker

The analysis runner directly reuses the machine's existing Codex login. Check it once with `codex login status`; no API proxy or separate API key is required.

## Start the server

```bash
cd server
npm install
npm run dev
```

The server listens on `http://localhost:3000`. By default sessions are stored in `data/sessions` at the extension repository root. To use another canonical folder, set an absolute path before starting the server:

PowerShell:

```powershell
$env:UI_RATER_SESSION_DIR = "D:\ui-rater-data\sessions"
npm run dev
```

Linux/macOS:

```bash
export UI_RATER_SESSION_DIR=/var/tmp/ui-rater/sessions
npm run dev
```

## Load the extension

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this repository directory, not `server/`.
4. Enter the participant ID and `http://localhost:3000` in the popup.
5. Complete a synthetic task, click **Done**, then choose **Task Succeeded** or **Task Failed**.
6. After the final task, choose **Upload to Hugging Face** or **Keep Local Only**. Neither choice deletes local evidence.

Reloading the extension does not clear its participant, task, recording, or pending-outcome state because these values live in `chrome.storage.local`. The always-visible **Clear Cache** button clears only browser-side Extension state; it never calls the server reset API or deletes saved evidence. Cache clearing is blocked while an attempt is recording, finalizing, or waiting for a result. Resolve the active attempt first. After clearing, enter the participant ID and server URL and load tasks again. **Start Over** clears the same run-selection state after a completed run.

## End-to-end local pilot

Start the server with an explicit website, task file, and source task positions. PowerShell uses backticks for line continuation:

```powershell
cd server
npm run dev:tasks -- `
  --website-dir "../../../uxBench/allrecipes" `
  --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" `
  --tasks 1 3 5
```

The terminal should report `Selected 3/... tasks`, the task API on `http://localhost:3000`, and the synthetic website on `http://localhost:4173`. Keeping the website on a separate origin lets Vite assets and client-side routes such as `/deals` work without colliding with Next.js. Use `--website-port <port>` if 4173 is occupied. If Next.js switches to port 3001 or reports a `.next` lock, stop the older server before testing; otherwise the extension may still talk to an earlier task configuration.

By default, `dev:tasks` waits after every selected task reaches `completed`, `skipped`, or `failed_no_retry`. The Extension then offers **Upload to Hugging Face** and **Keep Local Only**. Localhost stops about one second after that choice finishes, so an upload can complete before the launcher exits. Add `--keep-open` when testing multiple participants against the same selected task configuration; the completion choice still appears, but it does not stop that launcher.

The upload button is available only when the server process has `HF_TOKEN` and Python can import `huggingface_hub`. Put the token in `server/.env.local` or the environment used to start the server; it is never returned to the Extension. Optional `HF_DATASET_REPO` and `HF_DATASET_REVISION` values override the defaults `uxBench/ux-task-trace` and `participant-v2`.

Completion-screen upload stages only the current participant/run in a temporary directory. It does not replace the configured persistent `exports/` folder. Canonical evidence remains under `data/participants/`, and the uploader merges the remote query indexes before committing the current run.

Within one run, the extension reuses the same website tab for every task. Starting the next task navigates that tab back to the configured website URL; a new tab is created only when the previous task tab was closed or is no longer available.

Use a valid participant ID that has not requested tasks from this server data directory. Before opening the extension, verify the server-side assignment:

```powershell
Invoke-RestMethod `
  "http://localhost:3000/api/tasks?participantId=P004" |
  ConvertTo-Json -Depth 5
```

The response should contain `totalTasks: 3`. For `--tasks 1 3 5`, the task entries have run `position` values `1, 2, 3` and original `source_position` values `1, 3, 5`. Loading the extension afterwards should show `Task 1 of 3`.

## Select tasks when starting the server

Use `dev:tasks` to select both a synthetic website and its tasks. A local website source takes priority. If none is provided, the launcher selects and caches a run from [`uxBench/website-generation`](https://huggingface.co/datasets/uxBench/website-generation/tree/prompt-userflow-regen-20260624). Install the downloader once with `python -m pip install huggingface_hub`.

Prefer a local website and run every task:

```bash
cd server
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --all
```

Run one random task, or a reproducible random sample of five:

```bash
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --random
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --random 5 --seed pilot-01
```

Run source tasks 1, 3, and 5 in that order:

```bash
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --tasks 1 3 5
```

Run all original Mind2Web tasks, or randomly choose three of them:

```bash
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --mind2web
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --mind2web --random 3 --seed pilot-01
```

Download an exact Hugging Face run, or randomly select a run with optional filters:

```bash
npm run dev:tasks -- --hf-website "deepseek-v4-flash-free/allrecipes/20260625-090547-allrecipes" --tasks 1 3 5
npm run dev:tasks -- --hf-model "qwen3.7-plus" --hf-site "allrecipes" --random 2 --seed pilot-01
npm run dev:tasks -- --random --seed pilot-01
```

In the last command, the website and one task are both selected reproducibly. `--random` controls task sampling; remote website selection is automatically random whenever no local or exact HF run is supplied.

`--mind2web` recognizes task metadata (`source`, `origin`, or `task_source` set to `mind2web`, or `is_mind2web: true`). It also automatically matches prompts against an adjacent `mind2web_tasks.txt`; use `--mind2web-tasks <file>` to supply a different list. Add `--dry-run` to provision/resolve the website and inspect selected tasks without starting Next.js, and `--help` for all options.

Downloaded runs are cached under `server/.website-cache/` and their `dist/` files are deployed under `server/public/apps/<run-id>/`. The launcher records repository, revision, commit SHA, `model/website/run-id`, source URL, file metadata, and pre-existing metadata filenames in `ui-rater-website.json`. A compact copy plus `attempt_id` is retained in each completed session manifest.

The commands are identical in PowerShell, Linux, and macOS. Task numbers always refer to positions in the source JSON, while the selected run is reindexed from 1. In the extension, check **Start a new run** after changing the selection; leave it unchecked to resume that participant's active run. Public downloads need no token; `HF_TOKEN` is used automatically when the source dataset requires authentication.

## Participant management v2

The implemented MVP separates a stable **participant**, a configured **run**, each **task assignment**, and one or more **attempts** for that task. A participant can have multiple runs; a task can be retried without deleting its earlier evidence; and at most one attempt is accepted for analysis/export.

The participant-facing outcome flow is deliberately separate from recording:

1. **Done** stops recording and saves trace, screenshots, and video. The attempt becomes `completed_pending_outcome`; it is not accepted yet.
2. **Task Succeeded** changes that attempt to `accepted`, changes the task to `completed`, and sets `accepted_attempt_id`.
3. **Task Failed** asks whether to retry. **Retry Task** keeps the failed evidence and leaves the task pending; the next recording receives attempt number 2. **Do Not Retry** changes the task to `failed_no_retry` and advances.
4. **Skip Task** saves any active evidence, records outcome `skipped` with reason `participant_skipped`, and advances without an accepted attempt.
5. **Recording Problem** saves available evidence, invalidates the attempt with a reason, and leaves the task pending for a fresh attempt. If a closed task tab or missing recorder interrupts finalization, the recovery screen offers **Mark Recording Problem**. A retryable video upload remains protected for retry; genuinely unavailable video/final flush is recorded in the session manifest instead of being silently treated as saved.
6. After all tasks are terminal, **Upload to Hugging Face** uploads the current completed run's accepted attempts, while **Keep Local Only** performs no external write. Upload failure leaves both buttons available for retry or a local-only finish.

The background service worker persists one workflow state for `starting`, `recording`, evidence finalization, outcome submission, and retry choice. Closing and reopening the popup therefore restores the correct screen. If a server request was interrupted, the popup shows **Retry Pending Operation** and safely replays the same idempotent request instead of creating another attempt. **Clear Cache** is blocked while recording or while an operation/outcome is pending; otherwise it clears only browser-side Extension state. It never deletes server recordings. The local source of truth is `data/participants/`; `data/results.json`, `data/sessions/`, and `data/recordings/` remain compatibility outputs. SQLite remains future work.

| Object | States |
| --- | --- |
| Attempt | `recording` → `completed_pending_outcome` → `accepted`, `failed`, or `invalidated` |
| Task | `pending` → `completed`, `skipped`, or `failed_no_retry` |
| Run | completes only when every task is terminal (`completed`, `skipped`, or `failed_no_retry`) |

Only a completed task may have `accepted_attempt_id`, and it must reference that task's one accepted attempt. Failed, skipped, and invalidated evidence is retained rather than overwritten.

The APIs support creating/listing runs and changing participant, run, or attempt states. For example, list participants and one participant's runs:

```powershell
Invoke-RestMethod http://localhost:3000/api/admin/participants
Invoke-RestMethod http://localhost:3000/api/participants/P004/runs
```

The Extension uses two separate mutation APIs:

- `POST /api/complete-task` saves evidence and moves a recording attempt to `completed_pending_outcome`.
- `POST /api/attempts/<attempt-id>/outcome` accepts `succeeded`, `failed_retry`, `failed_no_retry`, `skipped`, or `recording_problem`, plus participant/run/assignment IDs and an optional reason. Repeating the same outcome is idempotent; a different or illegal transition returns HTTP 409.

Participant status accepts `active`, `disabled`, or `archived`; run status accepts `active`, `aborted`, or `archived`. The older local admin attempt endpoint remains for compatibility, but finalized outcomes are immutable and cannot be restored into a different state.

```powershell
$body = @{
  participantId = "P004"; runId = "<run-id>"; assignmentId = "<assignment-id>"
  action = "invalidate"; reason = "browser crashed"
} | ConvertTo-Json
Invoke-RestMethod -Method Patch -ContentType "application/json" `
  -Body $body "http://localhost:3000/api/admin/attempts/<attempt-id>"
```

```bash
curl -X PATCH http://localhost:3000/api/admin/participants/P004 \
  -H 'Content-Type: application/json' -d '{"status":"archived"}'
curl -X PATCH http://localhost:3000/api/admin/runs/<run-id> \
  -H 'Content-Type: application/json' -d '{"participantId":"P004","status":"aborted"}'
```

When the server is not accessed through localhost, set `UI_RATER_ADMIN_TOKEN` and send `Authorization: Bearer <token>` to admin endpoints.

The detailed structures and boundaries are in [`docs/PARTICIPANT_MANAGEMENT_V2.md`](docs/PARTICIPANT_MANAGEMENT_V2.md), [`docs/HF_PARTICIPANT_DATASET_V2.md`](docs/HF_PARTICIPANT_DATASET_V2.md), and [`docs/LLM_AGENT_SANDBOX_V2.md`](docs/LLM_AGENT_SANDBOX_V2.md).

## Session output

```text
data/sessions/<session-id>/
  manifest.json
  trace.json
  snapshots/
    s0001.jpg
    s0001.json
  analysis/
    input.json
    findings.json
    report.md
```

The existing `data/results.json` and `data/recordings/` outputs remain for compatibility. Each completed trial in `results.json` also receives its `session_id`.

## Inspect a completed recording

Find the newest `data/sessions/<session-id>/` and check:

- `manifest.json` has `status: "complete"`, the expected participant/task/website metadata, and event/snapshot counts;
- `trace.json` contains increasing event sequence numbers, mouse/click events, and snapshot references that exist;
- every `snapshots/sNNNN.jpg` has a matching `snapshots/sNNNN.json` metadata file;
- the corresponding `data/recordings/<participant>-trial-<n>.webm` exists and is non-empty.

Prepare the exact LLM input without making a model request:

```powershell
Invoke-RestMethod -Method Post `
  "http://localhost:3000/api/sessions/<session-id>/analyze?prepareOnly=1"
```

Then inspect `data/sessions/<session-id>/analysis/input.json`. Confirm its task text, interaction counts, snapshot IDs/paths, and optional source files match the session. The inspectable JSON records screenshot paths and metadata; during a real multimodal model call the analysis adapter reads those files and attaches their image data to the request.

## Run UX analysis

Copy `server/.env.example` to `server/.env.local`, then set a model that is available to your OpenAI project:

```dotenv
OPENAI_API_KEY=...
# Optional override; defaults to gpt-5.6-terra.
OPENAI_MODEL=gpt-5.6-terra

# Source for the current Allrecipes synthetic website.
UI_RATER_WEBSITE_SOURCE_DIR=D:\LTL-UI\uxBench\repo-cache\deepseek-v4-flash-free\allrecipes\20260625-090547-allrecipes
```

Restart the server and call:

PowerShell:

```powershell
Invoke-RestMethod -Method Post `
  http://localhost:3000/api/sessions/<session-id>/analyze
```

Linux/macOS:

```bash
curl -X POST http://localhost:3000/api/sessions/<session-id>/analyze
```

To prepare and inspect the exact JSON input without making a model request—even when an API key is configured—use:

```text
POST /api/sessions/<session-id>/analyze?prepareOnly=1
```

If `OPENAI_API_KEY` is missing, the endpoint makes no model request. It still writes `analysis/input.json`, which is useful for inspecting exactly what would be sent. `gpt-5.6-terra` is the default model; `OPENAI_MODEL` can override it.

The prompt is deliberately short: report only task-specific usability problems supported by supplied evidence, cite existing event/snapshot IDs, explain task impact, and return the fixed problem-only JSON schema. It does not ask for recommendations, code changes, or source-file candidates.

## Isolated LLM analysis module

All model-facing code is isolated in `server/lib/ux-analysis/`:

- `input.ts`: writes the inspectable `analysis/input.json`;
- `source-context.ts`: reads a server-configured source root with extension, directory, file-count, and character limits;
- `prompt.ts`: owns the lean prompt and JSON schema;
- `openai.ts`: the only module allowed to call the OpenAI API;
- `validate.ts`: rejects unknown event and screenshot references;
- `report.ts`: renders `report.md`;
- `index.ts`: exposes prepare-only and full-analysis operations.

The HTTP request cannot supply a filesystem path. `UI_RATER_WEBSITE_SOURCE_DIR` must be configured by the server operator, and its final directory name must match the session's `app_id`. For the current pilot, that name is `20260625-090547-allrecipes`.

## Analysis-worker scope

The intended role of this machine is narrow: download one UX task attempt and the matching mocked website source, then identify UX problems that participant encountered while completing that attempt's specific task. It does not collect traces, modify the website, propose code changes, or aggregate conclusions across attempts.

## Dataset-to-agent analysis

The v2 analysis flow uses `uxBench/ux-task-trace` as a reproducible evidence baseline. It selects one accepted attempt, obtains exact website provenance from its parent `run.json`, downloads or reuses the matching website source revision, validates checksums, and materializes a sandbox:

```text
case.json
analysis-case.json       # canonical task/outcome context shared by analysis methods
evidence-manifest.json # ordered trace/screenshot catalog with hashes
evidence/   # participant, run, task, attempt, trace, screenshots, optional video
website/    # application source from exact revision, read-only; agent configs excluded
contract/   # lean instructions and output schema
output/     # the agent's only writable directory
```

The same case supports two controlled Codex conditions plus a direct one-shot ablation. The pinned defaults are `gpt-5.6-sol` with `medium` reasoning effort. `evidence-only` receives the canonical analysis case, complete trace, screenshot catalog/metadata, and all captured screenshots in a temporary workspace that contains no website source. `source-explore` receives the same inputs and may additionally search a clean, read-only copy of the application source tree; prior analysis outputs are excluded. `direct-one-shot` sends that same canonical evidence set and every screenshot in one multimodal Responses request through the local CLIProxyAPI, without source, tools, or a multi-turn agent loop. All conditions report only evidence-grounded UX problems for the specific task; none proposes code changes. See [`docs/UX_ANALYSIS_HARNESS.md`](docs/UX_ANALYSIS_HARNESS.md) for the harness decision and comparison design.

Materialize a local accepted attempt on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\materialize-case.ps1 `
  -AttemptId <attempt-id> -Output .cases\<attempt-id> `
  -WebsiteSource D:\path\to\exact\website-source
```

Materialize the same attempt from an exact HF revision on Linux/macOS:

```bash
sh scripts/materialize-case.sh \
  --hf-repo uxBench/ux-task-trace --hf-revision participant-v2 \
  --attempt-id <attempt-id> --output .cases/<attempt-id>
```

Both commands reject non-accepted attempts by default. For an explicit audit investigation, add `-Audit` on PowerShell or `--audit` on Linux/macOS; unfinished `recording` and `completed_pending_outcome` attempts are always rejected.

Run both controlled conditions through the already authenticated Codex CLI:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-agent-analysis.ps1 `
  -Case .cases\<attempt-id> -Condition both
```

```bash
sh scripts/run-agent-analysis.sh --case .cases/<attempt-id> --condition both
```

All captured screenshots are included by default. If a future attempt contains too many images for the available context budget, add `--max-screenshots N`; the runner samples evenly across the complete attempt instead of truncating the end of the task.

With CLIProxyAPI running locally on its default port, run the direct one-shot ablation:

```bash
sh scripts/run-direct-analysis.sh --case .cases/<attempt-id>
```

Run the trace-only ablation with the same model and reasoning effort:

```bash
sh scripts/run-direct-analysis.sh --case .cases/<attempt-id> --condition trace-only
```

Set `UI_RATER_CODEX_MODEL`, `UI_RATER_CODEX_REASONING_EFFORT`, or `UI_RATER_CODEX_COMMAND` only when overriding the pinned Codex harness defaults. The direct runner separately supports `UI_RATER_DIRECT_MODEL` and `UI_RATER_DIRECT_REASONING_EFFORT`. Every invocation writes an immutable directory under `output/runs/<analysis-run-id>/`; `output/latest.json` records the latest run ID for each harness. See [`docs/LLM_AGENT_SANDBOX_V2.md`](docs/LLM_AGENT_SANDBOX_V2.md) for the case contract.

## Suggested LLM pilot test

1. Start the server with `UI_RATER_WEBSITE_SOURCE_DIR` set to the Allrecipes source above.
2. Reload the unpacked Chrome extension.
3. Complete the task “Open the reviews of a recipe with beef sirloin.”
4. Find `session_id` in `data/results.json` or use the newest `data/sessions/<session-id>` directory.
5. Call the prepare-only endpoint and inspect `analysis/input.json`.
6. Confirm the trace is ordered, screenshots open correctly, and `source.files` includes files such as `src/components/ReviewSection.jsx`.
7. Set `OPENAI_API_KEY`, call the normal analyze endpoint, and inspect `findings.json` plus `report.md`.

The pilot succeeds at the infrastructure level when every accepted finding describes task-specific friction, explains its task impact, and cites real event/snapshot IDs. Finding quality should still be judged manually in this first pilot.

## Manual outcome/retry pilot

Use a fresh participant ID and a run with at least three synthetic tasks. Start the server, reload the unpacked Extension, enter the participant ID and `http://localhost:3000`, then click **Load Tasks**.

1. On task 1, start recording and interact with the site. Click **Done**. Close and reopen the popup: it must still show **Task Succeeded / Task Failed**. Choose **Task Failed**, close/reopen again, verify **Retry Task / Do Not Retry** is restored, then choose **Retry Task**.
2. Record task 1 again, click **Done**, then **Task Succeeded**. The popup must advance to task 2.
3. On task 2, start recording, close the task website tab, reopen the Extension on another tab, and click **Recording Problem**. If the recovery screen appears, click **Mark Recording Problem**. Verify it remains on task 2 and allows a new recording. In that attempt's manifest, `final_flush_status` may be `unavailable`; `recording_status` is `saved` when the offscreen video survived or `missing` when the recorder itself was unavailable.
4. Start task 2 again and click **Skip Task**. Verify the popup advances to task 3.
5. Record task 3, choose **Task Failed**, then **Do Not Retry**. The run should finish.
6. Inspect `data/participants/<participant-id>/runs/<run-id>/`: task 1 must contain failed attempt 1 and accepted attempt 2; task 2 must contain invalidated and skipped-outcome evidence; task 3 must be `failed_no_retry`. No failed/invalidated attempt directory should have disappeared.
7. Check each attempt folder for `attempt.json`, `manifest.json`, `trace.json`, `snapshots/`, and `recording.webm` when recording upload succeeded. Also confirm the compatibility entries remain present in `data/results.json` and `data/sessions/<session-id>/`.
8. Run an accepted export and confirm only task 1 attempt 2 is indexed. Run again with `--mode audit` and confirm the failed, skipped-outcome, and invalidated attempts are also indexed.

The **Clear Cache** button should refuse to run during recording and both decision screens. After the run is resolved, it may clear browser state but must leave all folders above unchanged.

## Configure trace export

Copy `scripts/trace-export.example.json` to a local config file and edit it:

```json
{
  "schema_version": "2.0",
  "layout": "participant-v2",
  "export_mode": "accepted",
  "participants_dir": "data/participants",
  "sync_state_dir": "data/sync-state",
  "keep_local_export": true,
  "local_export_dir": "exports/ux-task-trace",
  "upload_hf": false,
  "hf_repo_id": "uxBench/ux-task-trace",
  "hf_revision": "participant-v2"
}
```

The settings mean:

- `export_mode`: `accepted` exports completed runs and accepted attempts; `audit` also includes terminal failed, skipped-outcome, and invalidated attempts;
- `participants_dir`: participant-v2 local source of truth;
- `sync_state_dir`: records the exact HF commit after a successful upload;
- `keep_local_export`: create an additional persistent export package;
- `local_export_dir`: path for that package;
- `upload_hf`: enable a live Hugging Face write;
- `hf_repo_id`: dataset repository, default `uxBench/ux-task-trace`;
- `hf_revision`: isolated HF dataset revision, default `participant-v2`.

Relative paths are resolved from the extension repository root. Environment variables can override the config: `UI_RATER_PARTICIPANTS_DIR`, `UI_RATER_KEEP_LOCAL_EXPORT`, `UI_RATER_LOCAL_EXPORT_DIR`, `UI_RATER_UPLOAD_HF`, `HF_DATASET_REPO`, and `HF_DATASET_REVISION`.

The exporter validates IDs, statuses, manifest/session linkage, non-empty trace/video, screenshot pairs, and SHA-256 checksums. It never deletes canonical participant data. On a successful HF commit it writes local sync state. Incremental uploads merge participant, run, and attempt indexes already present on the HF revision, so uploading one completed run does not remove older rows from the indexes. Runs are discovered from the canonical participant folders, so no separate upload queue is required for this single-operator baseline.

The exported layout is:

```text
participants/<participant-id>/
  runs/<run-id>/
    tasks/<position>-<assignment-id>/
      attempts/<number>-<attempt-id>/
        attempt.json
        manifest.json
        trace.json
        recording.webm
        snapshots/
        analysis/
```

Website/model provenance moves into `run.json` and root query indexes. The default HF export contains completed runs and accepted attempts. Audit mode may include failed, skipped-outcome, or invalidated attempts with attempt/task outcome, reason, timestamps, and an `artifact_complete` flag when a failure happened before all evidence existed.

Before the first v2 export, preview or copy legacy data without deleting it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migrate-legacy-participants.ps1 -DataDir data
powershell -ExecutionPolicy Bypass -File scripts\migrate-legacy-participants.ps1 -DataDir data -Apply
```

Linux/macOS uses `sh scripts/migrate-legacy-participants.sh --data-dir data` and adds `--apply` for the copy. Existing `results.json`, sessions, and recordings are retained.

## Export on Windows

Preview without copying or uploading:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\export-traces.ps1 `
  -Config scripts\trace-export.local.json -DryRun
```

Create the configured local export:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\export-traces.ps1 `
  -Config scripts\trace-export.local.json
```

Create an audit export that also includes failed and invalidated attempts:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\export-traces.ps1 `
  -Config scripts\trace-export.local.json -Mode audit
```

For a live Hugging Face upload, first install the optional dependency and set a write-capable token, then pass the explicit upload switch:

```powershell
python -m pip install huggingface_hub
$env:HF_TOKEN = "hf_..."
powershell -ExecutionPolicy Bypass -File scripts\export-traces.ps1 `
  -Config scripts\trace-export.local.json -UploadHf
```

## Export on Linux or macOS

Preview:

```bash
sh scripts/export-traces.sh --config scripts/trace-export.local.json --dry-run
```

Create the configured local export:

```bash
sh scripts/export-traces.sh --config scripts/trace-export.local.json
```

Create an audit export:

```bash
sh scripts/export-traces.sh --config scripts/trace-export.local.json --mode audit
```

Upload explicitly:

```bash
python3 -m pip install huggingface_hub
export HF_TOKEN=hf_...
sh scripts/export-traces.sh --config scripts/trace-export.local.json --upload-hf
```

Hugging Face upload remains opt-in. The CLI requires `--upload-hf`; the Extension requires a separate click after the run completes. Merely completing a task never performs an external write, and the server test suite never uploads.

### Completion-screen upload pilot

1. Install `huggingface_hub` in the Python environment used by the server.
2. Set `HF_TOKEN` in `server/.env.local`; optionally set `HF_DATASET_REPO` and `HF_DATASET_REVISION`.
3. Start a selected run with `npm run dev:tasks -- ...`, finish every task, and choose its final outcome.
4. Confirm the completion screen shows both upload choices. Select **Keep Local Only** once in a disposable run and verify localhost closes without a new HF commit.
5. In another completed run, select **Upload to Hugging Face**. Confirm the popup reports the repository/revision, `data/sync-state/<run-id>.json` records the commit, and localhost closes afterwards.
6. Reconcile the uploaded revision with `scripts/reconcile-hf.ps1` or `scripts/reconcile-hf.sh`.

After an upload, compare local attempt checksums with the exact HF revision:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\reconcile-hf.ps1
```

```bash
sh scripts/reconcile-hf.sh --hf-repo uxBench/ux-task-trace --hf-revision participant-v2
```

Both commands are read-only. They return a non-zero exit code for missing or stale attempts.

## Development checks

From the extension root:

```bash
node --test tests/*.test.js
```

From `server/`:

```bash
npx tsc --noEmit
npm run lint
```

Validate the exporter without external writes:

```bash
python scripts/export_traces.py --dry-run
```

The detailed execution goals and boundaries are in [the baseline implementation plan](docs/superpowers/plans/2026-07-16-evidence-grounded-ux-analysis.md).
