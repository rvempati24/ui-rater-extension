# UX analysis harness decision

## Decision

The canonical production path is Method 3 (`direct-one-shot`). One immutable accepted attempt is materialized from Collection-owned evidence, the WebM is deterministically reduced to action-linked frames, and one strict multimodal Responses request reports only UX problems the participant actually encountered.

Method 1, Method 2, Method 4, `run_ux_experiment.py`, and their wrappers remain historical reproduction tooling for one migration window. They are not the documented production entrypoint and cannot update the canonical Method 3 latest-success pointer.

## Evidence flow

1. Collection finalizes `trace.json`, `recording.webm`, live auxiliary screenshots, and measured recording timing.
2. `scripts/materialize-case.sh` validates the frozen Study Revision and assignment without calling Website or Manager or loading website source.
3. `video_keyframes.py` groups same-family click, move, scroll, and key events using the versioned NAPsack-derived policy.
4. Each burst requests the frame 75 ms before its first event and 75 ms after its last event. ffprobe PTS is authoritative; duplicate decoded frames retain all associations.
5. `model-input-sequence.json` globally orders every derived frame and its I/O. Markers mirror the paper's 60-frame grouping, but Method 3 remains one request.
6. `scripts/run-ux-analysis.sh` sends only the explicit schema-v2 manifest records and every primary image exactly once.

The full WebM, website source, Manager state, Website state, and live auxiliary screenshots are never sent to the model.

## Calibration gate

The repository intentionally ships `calibration/method3-recording-alignment-v1.json` with `status: pending`. Follow `docs/METHOD3_CALIBRATION.md` with the production browser/capture profile. Primary materialization fails until the immutable calibration artifact passes its predeclared p95 error bound.

The gate also reviews burst coverage, before/after visual validity, duplicate-state rate, finding coverage, and false positives. A failure creates a new policy or calibration version; it never causes silent sampling or fallback.

## Run

```bash
module load python

sh scripts/materialize-case.sh \
  --participants-dir /absolute/path/to/ui-rater-data/collection/participants \
  --attempt-id <attempt-id> \
  --output .cases/<attempt-id>

sh scripts/run-ux-analysis.sh \
  --case .cases/<attempt-id>
```

The default endpoint is `http://127.0.0.1:8317/v1`. The runner requires loopback HTTP, `store: false`, `tools: []`, strict JSON Schema, and a complete pre-transport input budget check.

## Integrity and failure behavior

- Raw evidence stays immutable under Collection ownership.
- Derived frames, policy hash, calibration hash, tool binary hashes, frame PTS, and case files are bound into the case revision.
- Evidence manifest v2 is a closed reference graph. Unknown, duplicate, unlisted, or dangling primary snapshots fail validation.
- Missing/corrupt WebM, incomplete timing, pending calibration, unsupported cadence, excess frames/bytes/pixels/tokens, or unknown output citations make the run ineligible.
- No primary stage truncates, samples, substitutes live screenshots, or updates latest-success after failure.
- Findings may cite only verified server event sequence numbers and `vNNNN` derived snapshot IDs.

## Output

Each invocation writes immutable files below:

```text
output/runs/<analysis-run-id>/direct-one-shot/
  prompt.txt
  input-manifest.json
  response.json
  findings.json
  run-metadata.json
```

Only a schema-valid, evidence-valid success updates `output/latest-success.json` for `direct-one-shot`.
