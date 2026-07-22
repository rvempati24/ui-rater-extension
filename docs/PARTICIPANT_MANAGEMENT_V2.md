# Participant Management v2

> Historical design note. The current implementation adds cross-process single-host file locks, atomic/fsynced publication, run/attempt capabilities, idempotent creation, and integrity-v3 export. See [REPAIR_CONTRACT.md](REPAIR_CONTRACT.md).

## Status and boundary

The filesystem-backed MVP is implemented. It supports multiple runs, immutable attempts, participant-selected outcomes and retry, accepted/failed/invalidated state, local admin APIs, participant-v2 export, and legacy copying. A visual admin page, confirmed hard deletion, multi-process concurrency, and SQLite remain future work.

## Domain model

### Participant

A stable study identity, independent of any one task set.

- `participant_id`: operator-facing unique ID
- `status`: `active`, `disabled`, or `archived`
- optional `active_run_id`
- `created_at`, `updated_at`

Disabling a participant prevents new runs but preserves existing data. Archiving hides the participant from the default view without deleting it.

### Run

One configured round of work for one participant.

- `run_id`: immutable generated ID
- `participant_id`
- `status`: `active`, `completed`, `aborted`, or `archived`
- immutable website provenance and task count; each child `task.json` freezes its selected source position and task configuration
- start/completion timestamps

Creating a new run is the normal way to let the same participant perform another task set. It avoids overloading the participant ID with assignment state.

### Task assignment

One selected task at a fixed position inside a run.

- `assignment_id` and `run_id`
- original `source_position` and sequential run `position`
- frozen task slug, text, start URL, group, and app ID
- `status`: `pending`, `completed`, `skipped`, or `failed_no_retry`
- `accepted_attempt_id` only when status is `completed`
- outcome, reason, and outcome timestamp

### Task attempt

One recording attempt for an assignment.

- `attempt_id`, `assignment_id`, and monotonically increasing `attempt_number`
- `status`: `recording`, `completed_pending_outcome`, `failed`, `invalidated`, or `accepted`
- canonical `session_id`
- outcome, timestamps, and optional failure/invalidation reason

An assignment may have many completed or invalidated attempts, but at most one accepted attempt. Retrying never overwrites an earlier trace, video, screenshot, or analysis.

## Lifecycle

1. The operator creates/selects a participant.
2. The operator creates a run. The server freezes the website/task selection and returns a `run_id`.
3. The extension requests the next assignment for that run and starts attempt 1.
4. **Done** saves evidence and changes the attempt to `completed_pending_outcome`; it does not accept it.
5. The participant selects success, failed retry, failed without retry, skip, or recording problem. Retry and recording problem preserve the old attempt and start attempt 2 on the next recording.
6. The run is completed when every task is `completed`, `skipped`, or `failed_no_retry`, or it is explicitly aborted.
7. Old runs/participants can be archived without affecting exports or files.

Normal analysis and Hugging Face export should include accepted attempts by default. An audit export may opt into invalidated and failed attempts. The Hugging Face hierarchy follows the same participant/run/assignment/attempt ownership model rather than organizing traces under website/model directories.

## Operator actions

A minimal local admin page should provide:

- search, create, disable, and archive participants;
- list a participant's runs and create a new run from the current launcher configuration;
- inspect every task and attempt in a run;
- retry an assignment by creating a new attempt;
- inspect immutable accepted, failed, or invalidated outcomes and their reasons;
- complete, abort, or archive a run;
- preview exact files before any permanent deletion.

The extension should store `participant_id`, `run_id`, `assignment_id`, and active `attempt_id`. **Start Over** should clear only extension state; it must never mutate server evidence.

## Storage

For the current single-server pilot, use the participant folder tree as the local source of truth. Keep its structure close to the Hugging Face layout:

```text
data/participants/
  <participant-id>/
    participant.json
    runs/
      <run-id>/
        run.json
        events/
          <event-id>.json
        tasks/
          <position>-<assignment-id>/
            task.json
            attempts/
              <number>-<attempt-id>/
                attempt.json
                manifest.json
                trace.json
                recording.webm
                snapshots/
                analysis/
data/sync-state/            # local-only HF revision/commit/checksum state
```

JSON metadata is small and human-inspectable; evidence stays beside the attempt that owns it. The local server reads this canonical tree directly. The Hugging Face exporter creates query indexes only inside an export package.

For the single-process boundary, writes follow these rules:

- generate path-safe immutable IDs before creating directories;
- serialize mutations per run with an in-process lock;
- write JSON to a sibling temporary file, flush/close it, then rename atomically;
- never rewrite trace, video, screenshots, or completed-attempt evidence;
- store each audit event as a new immutable JSON file rather than appending to one shared log;
- treat `task.json.accepted_attempt_id` as the authoritative accepted-attempt pointer and validate that it references the task's one existing accepted attempt;
- stage HF imports/exports outside the canonical tree and move them into place only after validation.

This does not provide multi-process transactions. The supported pilot boundary is one server process and one operator managing a local data root.

### Division of responsibility

- **Participant folders:** canonical local metadata and evidence used during collection and administration.
- **Derived JSONL indexes:** fast local/HF discovery; safe to delete and rebuild.
- **Hugging Face:** versioned remote snapshot for sharing completed runs, reproducing analysis, and restoring/importing data.

Hugging Face is not used to coordinate a live task. Collection succeeds locally even when the network or HF is unavailable.

### SQLite as future work

SQLite is intentionally deferred. Reconsider it when the system needs multiple server processes, simultaneous operators, high-volume queries, cross-run transactions, or stronger uniqueness/integrity enforcement than one process plus validation can provide. The JSON files remain a portable export format even if a future database becomes the operational metadata store.

## Hugging Face synchronization

[`HF_PARTICIPANT_DATASET_V2.md`](HF_PARTICIPANT_DATASET_V2.md) defines the target layout for `uxBench/ux-task-trace`. Its path hierarchy is:

```text
participants/<participant-id>/
  runs/<run-id>/
    tasks/<position>-<assignment-id>/
      attempts/<number>-<attempt-id>/
```

Website/model provenance is frozen in `run.json` and copied into query indexes; it is no longer the top-level storage key. The default synchronization unit is one completed run, and the default export mode contains only its accepted attempts. Each upload records the HF commit SHA locally so participant/run state can be traced to an exact dataset revision.

Synchronization is explicit rather than pretending local folders and HF are one strongly consistent filesystem:

1. The exporter scans completed runs in the canonical participant tree.
2. It verifies artifacts and checksums, builds export-only query indexes, then creates one HF commit.
3. On success it writes `data/sync-state/<run-id>.json` containing repo, revision, commit SHA, and `synced_at`.
4. On failure participant/task completion is not rolled back; rerunning the exporter retries from the canonical tree.
5. A reconciliation command compares local IDs/checksums with HF index rows and reports missing, stale, or conflicting attempts.

HF-to-local import uses the inverse flow: pin an exact HF commit, download into a staging directory, validate indexes/checksums, and atomically move non-conflicting participant/run folders into the local tree. Conflicting immutable IDs fail closed. The HF revision is retained in local sync state as provenance.

## Deletion policy

Invalidation and archival are the default recovery tools.

- **Invalidate attempt:** immutable for the participant outcome flow; preserves all artifacts and is excluded from normal analysis/export. Recovery creates a new attempt.
- **Archive run/participant:** reversible; hides it from normal active views.
- **Hard-delete attempt:** exceptional and irreversible. It must target one exact attempt/session, show every metadata entry and file path to be removed, require explicit confirmation, and write a tombstone/audit event.

There should be no “delete participant and recursively delete everything” shortcut. Bulk cleanup should be a separately reviewed maintenance operation.

## API sketch

```text
GET    /api/admin/participants
POST   /api/admin/participants
PATCH  /api/admin/participants/:participantId

GET    /api/admin/participants/:participantId/runs
POST   /api/admin/participants/:participantId/runs
GET    /api/runs/:runId/tasks
PATCH  /api/admin/runs/:runId

POST   /api/assignments/:assignmentId/attempts
POST   /api/complete-task
POST   /api/attempts/:attemptId/outcome
PATCH  /api/admin/attempts/:attemptId
DELETE /api/admin/attempts/:attemptId?hard=true
```

The extension-facing endpoints accept stable IDs rather than filesystem paths. Admin endpoints should initially bind to localhost and require an operator token before deployment beyond a single-user machine.

## Migration from the baseline

1. Create `data/participants` and `data/sync-state` directories.
2. Import every participant entry in `data/results.json` as a participant plus one `legacy` run; copy/link existing session and recording artifacts into attempt directories after checksum validation.
3. Add `run_id`, `assignment_id`, and `attempt_id` to new manifests while keeping current fields for compatibility.
4. Update `/api/tasks` and the extension to operate on a selected run rather than treating `participant_id` as the assignment key.
5. Use the implemented atomic JSON helpers, per-run locking, and immutable outcome/retry operations; the visual local admin page remains future work.
6. Use the participant-first exporter on a dedicated `participant-v2` HF revision; select accepted attempts by default.
7. Validate counts and checksums, then switch the dataset default revision only after existing consumers pass migration checks.
8. Keep `data/results.json` as a read-only compatibility projection until downstream consumers move to participant folders.

## MVP acceptance criteria

- One participant can complete two independent runs with different task selections.
- A failed task can be retried, with both attempts retained and only one accepted.
- Failed, skipped-outcome, and invalidated attempts remain available to audit export without deleting files.
- A completed run exports under the matching participant/run path and records its HF commit SHA locally.
- Browser **Start Over** cannot delete or reset server data.
- Concurrent requests handled by the supported single server process cannot lose another participant's update.
- Every state transition has an audit event.
- Permanent deletion lists and removes only the explicitly confirmed attempt/session artifacts.
