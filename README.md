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

## Requirements

- Chrome 116+
- Node.js 18+
- Python 3.10+ only for trace export
- `huggingface_hub` only when uploading to Hugging Face

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

## Suggested pilot test

1. Start the server with `UI_RATER_WEBSITE_SOURCE_DIR` set to the Allrecipes source above.
2. Reload the unpacked Chrome extension.
3. Complete the task “Open the reviews of a recipe with beef sirloin.”
4. Find `session_id` in `data/results.json` or use the newest `data/sessions/<session-id>` directory.
5. Call the prepare-only endpoint and inspect `analysis/input.json`.
6. Confirm the trace is ordered, screenshots open correctly, and `source.files` includes files such as `src/components/ReviewSection.jsx`.
7. Set `OPENAI_API_KEY`, call the normal analyze endpoint, and inspect `findings.json` plus `report.md`.

The pilot succeeds at the infrastructure level when every accepted finding cites real event/snapshot IDs, every source candidate exists in `source.files`, and the recommendation is understandable from the cited evidence. Whether the recommendations are actually useful should still be judged manually in this first pilot.

## Configure trace export

Copy `scripts/trace-export.example.json` to a local config file and edit it:

```json
{
  "sessions_dir": "data/sessions",
  "keep_local_export": true,
  "local_export_dir": "exports/ux-task-trace",
  "upload_hf": false,
  "hf_repo_id": "uxBench/ux-task-trace",
  "hf_path_prefix": "sessions"
}
```

The settings mean:

- `sessions_dir`: source containing canonical session directories;
- `keep_local_export`: create an additional persistent export package;
- `local_export_dir`: path for that package;
- `upload_hf`: enable a live Hugging Face write;
- `hf_repo_id`: dataset repository, default `uxBench/ux-task-trace`;
- `hf_path_prefix`: remote directory prefix, default `sessions`.

Relative paths are resolved from the extension repository root. Environment variables can override the config: `UI_RATER_SESSIONS_DIR`, `UI_RATER_KEEP_LOCAL_EXPORT`, `UI_RATER_LOCAL_EXPORT_DIR`, `UI_RATER_UPLOAD_HF`, `HF_DATASET_REPO`, and `HF_PATH_PREFIX`.

The exporter processes only sessions whose manifest status is `complete`. It never automatically deletes the canonical session directory. When `keep_local_export=false` and upload is enabled, it uses a temporary staging directory and retains no additional export copy.

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
