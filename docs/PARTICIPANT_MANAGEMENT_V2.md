# Participant Management v2

## Status and boundary

This document proposes the next participant-management layer. It is not implemented by the current baseline. The goal is to make retries, invalid data, repeated studies, and cleanup explicit without losing evidence or accidentally deleting unrelated recordings.

## Domain model

### Participant

A stable study identity, independent of any one task set.

- `participant_id`: operator-facing unique ID
- `status`: `active`, `disabled`, or `archived`
- `created_at`, `updated_at`
- optional notes and study-defined metadata

Disabling a participant prevents new runs but preserves existing data. Archiving hides the participant from the default view without deleting it.

### Run

One configured round of work for one participant.

- `run_id`: immutable generated ID
- `participant_id` and `study_id`
- `status`: `created`, `active`, `completed`, `aborted`, or `archived`
- immutable snapshot of website provenance and task configuration
- selection mode, selected source task positions, random seed, and `attempt_id` launcher label
- start/completion timestamps

Creating a new run is the normal way to let the same participant perform another task set. It avoids overloading the participant ID with assignment state.

### Task assignment

One selected task at a fixed position inside a run.

- `assignment_id` and `run_id`
- source task ID/position and run position
- frozen task text, start URL, and relevant metadata
- assignment status derived from its attempts

### Task attempt

One recording attempt for an assignment.

- `attempt_id`, `assignment_id`, and monotonically increasing `attempt_number`
- `status`: `recording`, `completed`, `failed`, `invalidated`, or `accepted`
- canonical `session_id`
- timestamps and optional failure/invalidation reason

An assignment may have many completed or invalidated attempts, but at most one accepted attempt. Retrying never overwrites an earlier trace, video, screenshot, or analysis.

## Lifecycle

1. The operator creates/selects a participant.
2. The operator creates a run. The server freezes the website/task selection and returns a `run_id`.
3. The extension requests the next assignment for that run and starts attempt 1.
4. A successful recording is completed and may be accepted automatically or by the operator.
5. If the extension/site fails, the operator invalidates that attempt with a reason and starts attempt 2.
6. The run is completed when its required assignments have accepted attempts, or it is explicitly aborted.
7. Old runs/participants can be archived without affecting exports or files.

Normal analysis and Hugging Face export should include accepted attempts by default. An audit export may opt into invalidated and failed attempts. The Hugging Face hierarchy follows the same participant/run/assignment/attempt ownership model rather than organizing traces under website/model directories.

## Operator actions

A minimal local admin page should provide:

- search, create, disable, and archive participants;
- list a participant's runs and create a new run from the current launcher configuration;
- inspect every task and attempt in a run;
- retry an assignment;
- accept, invalidate, or restore an attempt with an audit reason;
- complete, abort, or archive a run;
- preview exact files before any permanent deletion.

The extension should store `participant_id`, `run_id`, `assignment_id`, and active `attempt_id`. **Start Over** should clear only extension state; it must never mutate server evidence.

## Storage

Use SQLite for metadata and continue storing large artifacts in the filesystem:

```text
SQLite
  participants
  runs
  run_tasks
  task_attempts
  audit_events

data/sessions/<session-id>/
  manifest.json
  trace.json
  snapshots/
  analysis/

data/recordings/<recording>.webm
```

SQLite provides transactions, uniqueness constraints, indexed lookup, and safe concurrent updates without repeatedly rewriting all of `results.json`. Important constraints include unique `(assignment_id, attempt_number)` and no more than one accepted attempt per assignment.

Every state-changing admin operation should append an `audit_events` record with time, action, target, prior/new state, reason, and operator identity when authentication is later added.

## Hugging Face synchronization

[`HF_PARTICIPANT_DATASET_V2.md`](HF_PARTICIPANT_DATASET_V2.md) defines the target layout for `uxBench/ux-task-trace`. Its path hierarchy is:

```text
participants/<participant-id>/
  runs/<run-id>/
    tasks/<position>-<assignment-id>/
      attempts/<number>-<attempt-id>/
```

Website/model provenance is frozen in `run.json` and copied into query indexes; it is no longer the top-level storage key. The default synchronization unit is one completed run, and the default export mode contains only its accepted attempts. Each upload records the HF commit SHA locally so participant/run state can be traced to an exact dataset revision.

## Deletion policy

Invalidation and archival are the default recovery tools.

- **Invalidate attempt:** reversible; preserves all artifacts; excluded from normal analysis/export.
- **Archive run/participant:** reversible; hides it from normal active views.
- **Hard-delete attempt:** exceptional and irreversible. It must target one exact attempt/session, show every database row and file path to be removed, require explicit confirmation, and write a tombstone/audit record.

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
PATCH  /api/admin/attempts/:attemptId
DELETE /api/admin/attempts/:attemptId?hard=true
```

The extension-facing endpoints accept stable IDs rather than filesystem paths. Admin endpoints should initially bind to localhost and require an operator token before deployment beyond a single-user machine.

## Migration from the baseline

1. Create the SQLite schema without changing existing recording paths.
2. Import every participant entry in `data/results.json` as a participant plus one `legacy` run; link trials that already contain `session_id`.
3. Add `run_id`, `assignment_id`, and `attempt_id` to new session manifests while keeping current fields for compatibility.
4. Update `/api/tasks` and the extension to operate on a selected run rather than treating `participant_id` as the assignment key.
5. Add retry/invalidate/restore operations and the local admin page.
6. Replace the legacy website-first exporter with the participant-first layout on a dedicated `participant-v2` HF revision; select accepted attempts by default.
7. Validate counts and checksums, then switch the dataset default revision only after existing consumers pass migration checks.
8. Keep `data/results.json` as a read-only compatibility projection until downstream consumers move to the new API/database.

## MVP acceptance criteria

- One participant can complete two independent runs with different task selections.
- A failed task can be retried, with both attempts retained and only one accepted.
- Invalidating/restoring an attempt changes export eligibility without deleting files.
- A completed run exports under the matching participant/run path and records its HF commit SHA locally.
- Browser **Start Over** cannot delete or reset server data.
- Concurrent completions cannot lose another participant's update.
- Every state transition has an audit event.
- Permanent deletion lists and removes only the explicitly confirmed attempt/session artifacts.
