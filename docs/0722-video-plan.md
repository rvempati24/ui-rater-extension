Method 3 Video-Derived Evidence Implementation Plan

Status

Implemented on agent/ux-analysis-harness-review after commit 5d535a3, with the production eligibility gate intentionally pending a real-browser calibration cohort. Repository code, schemas, wrappers, documentation, and automated tests are complete; `calibration/method3-recording-alignment-v1.json` remains `pending` so an unmeasured alignment claim cannot enter the primary condition.

It supersedes the earlier assumption that Methods 1 and 3 must remain a primary comparison, but it does not change runtime behavior by itself.

The selected production analysis path is Method 3 only: one strict, no-tools multimodal Responses request receives a complete, immutable, precomputed evidence set for one accepted task attempt.

Review decision

The architecture is feasible and is retained: Collection owns the full WebM and trace; an offline materializer derives screenshots; Method 3 consumes the immutable derived case without Website or Manager.

The screenshot algorithm is changed to follow the event-driven NAPsack design in Learning Next Action Predictors from Human-Computer Interaction (arXiv:2603.05923), Section 3.1 and Appendix A.1-A.2:

group temporally adjacent low-level events of the same type into bursts;

extract one frame 75 ms before the first event and one frame 75 ms after the last event of each burst;

merge frames and their associated I/O into one global time-ordered evidence sequence;

This is a project adaptation, not a claim of exact NAPsack reproduction. NAPsack continuously captures the active screen and persists selected screenshots; this project first records one WebM, retains it as raw evidence, and performs analogous project-specific event-driven frame extraction after the attempt. Only the selected frames and I/O context are sent to the VLM. NAPsack captions 60-frame chunks; this project retains the existing Method 3 one-request contract. The runner must expose markers mirroring the paper's 60-frame grouping inside that request and must fail explicitly if the complete request exceeds its input budget. It must not silently sample.

The previous variable settled-post delays (+500 to +1200 ms), semantic click/submit/navigation burst merging, and task-boundary frames are removed from the primary policy. They may be evaluated later as separately named policies, but results from those policies must not be labeled as the primary NAPsack-aligned Method 3 condition.

Primary-method cutover gate

This is the implementation target and intended primary method, but Phase 6 documentation cutover occurs only after a real-browser pilot demonstrates that the derived labels mean what they claim. Until that gate passes, the existing live captures remain canonical auxiliary evidence and the historical harness remains available for validation.

The pilot must measure, by event family:

trace-to-video alignment error using an observable UI transition with a known trace time;

burst coverage and uncovered outcome-relevant actions;

the fraction of before frames that precede the visible effect and after frames that contain it;

duplicate/same-state pairs using a recorded perceptual difference score plus human inspection;

Method 3 finding coverage and false-positive rate against a small manually reviewed cohort.

The gate passes only when thresholds are written before the pilot and the cohort meets them. A pilot failure changes the versioned policy or trace/recording instrumentation; it does not trigger silent fallback or retrospective threshold selection.

Purpose

Implement a UX-analysis pipeline that:

keeps the Collection Service's trace and full WebM recording as canonical raw attempt evidence;

derives deterministic screenshots from the recording after collection, using the trace to identify important action bursts;

sends the complete derived screenshot set and explicit JSON evidence to Method 3 in one request;

requires no Website Service, Manager Service, website source checkout, browser session, or mutable service state during materialization or analysis;

preserves the current three-service ownership boundaries and immutable case revision model.

The intended result is not to send the whole video to the model. The video is the replayable raw visual record from which the analysis worker builds a compact, evidence-linked image set.

Current branch facts that drive this plan

The latest three-service implementation establishes these ownership rules:

Website Service owns website artifacts, acquisitions, task catalogs, deployments, and static serving.

Collection Service owns Study Revision registrations, Participant Runs, Task Assignments, Task Attempts, traces, screenshots, recordings, and attempt outcomes.

Manager Service owns study specifications, publication operations, and retirement operations.

Analysis scripts own exports and immutable derived analysis cases.

After publication, the extension communicates only with Collection and opens the assignment's frozen target URL.

A Participant Run stores a full study_revision, study_revision_digest, and website_snapshot; each Task Assignment stores its prompt, website_task_id, source position, and target URL.

That frozen Collection state is sufficient to interpret one attempt for Method 3. The analysis path must therefore not retrieve or copy website source.

The current analysis implementation predates that boundary in several places:

scripts/materialize_case.py still calls resolve_source, downloads or accepts a website source directory, copies it into website/, and includes the source tree in the case revision identity.

scripts/export_traces.py still derives index fields from legacy run.website instead of the frozen Study Revision fields.

scripts/run_direct_analysis.py does not send website source or recording, but it recursively sends every JSON file below evidence/ and uses the browser-captured screenshot catalog as its image set.

offscreen.js starts MediaRecorder but does not return a measured recording start time, so trace timestamps cannot yet be mapped precisely onto video timestamps.

docs/UX_ANALYSIS_HARNESS.md, the README, and the architecture guide still describe Method 1/3 comparison commands rather than one canonical Method 3 path.

This plan corrects those mismatches without moving evidence ownership into Website or Manager.

Decision summary

Canonical raw evidence

Collection continues to own and export:

attempt.json
manifest.json
trace.json
recording.webm
snapshots/                 # existing live captures, retained during migration

recording.webm and trace.json remain immutable after attempt finalization. Browser-captured screenshots remain canonical attempt artifacts during the migration, but they are not the primary Method 3 images after the cutover.

Derived analysis evidence

Case materialization creates, outside the Collection data root:

derived/video-keyframes/
  frame-selection.json
  snapshots/
    v0001.jpg
    v0001.json
    v0002.jpg
    v0002.json

These files are derived outputs. They are included in the immutable case revision and its integrity manifest, but they are never copied back into the Participant Run or Task Attempt.

Method 3 input

Method 3 receives:

compact task/attempt/study context;

the complete trace;

the detached evidence manifest;

the frame-selection document;

every video-derived screenshot and its metadata.

Method 3 does not receive:

recording.webm;

website source;

Manager state;

Website Service state;

arbitrary files found by recursive directory scanning;

tools, shell access, web access, or a multi-turn loop.

Primary screenshot policy

The first production policy uses the NAPsack-aligned pair for each low-level event burst:

one frame 75 ms before the first event;

one frame 75 ms after the last event.

Task-start, task-end, and delayed settled-state frames are not primary Method 3 inputs. The full WebM remains available so a separately named policy can derive them later without repeating participant collection.

Non-goals

This implementation does not:

send video directly to the model;

add an analysis endpoint to Website, Collection, or Manager;

make Manager proxy evidence or analysis traffic;

fetch website source for Method 3;

modify a website or propose code fixes in findings;

aggregate findings across attempts;

support multi-tab trace/video stitching;

silently sample screenshots when the complete selected image set is too large;

delete live screenshot capture in the initial cutover;

rewrite the participant/run/assignment/attempt state machine;

change the Study Revision publication protocol.

Target data flow

Website Service                    Manager Service
  artifact/deployment                study publication
          \                              /
           \---- frozen Study Revision -/
                         |
                         v
                  Collection Service
             participant/run/task/attempt
               trace + WebM + live shots
                         |
                  read-only export or
                  local participants tree
                         |
                         v
                  materialize_case.py
            validate frozen run/task context
            validate raw attempt integrity
            trace -> action bursts
            WebM -> deterministic keyframes
            publish immutable case revision
                         |
                         v
                 run_ux_analysis.sh
              Method 3 one-shot request

Materialization and analysis are offline readers. They make no HTTP request to any of the three services.

Ownership and boundary rules

Collection remains the only canonical evidence owner. Recording timing is stored in the Collection session/attempt manifest because it describes captured evidence.

Website and Manager are unchanged by the keyframe implementation. They do not receive recording metadata or analysis results.

No cross-service filesystem paths are introduced. The analysis worker receives a Collection export or an explicit Collection participants root.

The frozen Study Revision is the website context. Method 3 needs artifact identity, provenance, target URL, task identity, prompt, and outcome—not source bytes.

Derived files live only in a case revision. A failed derivation cannot mutate raw evidence or update latest-case.json.

Case inputs are explicit. The evidence manifest, not recursive filesystem discovery, determines every document and image sent to the model.

Proposed case layout

.cases/<attempt-id>/
  latest-case.json
  revisions/<case-revision-id>/
    case.json
    analysis-case.json
    evidence-manifest.json
    case-integrity.json

    evidence/
      participant.json
      run.json
      task.json
      attempt.json
      manifest.json
      trace.json
      recording.webm
      snapshots/                    # live captures; auxiliary during migration

    derived/
      video-keyframes/
        frame-selection.json
        model-input-sequence.json
        snapshots/
          v0001.jpg
          v0001.json
          v0002.jpg
          v0002.json

    contract/
      finding.schema.json
      instructions.md

    output/
      runs/<analysis-run-id>/method-3/
        prompt.txt
        input-manifest.json
        response.json
        findings.json
        run-metadata.json

There is no website/ directory in a Method 3 case.

Recording clock contract

Problem

The current extension starts MediaRecorder, then creates the session clock and attempt, then starts content-script tracking. MediaRecorder.start() currently returns no measured start timestamp. A trace event's ts is therefore not safely usable as a video seek time.

New manifest field

Add a nested, versioned field to SessionManifest:

{
  "recording_timing": {
    "schema_version": 1,
    "clock": "unix-epoch-ms",
    "video_start_epoch_ms": 1784750000000,
    "trace_origin_epoch_ms": 1784750000180,
    "trace_to_video_offset_ms": 180,
    "start_source": "mediarecorder-start-event",
    "video_stop_epoch_ms": 1784750048120,
    "alignment_calibration": {
      "method_id": "mediarecorder-start-plus-visible-transition-v1",
      "artifact_sha256": "sha256:...",
      "browser_build": "Chrome ...",
      "capture_profile": "tab-vp8-30fps-v1",
      "error_statistic": {
        "name": "p95_absolute_ms",
        "value_ms": 34,
        "max_allowed_ms": 50
      }
    }
  }
}

The mapping is:

event_video_time_ms = trace_to_video_offset_ms + event.ts

trace_to_video_offset_ms =
    trace_origin_epoch_ms - video_start_epoch_ms

ffprobe frame timestamps remain authoritative for the actual decodable frame chosen. The wall-clock mapping supplies the target video time.

The MediaRecorder start event does not prove that wall-clock zero equals the first decodable frame PTS. The real-browser calibration estimates this end-to-end error and publishes an immutable, versioned calibration artifact containing the sample, browser build, capture profile, measurement method, and error distribution. `quality: measured` is valid only when its artifact hash verifies and its predeclared statistic is within the policy bound; otherwise use `quality: uncalibrated` and make the case ineligible for the primary condition. Bind the calibration artifact hash into the frame-policy hash and case revision. A withdrawn calibration method makes new materializations ineligible but does not mutate existing case revisions.

Validation rules

For new attempts:

all timestamps are finite integers greater than zero;

trace_origin_epoch_ms >= video_start_epoch_ms;

trace_to_video_offset_ms equals their difference;

the offset is bounded, initially 0 <= offset <= 60_000;

video_stop_epoch_ms, when present, is greater than video_start_epoch_ms;

the calibration artifact hash verifies, its browser/capture profile matches the attempt, and its finite non-negative error statistic is no larger than the predeclared pilot tolerance;

timing is written before content-script tracking begins;

an idempotent replay of attempt creation must not replace different timing metadata.

Do not use performance.now() across extension contexts because its origin is context-specific. Use Date.now() in the MediaRecorder start event and in the background session clock.

Action-burst and frame policy

Add scripts/frame-policy.method3-v1.json so thresholds are versioned data rather than scattered constants.

Suggested initial policy:

{
  "schema_version": 1,
  "policy_id": "method3-napsack-bursts-v1",
  "offsets_ms": {
    "before_first_event": -75,
    "after_last_event": 75
  },
  "burst_thresholds_ms": {
    "click": { "gap": 200, "max_duration": 300 },
    "move": { "gap": 500, "max_duration": 4000 },
    "scroll": { "gap": 500, "max_duration": 3000 },
    "key": { "gap": 500, "max_duration": 6000 }
  },
  "output": {
    "max_frames": 80,
    "max_total_image_bytes": 52428800,
    "max_width": 1440,
    "max_height": 1440,
    "max_total_pixels": 120000000,
    "max_model_images": 80,
    "max_estimated_image_tokens": 120000,
    "min_median_fps": 24,
    "max_frame_gap_ms": 100,
    "jpeg_quality": 80
  }
}

Burst construction

Build bursts deterministically from trace order:

Map click and rightclick events to the click family, mousemove to move, scroll to scroll, and keydown to key.

Use input, change, focus, formsubmit, navigate, pagehide, and pageload as semantic annotations associated with the nearest causal low-level burst when action_id and time permit. They do not replace the raw I/O family and do not merge different event types into one burst.

Group only temporally adjacent events of the same low-level family. An event joins the active family burst when both its gap from the preceding event and the burst duration remain within that family's policy thresholds.

When max_duration would be exceeded, finalize the first half of that family's active burst and retain the second half as the active burst, matching the NAPsack rule. Define the midpoint and odd-event tie break explicitly and test them.

Restart every active burst at a document/page boundary. Active-monitor changes from NAPsack have no direct equivalent because the extension records one task tab; a future multi-tab policy must add an explicit capture-context identifier rather than infer one.

If an action has only semantic events and no capturable click/key/scroll/move event, mark it uncovered in frame-selection.json. Do not invent a timestamped low-level event. A pilot fails eligibility when an outcome-relevant action is uncovered; the operator may inspect and fix trace collection before making this the primary path.

Do not create standalone image requests for resize, copy, paste, snapshot bookkeeping, or other event families absent from the primary policy. Mousemove and keydown are included because the reference method includes move and key bursts; their thresholds and contribution must be measured during the pilot.

Preserve every associated server event sequence number and action ID in burst metadata.

After per-family grouping, sort all before/after frame requests and I/O annotations into one stable global sequence by mapped video timestamp, server sequence, family precedence, and frame role. Overlapping bursts remain separate associations even when two requests decode to the same frame.

Frame requests

For each burst:

before: burst.start_trace_ms + trace_to_video_offset_ms - 75;

after: burst.end_trace_ms + trace_to_video_offset_ms + 75.

Clamp requests to the decodable video interval and record both requested and actual frame times. If multiple requests resolve to the same frame index, write one image with multiple associations.

Do not add task-start, task-end, or delayed settled-post requests to policy v1. Record boundary coverage in metadata so later policies can be evaluated without changing the meaning of the primary condition.

No silent sampling

After frame-index deduplication:

if the frame count exceeds max_frames, materialization fails with an explicit ineligible report;

if encoded images exceed max_total_image_bytes, materialization fails explicitly;

if dimensions, total pixels, model image count, or the documented image-token estimate exceed policy limits, materialization fails explicitly;

if probed cadence is below min_median_fps or contains a gap above max_frame_gap_ms around a selected burst boundary, the primary case is ineligible because the ±75 ms roles cannot be resolved reliably;

no evenly spaced sampling or truncation is permitted in the primary path.

The operator can create a new versioned policy and rematerialize. A policy change produces a different case revision.

Derived metadata schema

frame-selection.json

{
  "schema_version": 1,
  "policy": {
    "policy_id": "method3-napsack-bursts-v1",
    "policy_sha256": "..."
  },
  "recording": {
    "path": "evidence/recording.webm",
    "sha256": "...",
    "duration_ms": 48120,
    "video_stream_index": 0,
    "ffmpeg_version": "...",
    "ffprobe_version": "..."
  },
  "timing": {
    "video_start_epoch_ms": 1784750000000,
    "trace_origin_epoch_ms": 1784750000180,
    "trace_to_video_offset_ms": 180,
    "quality": "measured",
    "alignment_calibration": {
      "method_id": "mediarecorder-start-plus-visible-transition-v1",
      "artifact_sha256": "sha256:...",
      "error_statistic": { "name": "p95_absolute_ms", "value_ms": 34 }
    }
  },
  "bursts": [],
  "frames": [],
  "deduplicated_requests": [],
  "warnings": []
}

Per-frame metadata

{
  "schema_version": 1,
  "snapshot_id": "v0007",
  "source": "video-derived",
  "image_file": "v0007.jpg",
  "frame_index": 380,
  "requested_video_ts_ms": 12620,
  "actual_video_ts_ms": 12666.7,
  "clamped": false,
  "policy_id": "method3-napsack-bursts-v1",
  "associations": [
    {
      "burst_id": "b0003",
      "frame_role": "before",
      "event_family": "click",
      "action_ids": ["..."],
      "event_seq": [42],
      "anchor_trace_ts_ms": 12540,
      "anchor_video_ts_ms": 12720,
      "offset_from_anchor_ms": -53.3
    }
  ]
}

One image may have several associations. Findings continue to cite snapshot_ids; the frame metadata connects each snapshot to the relevant events and temporal role. Each burst record in frame-selection.json also stores a deterministic 16x16 dHash Hamming distance between its before/after images as a diagnostic; it never silently removes a pair. The example timestamps are illustrative; tests must calculate them from the measured timing contract rather than copy these values.

Implementation phases

Phase 1: persist recording/trace clock alignment

Files

offscreen.js

background.js

task-session.js

server/types/index.ts

server/app/api/assignments/[assignmentId]/attempts/route.ts

server/lib/participant-store.ts

server/lib/sessions.ts

server/app/api/complete-task/route.ts

tests/task-session.test.js

relevant Collection integration/source tests

new calibration/method3-recording-alignment-v1.json plus its reproducible browser-run protocol

Tasks

Change offscreen.js::startRecording to resolve only after the MediaRecorder start event.

Request a 30 FPS tab-capture profile where Chrome supports it, record the negotiated track settings, and treat ffprobe's actual frame cadence as authoritative. Do not claim the paper's 30 FPS profile from requested constraints alone.

Return { videoStartEpochMs, startSource } in the START_RECORDING response.

Change background.js::startRecording to return that value instead of resolving undefined.

Change UiRaterTaskSession.beginRecordingOnTab to pass the recording-start result into createSession(recordingStart).

Change background.js::createSession to create traceOriginEpochMs, calculate the offset, and send recordingTiming with attempt creation.

Persist the same timing object in the active session and workflow recovery state.

Validate and store recording_timing during createAttempt/initializeSession.

Return videoStopEpochMs when stopping the recorder and patch it into the session manifest during completion.

Persist `{ uploadKey, videoStartEpochMs, videoStopEpochMs }` with the offscreen pending/uploaded recording state. A repeated STOP after upload success, completion failure, offscreen restart, or service-worker restart must return the original timing object rather than create a new stop time.

Preserve idempotency: an existing session may accept the identical timing object, but a conflicting object is an error.

Do not add this contract to Website or Manager. It is an extension-to-Collection evidence contract, not a cross-service publication contract.

Tests

recording start data reaches createSession unchanged;

active session persistence contains the measured timing fields;

invalid or inconsistent offsets are rejected;

idempotent attempt replay accepts identical timing;

idempotent replay rejects conflicting timing;

start failure still cancels the recorder and invalidates/recovers the attempt according to the existing flow.

upload succeeds, complete-task fails, the extension contexts restart, and retry returns the identical stop timing;

an injectable MediaRecorder test covers start, error, stop, and repeated-stop ordering;

a real Chrome extension acceptance run measures the start-event-to-first-visible-transition alignment error.

Exit criteria

Every newly completed attempt has a measured recording_timing object in manifest.json, and existing capture/finalization tests remain green.

Phase 2: add deterministic video-keyframe derivation

Files

new scripts/video_keyframes.py

new scripts/frame-policy.method3-v1.json

new tests/test_video_keyframes.py

new short synthetic-video fixture or fixture generator

.github/workflows/ci.yml

Tasks

Parse trace.json, manifest.json, and the policy into typed internal structures.

Require server seq values to be unique and strictly increasing and construct bursts from that order. Timestamps locate frames but never reorder events with equal or irregular times.

Validate the recording timing contract before extracting frames.

Build deterministic same-family bursts and ±75 ms frame requests.

Write model-input-sequence.json: one globally time-ordered sequence that interleaves frame references with the low-level and semantic I/O occurring after each frame and before the next. Add stable 60-frame segment boundaries for prompt organization without dropping evidence or making additional model calls.

Run ffprobe once to obtain stream metadata and decodable frame PTS values. Require exactly one selected video stream; use `best_effort_timestamp_time`, normalize the first decodable PTS to video time zero, reject missing PTS, and choose the earlier frame on an equal-distance tie.

Map every request to the closest valid frame according to a documented tie-breaking rule.

Deduplicate by actual frame index while preserving all associations.

Run one ffmpeg decode/select operation for the complete selected index set; do not start one process per frame.

Normalize output dimensions, height/pixel bounds, colorspace, pixel format, JPEG qscale, thread count, bitexact options, and metadata stripping.

Verify that every selected frame was written exactly once.

Write frame-selection.json and per-frame JSON atomically.

Record complete ffmpeg/ffprobe version and build configuration, executable SHA-256, policy hash, source hashes, stream/frame cadence, byte counts, warnings, clamping, and before/after dHash distance.

Treat corrupt WebM, missing timing, excessive frame count, or excessive image bytes as explicit failures.

Determinism note

Different ffmpeg builds or CPU paths may produce different JPEG bytes. CI and production use the same pinned toolchain image. Record the complete build/configuration and executable hash and include the actual derived tree hash in the case revision. The same raw evidence, policy, and pinned toolchain must reproduce the same revision; an unpinned toolchain is allowed to create a different revision rather than pretending byte identity.

Tests

click, move, scroll, and key events use the Appendix A.1 gap/max-duration thresholds;

different event families never merge, even when they overlap;

submit/navigation/page lifecycle records attach as semantic annotations without replacing the causal low-level burst;

max-duration overflow performs the specified half-finalize/half-carry behavior;

document boundaries restart active bursts;

timestamp mapping includes trace_to_video_offset_ms;

duplicate, missing, or non-monotonic server seq values fail;

first-frame PTS normalization, missing PTS, multiple streams, and earlier-frame tie-breaking are covered;

low cadence and a large frame gap around a burst make the primary case ineligible;

frame requests clamp at video boundaries;

duplicate frame indices produce one image with multiple associations;

output IDs are stable for the same input;

over-limit inputs fail instead of sampling;

a synthetic video with visibly distinct time states yields the expected frames at first-event -75 ms and last-event +75 ms.

CI

Run ffmpeg/ffprobe from a pinned CI toolchain image or checksum-verified archive before Python integration tests, then run the existing full Python discovery command. Do not rely on an unpinned floating apt package for reproducibility claims.

Phase 3: make Method 3 case materialization Collection-only

Files

scripts/materialize_case.py

scripts/export_traces.py

scripts/materialize-case.sh

scripts/materialize-case.ps1

scripts/ux_evidence.py

tests/test_materialize_case.py

tests/test_export_traces.py

tests/architecture-boundaries.test.js

Tasks in materialize_case.py

Remove resolve_source from the canonical Method 3 path.

Remove the required source parameter from materialize and materialize_versioned.

Remove --website-source from the canonical CLI.

Do not download website source from Hugging Face when downloading an attempt.

Do not create or hash a website/ tree.

Read website/task context from:

run.study_revision_id;

run.study_revision_digest;

run.study_revision;

run.website_snapshot;

the assignment's website_task_id, prompt, target URL, and source position.

Freeze the canonical digest as a cross-language contract before reimplementing it in Python. Add golden vectors generated by the contracts package covering Unicode, nested objects/arrays, integers, `-0`, fractional/exponent numbers, and provenance fields; require both TypeScript and Python tests to match the exact canonical bytes and `sha256:` digest. If exact equivalence cannot be specified, export the canonical bytes/digest input from Collection rather than approximate JavaScript number formatting in Python.

Verify that the assignment corresponds to exactly one frozen Study Revision task and compare website_task_id, position, source_position, prompt, and target_url exactly.

Copy raw attempt evidence into the stage.

Run video derivation inside the stage.

Build analysis-case.json from frozen Collection state, not source files.

Include raw artifact root, Study Revision digest, task context digest, frame policy hash, tool versions, and derived tree hash in case_revision_id input.

Publish latest-case.json only after raw verification, frame derivation, evidence-manifest validation, and full case-integrity validation succeed.

Make evidence/ and derived/ read-only after publication.

Proposed analysis-case.json

{
  "schema_version": 2,
  "attempt_id": "att_...",
  "attempt_status": "accepted",
  "outcome": "succeeded",
  "study": {
    "study_id": "study_...",
    "study_revision_id": "str_...",
    "study_revision_digest": "sha256:..."
  },
  "website": {
    "website_artifact_id": "wsa_...",
    "website_acquisition_id": "wac_...",
    "website_deployment_id": "wsd_...",
    "artifact_digest": "sha256:...",
    "base_url": "http://d-....localhost:4173/",
    "provenance": {}
  },
  "task": {
    "assignment_id": "asg_...",
    "website_task_id": "wst_...",
    "position": 1,
    "source_position": 3,
    "prompt": "...",
    "target_url": "..."
  }
}

Tasks in export_traces.py

Stop reading new-run identity from legacy run.website.

Add Study Revision and Website Artifact identity to attempt index rows.

Preserve the complete run.json and task.json exactly as today.

Keep the artifact manifest scoped to the immutable attempt artifact; derived case frames remain outside exports.

Continue requiring recording.webm for accepted attempts in the new Method 3 export path.

Architecture boundary test

Add an assertion that the canonical Method 3 materializer contains no Website Service client, Manager client, resolve_source, --website-source, or source-directory dependency.

Migration and legacy behavior

In the same PR that changes the canonical materializer signature, first move the current source-enabled implementation and its fixtures to an explicitly named legacy materializer. Then make materialize-case the source-free primary entrypoint. Do not leave tests or Method 1 pointing at a removed signature until Phase 6.

Do not silently infer new context for old runs:

old runs without study_revision require explicit --allow-legacy-run;

old attempts without measured recording timing require an explicit operator-supplied offset or use their existing live screenshots in a separately named legacy case mode;

legacy mode is never reported as the primary video-derived Method 3 condition.

Phase 4: introduce evidence manifest schema v2

Files

scripts/ux_evidence.py

scripts/materialize_case.py

scripts/run_direct_analysis.py

tests/test_materialize_case.py

Proposed structure

{
  "schema_version": 2,
  "attempt_id": "att_...",
  "analysis_case": {},
  "trace": {},
  "recording": {},
  "frame_selection": {},
  "model_input_sequence": {},
  "input_documents": [],
  "snapshots": [],
  "auxiliary_live_snapshots": [],
  "root_sha256": "..."
}

Rules

recording participates in integrity validation but is marked send_to_model: false.

frame_selection participates in integrity validation and is sent to the model.

model_input_sequence participates in integrity validation and is the authoritative presentation order for frames plus associated I/O. It contains references and compact event projections, not duplicate image bytes.

snapshots contains only the primary video-derived image set.

auxiliary_live_snapshots records existing browser captures for audit/calibration but excludes them from the primary Method 3 payload.

every file record contains path, kind, byte count, and SHA-256;

every record type has a strict schema including send_to_model, and all paths and snapshot IDs are unique;

frame-selection, model-input-sequence, per-frame metadata, and snapshot image records form a closed reference graph: no dangling reference, unlisted primary image, duplicate send, or extra primary snapshot is permitted;

manifest verification follows explicit records rather than recursive discovery;

valid finding snapshot IDs come from manifest.snapshots, not path guessing.

Compatibility

load_evidence_manifest may read schema v1 only for explicitly named legacy cases. Newly materialized primary cases always write v2.

Phase 5: switch the one-shot runner to the explicit derived set

Files

scripts/run_direct_analysis.py

new scripts/run-ux-analysis.sh

optional Windows wrapper scripts/run-ux-analysis.ps1

tests/test_materialize_case.py or a dedicated direct-runner test module

Tasks

Make the evidence manifest the only source of input file selection.

Remove sorted((case_dir / "evidence").rglob("*.json")) from the full condition.

Load exactly:

analysis-case.json;

evidence-manifest.json;

trace.json;

frame-selection.json;

model-input-sequence.json;

explicitly listed snapshot metadata;

every explicitly listed derived image.

Never add recording.webm to the request payload.

Never add auxiliary live screenshots to the primary request.

Present frames in model-input-sequence order. Precede each image with compact text containing its snapshot ID, actual video time, before/after role, burst ID, event family, event sequences, and offset from the burst boundary. Follow it with the compact I/O annotations assigned to the interval before the next frame.

Insert an explicit segment marker every 60 image entries, mirroring the paper's 60-frame grouping for audit and later experiments. In one Method 3 request this is only structure: it does not reproduce separate VLM calls or inherit the paper's measured chunking benefit. The markers do not authorize sampling, truncation, or separate unmerged findings.

Replace the live-capture phase=before caveat in the prompt with instructions for deterministic video-derived roles and timestamps.

Resolve valid snapshot IDs from the verified manifest during output validation.

Hash and record every transmitted document and image in input-manifest.json.

Continue to fail before transport when the complete encoded request exceeds --max-input-bytes.

Continue to use store: false, no tools, strict JSON Schema, and a loopback-only endpoint.

Remove the website tree from before/after mutation checks; check the immutable evidence, derived, manifests, and contract trees instead.

Add scripts/run-ux-analysis.sh as the canonical user-facing command.

Prompt requirement

The prompt must say, in substance:

Screenshots are deterministic frames derived from the task recording using
event bursts. Use each frame's associations, video timestamp, event sequences,
event family, and role (75 ms before the first event or 75 ms after the last
event) together with the interleaved I/O when comparing states. Report only UX
problems this participant actually encountered while attempting the assigned
task. It is valid to return no findings.

Method naming

Use method-3 or direct-one-shot consistently in output metadata. Do not describe it as an ablation in the primary documentation after the cutover.

Phase 6: make Method 3 the only canonical harness path

Files

docs/UX_ANALYSIS_HARNESS.md

docs/ARCHITECTURE.md

README.md

CONTEXT.md

scripts/run_ux_experiment.py

scripts/run-ux-experiment.sh

scripts/run_agent_analysis.py

Method 1/experiment tests

Tasks

Update the harness decision to Method 3 only.

Replace architecture/README commands such as run-ux-experiment --methods 1 with run-ux-analysis.sh.

Explain that analysis is Collection-only and source-free after case materialization.

Mark Method 1, Method 2, Method 4, and the comparison orchestrator as historical experiment tooling.

Keep historical scripts for one migration window if existing result reproduction is required; remove them in a later cleanup commit once no active study depends on them.

Do not retain Method 1's website-source requirement in the canonical materializer merely to keep a deprecated path convenient. A historical source-enabled materializer must be separately named if it must remain.

Update output documentation so one validated Method 3 success updates output/latest-success.json.

Phase 7: optional post-pilot capture simplification

Do not combine this phase with the initial Method 3 cutover.

After validating video-derived frames on real accepted attempts, decide whether to reduce browser-side action screenshots.

Possible follow-up:

keep task-start/task-end live captures as independent recorder-health evidence;

stop treating action-linked live screenshot failures as fatal;

remove the requirement that every accepted attempt contain a task-end live screenshot only after an equivalent video/finalization integrity rule exists;

preserve live capture for an explicit calibration cohort if timing comparisons remain useful.

Changing these rules affects background.js, /api/complete-task, session finalization, export validation, and audit scripts. It must have its own migration and recovery tests.

Failure handling

Missing recording

A new accepted attempt without a non-empty recording.webm is ineligible for primary Method 3 materialization. Do not fall back silently to live screenshots.

Missing measured timing

A new attempt without recording_timing is ineligible. A legacy operator may provide an explicit offset or request a legacy live-screenshot case.

Corrupt or undecodable recording

Fail inside the temporary case stage. Do not publish the revision or update latest-case.json.

Trace/frame mismatch

If a mapped event lies substantially outside the probed video duration after applying the measured offset, fail with a diagnostic containing event sequence, trace timestamp, mapped video timestamp, and video duration.

Input too large

If the complete derived set exceeds frame/image policy limits, materialization is ineligible. If the complete Responses payload exceeds transport budget, the runner is ineligible before the API call. Neither stage samples silently.

Model output cites unknown evidence

Reject the result and do not update latest success.

Test matrix

Extension and Collection

MediaRecorder start event timing propagation;

session-manifest persistence and replay behavior;

attempt creation idempotency with timing;

completion patches stop timing;

recording upload/finalization recovery remains intact.

Video derivation

same-family burst grouping for click, move, scroll, and key using the paper's thresholds;

semantic annotation linkage for input/change/submit/navigation without cross-family burst merging;

global frame/I/O ordering and stable 60-frame segment markers;

clock offset mapping;

frame PTS selection and tie-breaking;

clamping and duplicate-frame associations;

limits and explicit ineligibility;

corrupt input behavior;

synthetic visual fixture accuracy.

Materialization

succeeds with Collection participants data while Website and Manager are absent;

succeeds from an HF attempt export without website source download;

verifies Study Revision digest and task membership;

creates no website/ directory;

creates derived frames and schema-v2 manifest;

policy changes create a different revision;

failed derivation leaves the prior latest pointer unchanged;

tampering with raw or derived files fails integrity validation.

Method 3 runner

payload contains every primary derived image exactly once and in model-input-sequence order;

payload contains explicit documents only;

payload excludes WebM, website source, Manager state, and auxiliary live images;

image labels expose ±75 ms temporal associations and interleaved I/O;

unknown snapshot/event citations fail;

request budget failure occurs before transport;

successful output updates the one canonical latest-success pointer.

Architecture

Website and Manager code remain untouched by evidence derivation;

Collection does not import analysis scripts;

analysis scripts do not import or call Website/Manager clients;

no service-owned writable root is shared;

the extension still has one control origin: Collection.

Validation commands

Run the complete repository checks after the final cutover:

module load python

npm run typecheck
npm run lint
npm run build
npm run test:contracts
npm run test:website
npm run test:collection
npm run test:manager
npm run test:architecture
npm run test:e2e
python3 -m unittest discover -s tests -p 'test_*.py' -v

node --check popup.js
node --check background.js
node --check content.js
node --check offscreen.js
node --check task-session.js

Also run one real local acceptance path:

# Publish and complete one study task using the three-service flow.

sh scripts/audit-evidence.sh \
  --participants-dir /absolute/path/to/ui-rater-data/collection/participants

sh scripts/materialize-case.sh \
  --participants-dir /absolute/path/to/ui-rater-data/collection/participants \
  --attempt-id <attempt-id> \
  --output .cases/<attempt-id>

sh scripts/run-ux-analysis.sh \
  --case .cases/<attempt-id>

Acceptance inspection must confirm:

no Website or Manager process is required for materialization/analysis;

the case has no website source tree;

the case contains measured recording timing and video-derived frames;

the Method 3 input manifest excludes WebM and auxiliary live screenshots;

every finding cites valid event sequences and/or vNNNN snapshot IDs.

Recommended pull request sequence

PR 1 — Recording clock contract

Persist measured MediaRecorder/trace alignment without changing analysis inputs.

PR 2 — Video-keyframe derivation

Add the policy, extractor, synthetic fixture, ffmpeg CI dependency, and unit/integration tests.

PR 3 — Collection-only Method 3 materialization

Remove website source from the canonical case path, validate frozen Study Revision context, and write evidence manifest v2.

PR 4 — Method 3 input cutover

Switch the one-shot runner to the explicit video-derived set and add the canonical wrapper.

Gate — Real-browser calibration and reviewed pilot cohort

Verify the versioned calibration artifact, predeclared timing/coverage/quality thresholds, and Method 3 finding review. If the gate fails, revise instrumentation or create a new policy and repeat the gate; do not execute PR 5.

PR 5 — Conditional documentation and historical harness cleanup

Make Method 3 the sole documented path and deprecate/remove comparison tooling without changing evidence collection.

PR 6 — Optional live-capture simplification

Only after pilot evaluation demonstrates that video-derived evidence is complete and recoverable.

Final acceptance criteria

The implementation is complete when all of the following are true:

New attempts record measured video/trace clock alignment.

Recorder retry/restart paths preserve the original start and stop timing, and the real-browser calibration is within the predeclared error bound.

Accepted attempts remain immutable under Collection ownership.

Materialization reads only Collection-owned/exported data and makes no service request.

Materialization validates the frozen Study Revision and assignment context.

Materialization deterministically derives a complete bounded keyframe set from WebM and trace.

The primary policy groups same-family click/move/scroll/key bursts with the documented thresholds and derives first-event -75 ms and last-event +75 ms frames; project-only settled or task-boundary frames are absent.

The verified model-input sequence globally orders every selected frame with its associated I/O, preserves auditable 60-frame boundaries, and passes the real-attempt pilot gate.

A Method 3 case contains no website source tree.

Method 3 receives every primary derived frame, no WebM, and no unlisted file.

No primary path silently samples or truncates evidence.

Findings are schema-valid and cite only verified events or derived snapshot IDs.

Failed derivation or analysis cannot overwrite a successful case or latest result.

Website, Collection, Manager, and extension ownership boundaries remain enforced by tests.

The README, architecture guide, and harness decision describe one canonical Method 3 workflow.
