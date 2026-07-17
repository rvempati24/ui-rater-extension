# UI Rater UX Analysis Baseline Plan

## Goal

Build the smallest end-to-end baseline that turns a synthetic-site task trace into UX improvement suggestions:

```text
Chrome extension -> local session folder -> trace + key screenshots -> one LLM call -> findings JSON
                                                    |
                                                    +-> optional local export / Hugging Face upload
```

This plan intentionally keeps only the original Steps 1, 3, 4, and 6, plus bounded read-only source context and a configurable export step.

## Execution boundary

Local code edits, local file writes, and non-destructive tests are in scope. The implementation must not make a live OpenAI request or a Hugging Face write during development. A live model call requires `OPENAI_API_KEY`; `OPENAI_MODEL` can override the `gpt-5.6-terra` default. A Hub upload requires `upload_hf=true` (or `--upload-hf`) and `HF_TOKEN`.

The baseline does not include privacy filtering because the current study uses synthetic websites. It also excludes databases, queues, friction detectors, semantic-state deduplication, multi-agent analysis, autonomous source-code exploration, automatic patches, and evaluation infrastructure.

## Step 1 - Durable, time-aligned trace

### Objective

Keep a task trace usable across page navigation and Manifest V3 service-worker restarts, with timestamps aligned to recording start.

### Work

- Create `session_id` and timestamp zero after MediaRecorder acknowledges start.
- Add monotonically increasing `seq` values to interaction events.
- Store the active accumulated trace in `chrome.storage.local` after every flush.
- Restore the active session after service-worker or page restart.

### Done when

A task can navigate between pages and still complete with one ordered trace. A service-worker restart does not erase already persisted events.

### Boundary

No event-sourcing system, database, retry queue, or exactly-once distributed protocol.

## Step 3 - One directory per session

### Objective

Make each completed task a self-contained artifact that can be inspected, analyzed, or exported independently.

### Work

- Store artifacts under `data/sessions/<session-id>/` by default.
- Allow the canonical session root to be changed with `UI_RATER_SESSION_DIR`.
- Write `manifest.json`, `trace.json`, `snapshots/`, and `analysis/`.
- Keep `results.json` for compatibility and add `session_id` to the relevant trial.

### Done when

A completed task has a manifest, complete trace, and stable session ID without requiring a database.

### Boundary

No migration of historical trials and no removal of the existing `results.json` or recording flow.

## Step 4 - Key screenshots

### Objective

Give the model enough visual state to interpret the text trace without storing a frame for every event.

### Work

- Capture JPEG screenshots at task start, after clicks, field changes, submit/navigation, and before completion.
- Store a small list of visible interactive/headline elements beside each image.
- Debounce captures to 750 ms and cap each session at 20 screenshots.

### Done when

The session directory contains timestamped screenshots whose IDs can be cited by the model.

### Boundary

No full DOM snapshot, accessibility-tree integration, visual hashing, mutation observer, or video keyframe extraction.

## Step 6 - One-pass lean UX critic

### Objective

Produce a small list of evidence-grounded website improvement suggestions.

### Work

- Build `analysis/input.json` from the task, important trace events, and at most 12 screenshots.
- Optionally add a bounded source snapshot from `UI_RATER_WEBSITE_SOURCE_DIR`.
- Isolate all model-facing code under `server/lib/ux-analysis/`.
- Keep all non-mousemove actions and sample every twentieth mousemove; cap the supplied trace at 500 events.
- Make one OpenAI Responses API request using a short prompt and strict JSON schema.
- Reject findings that cite nonexistent event sequences or snapshot IDs.
- Validate cited source paths and write `analysis/findings.json` plus `analysis/report.md`.

### Done when

`POST /api/sessions/<session-id>/analyze` produces findings with observation, inference, recommendation, severity, confidence, evidence IDs, and optional source candidates. `prepareOnly=1` or missing model configuration still writes `analysis/input.json` without making a model request.

### Boundary

No two-pass critic, tool calls, examples in the prompt, repository browsing, or automatic website edits. Source is a fixed read-only input selected by the server operator.

## Export - Local package and Hugging Face dataset

### Objective

Publish completed trace sessions to `uxBench/ux-task-trace` without coupling capture success to an external service.

### Work

- Use one cross-platform Python exporter with Windows PowerShell and Linux/macOS shell wrappers.
- Read completed sessions only; skip incomplete folders.
- Optionally create a local export copy at a configurable path.
- Optionally upload that package to the dataset repository under a configurable prefix.
- Default Hugging Face upload to off.

### Configuration

- `UI_RATER_SESSION_DIR`: canonical server session directory.
- `keep_local_export`: whether to create an additional local export package.
- `local_export_dir`: location of that package.
- `upload_hf`: whether to upload.
- `hf_repo_id`: defaults to `uxBench/ux-task-trace`.
- `hf_path_prefix`: defaults to `sessions`.
- `HF_TOKEN`: required only for a live upload.

The baseline never automatically deletes canonical session data. Setting `keep_local_export=false` prevents an additional retained export copy; temporary staging is used for upload. Deletion can be added later as a separate, explicitly destructive workflow.

### Done when

Dry-run reports the exact source, destination, session count, and upload target. Windows and Linux/macOS commands are documented in the README. A real upload occurs only after the operator explicitly enables it.

### Boundary

No live upload during implementation, no automatic deletion, no repository creation, and no background upload that can block task completion.

## Recommended run order

1. Start the server and load the unpacked extension.
2. Complete one synthetic task and inspect its session directory.
3. Call the analyze endpoint with no API key to inspect `analysis/input.json`.
4. Configure the model and run one approved live analysis.
5. Run the trace exporter with `--dry-run`.
6. Enable Hugging Face upload only after the local package is reviewed.
