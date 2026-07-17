# UI Rater Extension - UX Analysis Baseline

This Chrome extension records interaction traces, tab video, and a small set of key screenshots while a user completes a task on a synthetic website. The local Next.js server stores one directory per task and can send the trace plus screenshots to an LLM for UX improvement suggestions.

## Baseline scope

The current version includes:

- durable task traces backed by `chrome.storage.local`;
- one local `data/sessions/<session-id>/` directory per completed task;
- key screenshots at start, click/change/submit/navigation, and task end;
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
| Prepare LLM input without a model call | `POST /api/sessions/<session-id>/analyze?prepareOnly=1` |
| Run LLM analysis | `POST /api/sessions/<session-id>/analyze` |
| Preview/export/upload traces | use `scripts/export-traces.ps1` on Windows or `scripts/export-traces.sh` on Linux/macOS |

The sections below give complete commands, configuration, expected outputs, and validation steps for each entry point.

## Requirements

- Chrome 116+
- Node.js 18+
- Python 3.10+ for Hugging Face website download and trace export
- `huggingface_hub` for website download or trace upload

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
5. Complete a synthetic task and click **Done**.

Reloading the extension does not clear its saved participant ID, task list, or current task position because these values live in `chrome.storage.local`. After a completed run, use **Start Over** to clear the browser-side state. During debugging, removing and loading the extension again also creates a clean browser-side state; it does not remove server recordings.

## End-to-end local pilot

Start the server with an explicit website, task file, and source task positions. PowerShell uses backticks for line continuation:

```powershell
cd server
npm run dev:tasks -- `
  --website-dir "../../../uxBench/allrecipes" `
  --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" `
  --tasks 1 3 5 `
  --attempt pilot-001
```

The terminal should report `Selected 3/... tasks` and listen on `http://localhost:3000`. If Next.js switches to port 3001 or reports a `.next` lock, stop the older server before testing; otherwise the extension may still talk to an earlier one-task configuration.

Use a valid participant ID that has not requested tasks from this server data directory. Before opening the extension, verify the server-side assignment:

```powershell
Invoke-RestMethod `
  "http://localhost:3000/api/tasks?participantId=P004" |
  ConvertTo-Json -Depth 5
```

The response should contain `totalTasks: 3`. Loading the extension afterwards should show `Task 1 of 3`.

## Select tasks when starting the server

Use `dev:tasks` to select both a synthetic website and its tasks. A local website source takes priority. If none is provided, the launcher selects and caches a run from [`uxBench/website-generation`](https://huggingface.co/datasets/uxBench/website-generation/tree/prompt-userflow-regen-20260624). Install the downloader once with `python -m pip install huggingface_hub`.

Prefer a local website and run every task:

```bash
cd server
npm run dev:tasks -- --website-dir "../../../uxBench/allrecipes" --tasks-json "../../../uxBench/allrecipes/trials-config.full.json" --all --attempt pilot-001
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

The commands are identical in PowerShell, Linux, and macOS. Task numbers always refer to positions in the source JSON, while the selected run is reindexed from 1. Use a new participant ID after changing a selection because an existing participant keeps the trials created on their first request. Public downloads need no token; `HF_TOKEN` is used automatically when the source dataset requires authentication.

## Current participant behavior

The current implementation is intentionally simple:

- `server/config/participants.json` is an allow-list of valid participant IDs, not a participant database.
- The first `GET /api/tasks?participantId=<id>` copies the current selected trials into `data/results.json` for that ID. Later requests return that stored assignment even if the server was restarted with a different task selection.
- The popup stores the participant ID, assigned tasks, and current position in `chrome.storage.local`. Extension reloads preserve that state; **Start Over** clears only this browser-side copy.
- `POST /api/reset` resets every participant in `data/results.json`; it is not a safe per-participant retry operation. It also does not remove canonical session folders or video files.

Consequently, a participant ID is effectively tied to one persistent assignment in the baseline. It is not restricted to one human forever, but reusing it for a new run or recovering from a broken attempt is inconvenient. If the popup shows `Task 1 of 1` after starting with `--tasks 1 3 5`, first query `/api/tasks` as shown above: an old participant assignment or an old server process is usually the cause.

## Proposed participant management v2

The proposed model separates four concepts: a stable **participant**, a configured **run**, each **task assignment**, and one or more **attempts** for that task. A participant can have multiple runs; a task can be retried without deleting its earlier evidence; and at most one attempt is marked accepted for analysis/export.

The operator workflow would be:

1. Create or select a participant, then create a run that snapshots the website, tasks, seed, and launcher configuration.
2. Record attempts under that run. A software failure creates attempt 2 rather than overwriting attempt 1.
3. Mark bad attempts invalid with a reason, restore them if needed, or accept the good attempt. Invalid attempts remain auditable and are excluded from normal exports.
4. Complete, abort, or archive the run. Use soft deletion by default; hard deletion requires an explicit attempt/session target and confirmation.

The recommended MVP uses SQLite for participant/run/attempt metadata while keeping screenshots, traces, analyses, and WebM files in the existing session directories. A small local admin page/API should support creating runs, retrying tasks, invalidating/restoring attempts, and archiving participants. The full local schema, lifecycle, API sketch, migration steps, and acceptance criteria are in [`docs/PARTICIPANT_MANAGEMENT_V2.md`](docs/PARTICIPANT_MANAGEMENT_V2.md). The corresponding participant-first Hugging Face structure and synchronization rules are in [`docs/HF_PARTICIPANT_DATASET_V2.md`](docs/HF_PARTICIPANT_DATASET_V2.md). These v2 sections are design proposals, not functionality already present in the baseline.

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

The prompt is deliberately short: report only usability problems supported by supplied evidence, separate observation from inference, cite existing event/snapshot IDs, and return the fixed JSON schema. When source is configured, each finding may also return source-file candidates, but only from paths actually included in `input.json`.

## Isolated LLM analysis module

All model-facing code is isolated in `server/lib/ux-analysis/`:

- `input.ts`: writes the inspectable `analysis/input.json`;
- `source-context.ts`: reads a server-configured source root with extension, directory, file-count, and character limits;
- `prompt.ts`: owns the lean prompt and JSON schema;
- `openai.ts`: the only module allowed to call the OpenAI API;
- `validate.ts`: rejects unknown event, screenshot, and source references;
- `report.ts`: renders `report.md`;
- `index.ts`: exposes prepare-only and full-analysis operations.

The HTTP request cannot supply a filesystem path. `UI_RATER_WEBSITE_SOURCE_DIR` must be configured by the server operator, and its final directory name must match the session's `app_id`. For the current pilot, that name is `20260625-090547-allrecipes`.

## Suggested LLM pilot test

1. Start the server with `UI_RATER_WEBSITE_SOURCE_DIR` set to the Allrecipes source above.
2. Reload the unpacked Chrome extension.
3. Complete the task “Open the reviews of a recipe with beef sirloin.”
4. Find `session_id` in `data/results.json` or use the newest `data/sessions/<session-id>` directory.
5. Call the prepare-only endpoint and inspect `analysis/input.json`.
6. Confirm the trace is ordered, screenshots open correctly, and `source.files` includes files such as `src/components/ReviewSection.jsx`.
7. Set `OPENAI_API_KEY`, call the normal analyze endpoint, and inspect `findings.json` plus `report.md`.

The pilot succeeds at the infrastructure level when every accepted finding cites real event/snapshot IDs, every source candidate exists in `source.files`, and the recommendation is understandable from the cited evidence. Whether the recommendations are actually useful should still be judged manually in this first pilot.

## Configure trace export

> **Layout transition:** the current export script still implements the legacy website-first hierarchy shown below. It should not be used to populate the new canonical participant dataset. Keep `upload_hf: false` while validating locally until the participant-v2 exporter is implemented. The replacement design uses `participant -> run -> task assignment -> attempt` and is specified in [`docs/HF_PARTICIPANT_DATASET_V2.md`](docs/HF_PARTICIPANT_DATASET_V2.md).

Copy `scripts/trace-export.example.json` to a local config file and edit it:

```json
{
  "sessions_dir": "data/sessions",
  "keep_local_export": true,
  "local_export_dir": "exports/ux-task-trace",
  "upload_hf": false,
  "hf_repo_id": "uxBench/ux-task-trace",
  "hf_path_prefix": ""
}
```

The settings mean:

- `sessions_dir`: source containing canonical session directories;
- `keep_local_export`: create an additional persistent export package;
- `local_export_dir`: path for that package;
- `upload_hf`: enable a live Hugging Face write;
- `hf_repo_id`: dataset repository, default `uxBench/ux-task-trace`;
- `hf_path_prefix`: optional directory above the structured hierarchy; empty by default.

Relative paths are resolved from the extension repository root. Environment variables can override the config: `UI_RATER_SESSIONS_DIR`, `UI_RATER_KEEP_LOCAL_EXPORT`, `UI_RATER_LOCAL_EXPORT_DIR`, `UI_RATER_UPLOAD_HF`, `HF_DATASET_REPO`, and `HF_PATH_PREFIX`.

The exporter processes only sessions whose manifest status is `complete`. It never automatically deletes the canonical session directory. When `keep_local_export=false` and upload is enabled, it uses a temporary staging directory and retains no additional export copy.

The current legacy exporter uses this layout for backward compatibility:

```text
<model>/<website>/<run-id>/
  attempts/<attempt-id>/
    users/<participant-id>/
      sessions/<session-id>/
        manifest.json
        trace.json
        snapshots/
        analysis/
```

This legacy layout preserves the same first three levels as `website-generation`. `sessions.jsonl` at the export root records every manifest and its exact `export_path`. Older sessions without website metadata are placed under explicit `unknown-model/unknown-site` fallback segments instead of being discarded.

The participant-v2 target replaces it with:

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

Website/model provenance moves into `run.json` and root query indexes. The default HF export contains completed runs and accepted attempts; audit mode may include failed or invalidated attempts with their status and reason.

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

Upload explicitly:

```bash
python3 -m pip install huggingface_hub
export HF_TOKEN=hf_...
sh scripts/export-traces.sh --config scripts/trace-export.local.json --upload-hf
```

Hugging Face upload is disabled by default. It is never run by task completion or by the server test suite.

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
