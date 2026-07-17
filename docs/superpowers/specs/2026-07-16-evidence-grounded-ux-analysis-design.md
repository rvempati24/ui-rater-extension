# UI Rater UX Analysis Baseline Design

## Decision

Use a single session-oriented filesystem pipeline and one multimodal, source-aware model call. The baseline favors inspectability over sophisticated preprocessing.

## Data flow

```text
content.js
  interaction batches + snapshot requests
       |
background.js + chrome.storage.local
  durable active trace + screenshot capture
       |
Next.js routes
  data/sessions/<session-id>/
       |
POST /api/sessions/<session-id>/analyze
  trace text + screenshots + bounded source -> findings.json + report.md
       |
scripts/export_traces.py
  optional local package and/or uxBench/ux-task-trace upload
```

## Session layout

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

## Capture contract

Each event has `seq`, `ts`, `kind`, and available target/coordinate data. `ts=0` is aligned to recording start. The extension persists the complete active trace in `chrome.storage.local` on each flush and uploads its current full value to the compatibility partial-save route.

A screenshot contains JPEG bytes plus timestamp, reason, URL, viewport, scroll position, and at most 60 visible interactive/headline elements. Capture is limited to 20 images per task.

## Model contract

The model receives task context, a mechanically shortened trace, at most 12 screenshots, and an optional bounded source snapshot selected through a server environment variable. It returns up to eight findings. Each finding contains:

- title;
- observed behavior;
- inferred cause;
- recommendation;
- severity from 1 to 4;
- confidence from 0 to 1;
- cited event sequence numbers and/or snapshot IDs.
- zero or more source-file candidates selected from the supplied paths.

The server rejects unknown evidence IDs and source paths. It does not attempt to invent or repair supporting evidence. The model cannot request arbitrary paths or modify source files.

## Configuration and external writes

Capture and local storage require no credentials. Model analysis requires explicit OpenAI environment configuration. Hugging Face upload is a separate operator-run exporter and is disabled by default. External failures never invalidate an already completed local session.

The full implementation and operator boundaries are in [the baseline plan](../plans/2026-07-16-evidence-grounded-ux-analysis.md).
