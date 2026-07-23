# Architecture and runtime guide

This document explains how UI Rater is split into services, how to run those services locally, and how data moves from study creation to a completed UX-analysis case.

The repository uses an explicit three-service architecture. New code uses the versioned `/api/v1` Study Revision flow described here. The old task/run bootstrap routes are retained only as explicit `410 Gone` migration sentinels; the remaining legacy routes are limited to attempt evidence and historical-data compatibility.

Use the [README quick start](../README.md#quick-start-run-the-three-services) for the shortest local setup. Use this guide when developing or operating the explicit three-service path.

## System overview

```text
                                 control plane
                         +------------------------+
Operator / Manager CLI ->| Manager Service :4310 |
                         | study lifecycle        |
                         +-----------+------------+
                                     |
                         HTTP /api/v1|
                    +----------------+----------------+
                    |                                 |
                    v                                 v
        +--------------------------+      +--------------------------+
        | Website Service :4173    |      | Collection Service :3000 |
        | artifacts + deployments  |      | runs + evidence           |
        +------------+-------------+      +-------------+------------+
                     ^                                  ^
                     | task website                     | control/evidence
                     |                                  |
                     +----------- Chrome extension -----+
```

The Manager is a control-plane service. It is not a proxy for task websites, traces, screenshots, recordings, or exports. After a Study Revision has been published, the extension communicates only with the Collection Service and opens the Website Service URL stored in its task assignment.

## Components and ownership

| Component | Default address | Owns | Does not own |
| --- | --- | --- | --- |
| Website Service | `http://127.0.0.1:4173` | Website artifacts, acquisitions, deployments, and artifact jobs | Participants or collected evidence |
| Collection Service | `http://127.0.0.1:3000` | Study Revision registrations, participants, runs, assignments, attempts, traces, screenshots, and recordings | Website source or study publication |
| Manager Service | `http://127.0.0.1:4310` | Study specifications, publication operations, and retirement operations | Website bytes or participant evidence |
| Chrome extension | Loaded from the repository root | Browser-side workflow and recoverable capture queues | Canonical study or evidence storage |
| Collection export scripts | `scripts/` | Closed evidence exports and compatibility entrypoints | LLM evaluation |
| Usability evaluator | offline package | Method 3 cases, assessments, and remediation requests | Service state, publication, participant allocation, or coding-agent execution |

The shared TypeScript contracts in `packages/contracts/` validate data at HTTP and persistence boundaries. Services exchange IDs and versioned JSON documents; they do not exchange writable filesystem paths. The one exception is the loopback-only operator request that imports a local website into the Website Service.

## Core objects

The most important distinction is between a website, a study, and a participant's work:

| Object | Meaning |
| --- | --- |
| Website Artifact | Immutable normalized `dist/` content plus its full task catalog |
| Website Acquisition | Immutable provenance describing how that artifact was obtained |
| Website Deployment | A stable origin serving one artifact, such as `http://d-….localhost:4173/` |
| Study Specification | Operator choice of website source and task selector |
| Study Revision | Immutable published website/deployment/task snapshot |
| Study Admission | Whether a Study Revision accepts new Participant Runs |
| Participant Run | One participant working against exactly one Study Revision |
| Task Assignment | One selected task at a fixed position in the Participant Run |
| Task Attempt | One recording attempt for an assignment |
| Session Evidence | Trace, screenshots, video, timing, and integrity metadata for an attempt |

A Study Revision is copied into the Collection Service before participants start. Every Participant Run then freezes another copy of that revision. Existing runs therefore continue even if the Manager is stopped.

## Run the three services locally

Run commands from the repository root. The recommended local entry point is a unified development supervisor; the services remain separate processes with separate storage ownership.

### 1. Install dependencies

```bash
npm install
```

Node.js 20.9+ is required. Python 3.9+ and `huggingface_hub` are needed only for Hugging Face acquisition, evidence tooling, or upload.

For a clean separation of service-owned files, choose three different data roots:

```bash
export WEBSITE_SERVICE_DATA_DIR=/absolute/path/to/ui-rater-data/website
export UI_RATER_DATA_DIR=/absolute/path/to/ui-rater-data/collection
export MANAGER_DATA_DIR=/absolute/path/to/ui-rater-data/manager
```

Set these variables in the terminal that starts the corresponding service. Do not point two services at the same writable root.

### Recommended: unified development supervisor

```bash
npm run dev:all
```

The supervisor starts Website, Collection, and Manager independently, prefixes each process's output, waits until all three `/api/v1/health/ready` endpoints succeed, and propagates shutdown when `Ctrl+C` is received or any child exits. Its default roots are:

```text
data/website
data/collection
data/manager
```

Override their common parent with `UI_RATER_DEV_DATA_ROOT`, or override `WEBSITE_SERVICE_DATA_DIR`, `UI_RATER_DATA_DIR`, and `MANAGER_DATA_DIR` separately. `WEBSITE_SERVICE_URL`, `COLLECTION_SERVICE_URL`, and `MANAGER_SERVICE_URL` override readiness/control URLs. To inspect the resolved topology without starting processes:

```bash
npm run dev:all -- --print-config
```

This launcher is deliberately outside every service boundary. It owns no domain data and performs no cross-service writes; it is a local process supervisor, not a fourth service or a return to the coupled launcher.

### Alternative: start each service separately

The commands below use a POSIX shell and three terminals.

### 2. Start Website Service

Terminal 1:

```bash
UI_RATER_REPO_DIR="$PWD" \
WEBSITE_SERVICE_DATA_DIR=/absolute/path/to/ui-rater-data/website \
npm run dev:website
```

The control API uses `127.0.0.1:4173`. Each deployed website uses a separate `*.localhost:4173` origin so root-relative assets and SPA routes remain inside that deployment.

### 3. Start Collection Service

Terminal 2:

```bash
UI_RATER_DATA_DIR=/absolute/path/to/ui-rater-data/collection \
npm --workspace server run dev
```

For production-style use, also set `UI_RATER_CAPABILITY_SECRET` and `UI_RATER_ADMIN_TOKEN` as described in [`server/.env.example`](../server/.env.example). Local development creates an ephemeral capability secret when none is configured.

### 4. Start Manager Service

Terminal 3:

```bash
MANAGER_DATA_DIR=/absolute/path/to/ui-rater-data/manager \
WEBSITE_SERVICE_URL=http://127.0.0.1:4173 \
COLLECTION_SERVICE_URL=http://127.0.0.1:3000 \
npm run dev:manager
```

Manager readiness depends on both downstream services. Verify all three:

```bash
curl http://127.0.0.1:4173/api/v1/health/ready
curl http://127.0.0.1:3000/api/v1/health/ready
curl http://127.0.0.1:4310/api/v1/health/ready
```

## Publish a local website study

A local website directory must contain `dist/index.html` and `trials-config.json`.

```text
website-run/
  dist/
    index.html
  trials-config.json
```

The publication sequence is import, create, publish, and poll.

### 1. Import the website

```bash
npm run manager:cli -- import-local \
  --website-dir /absolute/path/to/website-run \
  --task-file /absolute/path/to/website-run/trials-config.json
```

This returns an `operationId`. Poll the Website Service until its status is `succeeded`:

```bash
curl http://127.0.0.1:4173/api/v1/artifact-jobs/<operation-id>
```

Copy `websiteArtifactId` and `websiteAcquisitionId` from `operation.result`.

### 2. Create a study

Use all tasks:

```bash
npm run manager:cli -- create-study \
  --study-id study_pilot_01 \
  --artifact-id <website-artifact-id> \
  --acquisition-id <website-acquisition-id>
```

Or select exact 1-based source task positions:

```bash
npm run manager:cli -- create-study \
  --study-id study_pilot_01 \
  --artifact-id <website-artifact-id> \
  --acquisition-id <website-acquisition-id> \
  --tasks 1,3,5
```

`--dry-run` prints the Study Specification without writing it.

### 3. Publish the study

```bash
npm run manager:cli -- publish --study-id study_pilot_01
```

Publication is asynchronous. Copy the returned `operationId` and poll Manager:

```bash
curl http://127.0.0.1:4310/api/v1/publication-operations/<operation-id>
```

When the operation reports `status: "succeeded"`, copy `result.studyRevisionId`. That ID is what participants enter in the extension.

### 4. Load the extension

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Load the repository root with **Load unpacked**.
3. Enter a configured participant ID, for example `P001`.
4. Set **Collection URL** to `http://127.0.0.1:3000`.
5. Let the extension discover the latest accepting **Study Revision ID**, or enter one manually.
6. Click **Load Tasks**. The extension resumes an existing active run for the same participant and Study Revision, or creates a new run when none exists.

A participant cannot have two active runs. If its active run belongs to another Study Revision, Collection returns a conflict instead of creating a second run.

**Show a workflow comparison after each task** is an independent, default-off display option. When enabled, the popup waits until the task outcome is recorded, then compares the task-authoring agent's frozen `suggested_flows` with a compact summary of the participant's recorded actions. The comparison stays in extension-local state so reopening the popup can restore it.

## What publication does

Manager persists a publication operation before contacting another service. It then performs these idempotent steps:

1. Check Website and Collection readiness and pin their persistent service identities.
2. Resolve or load the Website Artifact and Acquisition.
3. Ask Website Service for a stable deployment origin.
4. Select tasks and build an immutable Study Revision.
5. Register a byte-equivalent revision in Collection with admission set to `accepting`.
6. Mark the Study and publication operation as ready/succeeded.

Creating artifacts, deployments, studies, registrations, and Participant Runs uses explicit idempotency keys. Reusing a key with different request content returns a conflict instead of silently changing an existing resource.

Manager stores enough intermediate state to resume a publication operation after its own restart. It verifies service identity before continuing so a different data root mounted at the same URL cannot be mistaken for the original service.

## What happens during a participant run

### Run creation and resume

The extension calls only Collection:

```text
POST /api/v1/participants/<participant-id>/runs
POST /api/v1/participants/<participant-id>/runs/resume
GET  /api/v1/participants/<participant-id>/runs/<run-id>/tasks
```

New-run creation uses an idempotency key retained in `chrome.storage.local`. Collection checks that Study Admission is still `accepting`, locks the Study Revision and participant in a fixed order, then freezes the revision and selected task assignments into the new run.

Resume returns the active run, current task position, and a fresh run capability. It succeeds only when the participant's active run belongs to the requested Study Revision.

### Attempt start

When the participant starts a task:

1. The popup opens or reuses the assignment's `targetUrl` tab.
2. The background service worker creates an attempt through `POST /api/assignments/<assignment-id>/attempts` using the run capability.
3. Collection creates the attempt/session and returns an attempt-scoped capability.
4. The offscreen document starts tab video recording.
5. The content script starts interaction tracking in the owned task tab.

The extension rejects events from another tab or session. Opening a second task-originated tab marks the attempt `unsupported_multi_tab`; multi-tab stitching is intentionally not implemented.

### Evidence capture

```text
content script
  |-- interaction batches --> background --> Collection /api/partial-save
  |-- snapshot requests ----> background --> Collection /api/sessions/.../snapshot
  +-- task-end flush --------> background

offscreen recorder
  +-- WebM blob -------------> Collection /api/upload-recording
```

Important properties:

- Events receive stable IDs and increasing server sequence numbers.
- The extension saves an interaction batch locally before waiting for its network acknowledgement.
- Screenshots are placed in IndexedDB before upload and removed only after Collection acknowledges them.
- The video blob is also retained in IndexedDB until upload succeeds or the participant explicitly cancels it.
- Screenshot capture is serialized per browser window and verifies the active task tab before and after capture.
- “Before” screenshots are best effort; their request, capture-start, and completion timestamps are stored for later verification.

### Finalization and outcome

Clicking **Done** first finalizes evidence; it does not immediately accept the attempt:

1. Flush final interactions and capture the reserved task-end screenshot.
2. Upload any pending screenshots and recording.
3. Reconcile locally retained events with Collection.
4. Call `/api/complete-task`; the attempt becomes `completed_pending_outcome`.
5. Submit `succeeded`, `failed_retry`, `failed_no_retry`, `skipped`, or `recording_problem` to `/api/attempts/<attempt-id>/outcome`.

Successful attempts become `accepted`. Failed or invalidated evidence remains on disk. A retry creates a new immutable attempt instead of overwriting the earlier one. A Participant Run completes only when every Task Assignment is terminal.

If the optional workflow comparison is enabled, the background worker summarizes the settled trace during finalization and adds the outcome after submission; the popup displays the result only after the outcome is saved. Input values, page text, and DOM identifiers are omitted, controls receive local ordinal labels, consecutive duplicate actions are collapsed, and the view is capped. Repeated clicks, a long action path, a missing reference, or an unsuccessful outcome produce review cues. These heuristics are not evaluator findings, do not modify the attempt, and are not added to the canonical evidence bundle.

Completing a Participant Run does not stop any service, close admission, or retire the study.

## Storage layout and backup boundaries

With the explicit data roots used above:

```text
ui-rater-data/
  website/
    service-instance-id
    artifacts/<website-artifact-id>/
    acquisitions/<website-acquisition-id>.json
    deployments/<website-deployment-id>.json
    artifact-jobs/<operation-id>.json

  manager/
    service-instance-id
    studies/<study-id>.json
    study-receipts/
    publication-operations/<operation-id>.json

  collection/
    service-identity.json
    study-revisions/<study-revision-id>/
    participants/<participant-id>/runs/<participant-run-id>/
    sessions/       # compatibility projection
    recordings/     # compatibility projection
    results.json    # compatibility projection
    sync-state/     # Hugging Face receipts
```

Each service must be backed up and restored with its own data root. Do not restore Manager state against unrelated Website or Collection roots: persisted service identities are used to detect that mismatch during operation recovery.

The canonical collected evidence is under Collection's `participants/` tree. Compatibility projections can be rebuilt or migrated and must not be treated as the owner of a Task Attempt.

## Inspect and retire a study

Inspect Manager state:

```bash
curl http://127.0.0.1:4310/api/v1/studies/study_pilot_01
curl http://127.0.0.1:4310/api/v1/publication-operations/<operation-id>
```

Inspect Collection admission and run counts:

```bash
curl http://127.0.0.1:3000/api/v1/admin/study-revisions/<study-revision-id>
curl http://127.0.0.1:3000/api/v1/admin/study-revisions/<study-revision-id>/summary
```

Start retirement through Manager:

```bash
curl -X POST http://127.0.0.1:4310/api/v1/studies/study_pilot_01/retire
```

Retirement follows this order:

1. Close Collection admission so no new Participant Run can start.
2. Check for active Participant Runs.
3. Release the Website Deployment only after the active count reaches zero.
4. Mark Collection registration and Manager Study as retired.

If active runs remain, the retirement operation becomes retryable. Existing participants may finish, but new participants cannot enter. Repeating the retirement request resumes the same persisted operation. A released website deployment returns HTTP 410; collected evidence remains readable and auditable.

## Audit, export, and analysis

These operations read from the Collection data root, not from Manager or Website Service.

```bash
sh scripts/audit-evidence.sh \
  --participants-dir /absolute/path/to/ui-rater-data/collection/participants

sh scripts/export-traces.sh \
  --participants-dir /absolute/path/to/ui-rater-data/collection/participants
```

To evaluate one terminal attempt, first cross the Collection boundary:

```bash
npm run export:evidence -- \
  --participants-dir /absolute/path/to/ui-rater-data/collection/participants \
  --attempt-id <attempt-id> \
  --output-root ./evidence-bundles \
  --legacy-task-protocol-bindings ./approved-bindings.json

sh scripts/materialize-case.sh \
  --bundle ./evidence-bundles/<bundle-id> \
  --output-root ./.cases/<attempt-id>
sh scripts/run-ux-analysis.sh \
  --case ./.cases/<attempt-id>/revisions/<case-revision-id>
```

EvidenceBundles and `.cases/` are immutable derived artifacts; neither becomes
canonical attempt evidence. The evaluator validates the closed bundle and has no
path to any service data root. Its case retains the WebM for integrity but sends
only NAPsack-style same-family burst frames (first event -75 ms, last event +75
ms) and ordered I/O to Method 3.

## Failure and recovery guide

| Symptom | Meaning and recovery |
| --- | --- |
| Manager readiness fails | Check Website and Collection `/health/ready`; Manager requires both only for control-plane work |
| Publication is `failed_retryable` | Restore the unavailable dependency and publish the same Study again; persisted IDs and keys are reused |
| `service_identity_changed` | Manager is pointed at a different service data root; restore the original root or create a new Study |
| `participant_run_active` | Resume that run or explicitly finish/abort it before creating another |
| `participant_run_other_revision` | The participant has an active run for another Study Revision |
| `study_admission_closed` | The study no longer accepts new runs; existing runs can still finish |
| Popup lost its capability | Reopen it and resume the same participant/Study Revision to receive a fresh capability |
| Screenshot/video upload failed | Use the popup recovery action; durable browser queues retain unacknowledged media |
| Final trace or task-end capture is missing | Retry finalization or mark **Recording Problem**; do not accept incomplete evidence as successful |
| Task site returns 410 | Its deployment was retired; verify no active run should still reference it |

## Provider and deployment status

- **Local provider:** implemented; accepts an operator-local directory through Website Service.
- **Hugging Face provider:** implemented; requires Python and may require `HF_TOKEN` for private data.
- **Loader scope:** local-directory and Hugging Face loaders are implemented; website generation is outside this repository.
- **Deployment boundary:** local, single process per service data root. Horizontal scaling and distributed locking are not implemented.
- **Security boundary:** Website and Manager control APIs are loopback-only by default. A separate security review is required before non-local deployment.
- **Privacy boundary:** use synthetic websites and fake form values; real-site privacy redaction is not implemented.

## Compatibility path

`server/scripts/start-with-tasks.mjs` is now a thin operator wrapper that calls Website and Manager APIs. The old task/run bootstrap routes return `410 Gone` and no longer read process-global task or website metadata. Compatibility result/session folders and evidence routes remain only to read historical data and preserve the extension's evidence protocol. New architecture work must not reintroduce runtime task JSON files, shutdown marker files, or process-global website configuration into the three-service path.

For new integrations, use:

- Manager `/api/v1` for study creation, publication, inspection, and retirement;
- Collection `/api/v1` for Study Revision registration and Participant Run creation/resume;
- existing Collection evidence routes for attempt capture and outcomes;
- Website `/api/v1` for artifact and deployment lifecycle.

## Verification

The architecture is guarded by contract, service, collection, and boundary tests. The intended complete check is:

```bash
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
```

See also:

- [`REPAIR_CONTRACT.md`](REPAIR_CONTRACT.md) for evidence integrity and supported boundaries;
- [`PARTICIPANT_MANAGEMENT_V2.md`](PARTICIPANT_MANAGEMENT_V2.md) for participant/run/task/attempt states;
- [`UX_ANALYSIS_HARNESS.md`](UX_ANALYSIS_HARNESS.md) for the analysis side of the pipeline;
- [`adr/0001-separate-website-collection-and-orchestration.md`](adr/0001-separate-website-collection-and-orchestration.md) for the service-split decision.
