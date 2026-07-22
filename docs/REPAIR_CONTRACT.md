# Reliability and analysis contract

## Scope

This repository has two explicit responsibilities:

1. Record a single participant's attempt on a mocked website without silently losing or misattributing trace, screenshot, or recording evidence.
2. Materialize one immutable accepted attempt and compare UX-problem detection Method 1 against Method 3. The output describes task-specific UX problems only; it does not propose fixes or modify website code.

The repair does not add real-user privacy handling, multi-tab trace stitching, video analysis, automated website modification, or a general cross-website UX audit.

## Delivery boundaries

### Capture and finalization

- The task tab and session must match every trace and screenshot message.
- Trace events have stable `event_id` values. Batches are acknowledged by the server and replay safely; finalization reconciles the locally retained trace with the canonical server trace.
- Important activations, edits, submissions, navigation states, task start/end, and settled scroll states request screenshots. `before` is explicitly best-effort and records request, capture-start, and capture-completion timing.
- Screenshot capture is serialized per browser window. The active task tab is checked both before and after `captureVisibleTab`.
- A captured image is persisted in IndexedDB before upload. Capture and upload queues are separate so a slow upload cannot cause a screenshot of the wrong tab.
- There is no 12-image analysis cap. The extension has a 120-image emergency storage guard with one reserved task-end slot; the server accepts up to 240 images. Method 1 sees the complete catalog and chooses what to inspect. Method 3 either receives the complete canonical image set or is marked ineligible before the request; it never silently truncates.
- Normal completion requires an acknowledged final trace flush and task-end screenshot. A participant may explicitly terminate an unrecoverable attempt as `recording_problem`; the missing evidence is recorded rather than disguised as complete.
- The recording blob survives offscreen-document or service-worker interruption until an acknowledged upload or explicit cancel.
- Opening a second task-originated tab is fail-closed as `unsupported_multi_tab`; multi-tab merging is outside this delivery.

### Ownership, state, and writes

- `participant / run / assignment / attempt / session` ownership is checked at every managed write route.
- A run capability creates attempts; an attempt capability writes trace, screenshots, recording, evidence completion, and outcome. Admin routes require a local request in development or `UI_RATER_ADMIN_TOKEN`; production also requires `UI_RATER_CAPABILITY_SECRET`.
- The participant tree is canonical. `data/results.json`, session manifests, and compatibility recordings are repairable projections.
- JSON and immutable binary publication use write-temp, file sync, atomic rename, and directory sync where supported.
- Run/session/result mutations use an in-process queue plus a cross-process directory lock. The deployment boundary is one host and one shared data directory; a distributed lock service is not claimed.
- A lock key is SHA-256 encoded only to produce a fixed-length, path-safe filename. The hash does not provide mutual exclusion. Atomic directory creation provides exclusion; owner PID/hostname, heartbeat, and stale-owner checks provide crash recovery.

### Hashes and immutability

Hashes are necessary at evidence boundaries, not as a substitute for locking:

- `artifact-manifest.json` is detached from the files it hashes, avoiding a self-referential checksum cycle.
- The HF index records the artifact root and detached-manifest hash. Reusing an attempt ID with different evidence is rejected.
- A case revision hashes the exact exported artifact, parent context, filtered website source, analysis contract, and materialization options.
- `.cases/<attempt>/revisions/<case_revision_id>/` is immutable. `latest-case.json` is an atomic pointer; rematerialization never deletes an earlier case or its analysis outputs.
- Case and evidence manifests verify hashes, byte counts, safe paths, symlink absence, and exact file sets before analysis.
- Analysis run IDs are unique. Only successful runs update `latest-success.json`; failed output cannot masquerade as the latest valid result.

Hashing is intentionally not used for ordinary mutable state that is already protected by a lock and atomic write. Adding hashes there would detect corruption after the fact but would not prevent lost updates.

## Analysis experiment

The controlled runner is `scripts/run-ux-experiment.sh` and defaults to Methods 1 and 3:

| Method | Input and harness | Role |
| --- | --- | --- |
| 1 | Codex CLI in a read-only workspace with full trace, full screenshot catalog, and images available for agent-selected inspection; no source | Primary |
| 2 | Method 1 plus exact website source | Optional ablation |
| 3 | One CLIProxyAPI Responses request containing all canonical JSON and screenshots; no tools or source | Primary |
| 4 | Method 3 with task context and trace only | Optional ablation |

All methods use the same attempt, problem-only JSON Schema, requested `gpt-5.6-sol` model, `medium` reasoning effort, and repetition ID. A Method 1/3 comparison is eligible only when both succeed with the same resolved model and the detached artifact, case, and evidence roots verify. Method 1 findings may cite only screenshots that its harness log shows it inspected. Method 3 is ineligible when its complete encoded input exceeds the configured budget.

## Definition of done

- Extension JavaScript passes syntax checks and contract tests.
- Python unit tests cover atomic export, detached hashes, symlink/path rejection, versioned cases, exact manifests, and evidence auditing.
- Server integration tests cover attempt ownership, idempotent recovery, terminal state, and concurrent-safe files; TypeScript typecheck and lint pass.
- `scripts/audit-evidence.sh` performs a read-only audit and returns non-zero for ownership, sequence, snapshot-pair, count, finalization, or accepted-pointer violations.
- CI runs all of the above without credentials or external writes.
- The commit excludes `.cases`, exports, reports, slides, tokens, caches, recordings, and other local study artifacts.
