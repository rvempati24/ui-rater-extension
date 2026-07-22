# Three-Service Decoupling Implementation Plan

## Status

Implemented on 2026-07-22 and corrected through three rounds of zero-context subagent review. The reviews challenged retirement races, monotonic terminal-operation recovery, crash-safe single-active-run enforcement, admission fail-closed behavior, bounded/single-owner Website jobs, downstream response validation, SPA routing, evidence-path globals, idempotency, ownership, migration, and resumability. The loader-only cutover is complete: Website Service contains local and Hugging Face loaders, and no website-generator provider, contract kind, or runtime code remains. Compatibility is limited to evidence/history paths and explicit migration sentinels. Security remains the explicitly deferred review described near the end of this plan.

## Purpose

This is an execution plan for a coding model. It converts the current coupled launcher into three explicit services while preserving the existing evidence integrity and participant workflow:

1. **Website Service** — website loading/import, task discovery, immutable artifact storage, and static deployment;
2. **Collection Service** — the current extension-facing server, participant runs, assignments, attempts, evidence, export, and upload;
3. **Manager Service** — study definition, task selection, publication, service coordination, and retirement.

The implementation must remain usable after every phase. Do not begin by renaming or moving the existing `server/` directory. It becomes the Collection Service logically first; physical renaming is optional cleanup after all compatibility paths are removed.

## Historical pre-refactor repository facts

The plan is grounded in the current implementation:

- The original `server/scripts/start-with-tasks.mjs` selected a local or Hugging Face website, started an embedded static server, wrote runtime JSON files, and started Next.js with environment variables.
- The original Collection implementation used process-global task and website metadata readers.
- The original task/run bootstrap routes implicitly created runs from that global configuration.
- `server/lib/attempt-outcomes.ts` could request launcher shutdown when a Participant Run completed.
- The extension already talks only to the current server for control/evidence and opens the `site_url` returned with a task. Preserve that single-control-server property.
- The repository contains local and Hugging Face website loaders. Website generation is outside this repository and is intentionally not a Website Service responsibility.

## Target topology

```text
                                control plane
                         +-----------------------+
                         |    Manager Service    |
                         | study spec + publish  |
                         | saga + lifecycle      |
                         +----------+------------+
                                    |
                    versioned HTTP  |  versioned HTTP
                          +---------+---------+
                          |                   |
                          v                   v
              +---------------------+   +----------------------+
              |   Website Service   |   |  Collection Service  |
              | artifact + tasks    |   | study snapshots      |
              | deployment + static |   | participants/evidence|
              +----------+----------+   +-----------+----------+
                         |                          ^
                         | target URL               | control/evidence API
                         v                          |
                              Chrome Extension -----+
```

The Manager is never a proxy for static assets, trace batches, screenshots, video, attempt outcomes, or exports. Once a Study Revision is published, the extension workflow continues if the Manager is stopped.

## Non-negotiable architecture rules

1. Each service owns and exclusively writes its own data root.
2. No service passes another service a local filesystem path.
3. No runtime configuration is exchanged through environment variables, temporary config files, or shutdown marker files.
4. Cross-service writes are idempotent. Resource-creating/upsert calls require an explicit `Idempotency-Key`; persist it with a canonical request digest and resulting resource identity. Reusing a key with different content returns `409 idempotency_key_reused`. Resource-addressed monotonic transitions (`retry`, `close`, `retire`, `release`) are intrinsically idempotent and do not require a key; repeated calls return the current representation/outcome without reversing state.
5. Website Artifacts and published Study Revisions are immutable.
6. A Participant Run binds to exactly one Study Revision for its entire lifetime.
7. The Collection Service stores the complete website/task snapshot needed to interpret evidence. It makes no Website Service or Manager request on extension-facing request paths.
8. Each Website Deployment receives a stable origin root, not a URL path prefix. Root-relative assets, BrowserRouter navigation, `history.pushState`, and direct deep links must remain inside that deployment after restart.
9. Closing Study Admission and creating a Participant Run are serialized by the Collection Service. Retirement closes admission before inspecting active runs and releases the deployment only after all existing runs are terminal.
10. Completing one Participant Run changes only collection state. It does not stop a process, retire a Website Deployment, or complete a multi-participant study.
11. Manager recovery is forward-only: retry incomplete publication steps using the same idempotency keys and byte-equivalent frozen requests. Do not compensate by deleting successfully created resources automatically.
12. Version 1 permits exactly one immutable Study Revision per Study and one Website Deployment per Study Revision. A changed specification creates a new Study.
13. Preserve the current participant/run/assignment/attempt/session ownership and evidence-finalization rules.
14. Keep old entrypoints working until the new three-service end-to-end test passes.
15. The initial deployment boundary is one process per service data root. Horizontal scaling, a shared database, and distributed workers are not part of this refactor.

## Domain ownership

| Object | Authoritative owner | Mutable? | Referenced by |
| --- | --- | --- | --- |
| Website Artifact content | Website Service | No | Website Acquisition, Website Deployment |
| Website Acquisition/provenance | Website Service | No | Manager publication, Study Revision |
| Website task catalog | Website Service, as part of artifact | No | Manager task selection |
| Website Deployment | Website Service | Lifecycle state only | Study Revision |
| Study Specification | Manager Service | Until publication | Manager publication workflow |
| Study Revision | Manager Service | No | Collection Study Registration |
| Collection Study Registration | Collection Service; contains a byte-equivalent Study Revision copy | Admission state only | Participant Run |
| Publication Operation | Manager Service | Yes | Operator/Manager recovery |
| Participant | Collection Service | Yes | Participant Run |
| Participant Run | Collection Service | Lifecycle state only | Task Assignment |
| Task Assignment | Collection Service | Outcome state only | Task Attempt |
| Task Attempt and evidence | Collection Service | Existing state rules | Export and analysis |

Avoid the unqualified term `run` in new contracts. Use `websiteArtifactId`, `participantRunId`, or `publicationOperationId`.

## Contract model

Create one shared runtime-validation package. TypeScript interfaces alone are insufficient at HTTP and persistence boundaries.

### Website Artifact and Acquisition descriptors

Artifact identity represents normalized content, not provenance. Compute `artifactDigest` over a canonical manifest of `dist/` bytes and the normalized task catalog. Exclude generated IDs, timestamps, provenance, and the detached manifest itself so the digest is not self-referential.

```json
{
  "schemaVersion": 1,
  "websiteArtifactId": "wsa_...",
  "artifactDigest": "sha256:...",
  "website": "amtrak",
  "createdAt": "ISO-8601",
  "tasks": [
    {
      "websiteTaskId": "wst_...",
      "sourcePosition": 1,
      "prompt": "...",
      "slug": "...",
      "group": "...",
      "startPath": "/",
      "isMind2Web": true,
      "taskSource": "mind2web",
      "legacyAppId": "optional plain_app value",
      "suggestedFlows": []
    }
  ]
}
```

`websiteTaskId` must be stable for the same artifact and source task. In v1 always derive it after digest computation from `artifactDigest` plus source position; generated IDs and selected order are not identity inputs.

Each successful resolution also creates a separate immutable acquisition:

```json
{
  "schemaVersion": 1,
  "websiteAcquisitionId": "wac_...",
  "websiteArtifactId": "wsa_...",
  "artifactDigest": "sha256:...",
  "source": {
    "kind": "local|huggingface",
    "repoId": "optional",
    "revision": "optional",
    "commitSha": "optional",
    "sourceUrl": "optional"
  },
  "resolvedAt": "ISO-8601"
}
```

Two acquisitions with different provenance may reference the same content artifact. A Study Revision freezes the selected acquisition, so content deduplication never substitutes another source's provenance.

### Website Deployment descriptor

```json
{
  "schemaVersion": 1,
  "websiteDeploymentId": "wsd_...",
  "websiteArtifactId": "wsa_...",
  "artifactDigest": "sha256:...",
  "baseUrl": "http://d-abc123.localhost:4173/",
  "status": "ready|released",
  "createdAt": "ISO-8601"
}
```

The static router resolves `startPath` relative to `baseUrl`. It must never place the Collection Service origin into artifact metadata.

### Study Revision snapshot

```json
{
  "schemaVersion": 1,
  "studyId": "study_...",
  "studyRevisionId": "str_...",
  "website": {
    "websiteDeploymentId": "wsd_...",
    "websiteArtifactId": "wsa_...",
    "websiteAcquisitionId": "wac_...",
    "artifactDigest": "sha256:...",
    "baseUrl": "http://d-abc123.localhost:4173/",
    "provenance": {}
  },
  "tasks": [
    {
      "websiteTaskId": "wst_...",
      "sourcePosition": 3,
      "position": 1,
      "prompt": "...",
      "slug": "...",
      "group": "...",
      "isMind2Web": true,
      "taskSource": "mind2web",
      "legacyAppId": "optional plain_app value",
      "suggestedFlows": [],
      "targetUrl": "http://d-abc123.localhost:4173/"
    }
  ],
  "publishedAt": "ISO-8601"
}
```

The Manager is authoritative for this revision. The Collection Service validates and persists a byte-equivalent copy plus a separate mutable admission record:

```json
{
  "studyRevisionId": "str_...",
  "revisionDigest": "sha256:...",
  "admission": "accepting|closed|retired"
}
```

The Collection Service does not later dereference `websiteDeploymentId` to reconstruct a run. Admission changes never modify the frozen revision JSON.

## Service APIs

All new endpoints live under `/api/v1`. Use a common error envelope:

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "operator-readable text",
    "retryable": false,
    "details": {}
  }
}
```

### Website Service

```text
POST   /api/v1/artifact-jobs
GET    /api/v1/artifact-jobs/:operationId
POST   /api/v1/artifact-jobs/:operationId/retry
GET    /api/v1/artifacts/:websiteArtifactId
GET    /api/v1/acquisitions/:websiteAcquisitionId
POST   /api/v1/deployments
GET    /api/v1/deployments/:websiteDeploymentId
DELETE /api/v1/deployments/:websiteDeploymentId
GET    /api/v1/health/live
GET    /api/v1/health/ready
```

`POST /artifact-jobs` accepts a discriminated source request:

- `local`: accepted only by the Website Service's loopback operator interface, never stored or forwarded by Manager;
- `huggingface`: repository/revision and exact or filtered website selector.

For a local source, the operator/compatibility CLI imports it into Website Service first and gives Manager the returned opaque artifact/acquisition IDs. Thus no service-to-service request contains a local path. A future archive-upload interface may replace the loopback-only path input without changing Manager contracts.

Artifact resolution is asynchronous because downloads can be slow. The operation states are `queued`, `running`, `succeeded`, `failed_retryable`, and `failed_terminal`. A succeeded operation contains both `websiteArtifactId` and `websiteAcquisitionId`. Only `failed_retryable` accepts the explicit retry endpoint; retry retains the same operation and idempotency receipt rather than creating a new job.

`POST /deployments` is idempotent for its canonical request. Static content is served only from the Website Service data root. The control API and runtime traffic are separate origins. In local v1, the runtime listener maps a DNS-safe routing label such as `d-abc123.localhost:4173` to one deployment and serves that site's paths from `/`; the routing label is distinct from IDs that contain underscores. Production uses a configured wildcard DNS origin. Do not rewrite generated HTML or mount arbitrary SPAs under `/sites/<id>/`. Persist the resolved origin template/routing key with the deployment so restart reproduces the same `baseUrl`.

`GET /acquisitions/:id` returns the complete provenance descriptor. Manager must load both opaque artifact and acquisition references, then verify that `websiteArtifactId` and `artifactDigest` match before it may publish a Study Revision.

### Collection Service

```text
POST /api/v1/admin/study-revisions
GET  /api/v1/admin/study-revisions/:studyRevisionId
GET  /api/v1/admin/study-revisions/:studyRevisionId/summary
POST /api/v1/admin/study-revisions/:studyRevisionId/close
POST /api/v1/admin/study-revisions/:studyRevisionId/retire
POST /api/v1/participants/:participantId/runs
POST /api/v1/participants/:participantId/runs/resume
GET  /api/v1/participants/:participantId/runs/:participantRunId/tasks
GET  /api/v1/health/live
GET  /api/v1/health/ready
```

Keep existing attempt/evidence/outcome routes during this migration. New run creation requires:

```json
{
  "studyRevisionId": "str_..."
}
```

and an `Idempotency-Key`. It copies the immutable Study Revision snapshot into `run.json`, creates Task Assignments from its ordered tasks, and returns the existing run capability plus task list. The task read endpoint has no side effects.

Creating a run and closing admission must take the same Study Registration lock. Under that lock, run creation checks `admission=accepting` and then acquires the participant lock in that fixed order. Closing changes admission to `closed`; every later run creation returns `409 study_admission_closed`. No code may acquire those locks in the reverse order. `retire` requires closed admission and zero active runs, then marks the registration retired without altering its revision snapshot.

Participant Run creation also enforces the current single-active-run rule. If the participant has an active run, return `409 participant_run_active` with that run ID. A terminal run permits a new one. Replacing an active run requires a separately explicit abort operation; `create run` never silently changes the active pointer.

`POST .../runs/resume` accepts `studyRevisionId` and returns the active Participant Run's ID, current run capability, and current representation only when participant and Study Revision both match. It returns 404 when none exists and 409 when the participant's active run belongs to another Study Revision. This endpoint is the supported recovery path after extension cache/key/capability loss; returning a bare run ID is not sufficient.

Every Collection transition that can place a Participant Run into `active` must take the same Study Registration lock and require `admission=accepting`. In v1, `completed` and `aborted` runs are terminal and cannot be reactivated. Unarchiving a previously active run is allowed only while admission is accepting; after close it returns `409 study_admission_closed`.

The old `/api/tasks` and `/api/participants/:participantId/runs` bootstrap routes now return `410 legacy_*_route_removed` and point callers to the versioned Study Revision endpoints. They must not delegate through process-global task or website metadata. Existing attempt/evidence routes remain separate compatibility surfaces.

### Manager Service

```text
POST /api/v1/studies
GET  /api/v1/studies/:studyId
POST /api/v1/studies/:studyId/publish
GET  /api/v1/publication-operations/:operationId
POST /api/v1/studies/:studyId/retire
GET  /api/v1/health/live
GET  /api/v1/health/ready
```

A Study Specification contains one website source request and one task selector. Version 1 has one immutable specification and one revision per Study; publishing freezes the specification, and a changed configuration requires a new Study.

```json
{
  "websiteSource": {
    "kind": "artifact|huggingface",
    "websiteArtifactId": "required for artifact",
    "websiteAcquisitionId": "required for artifact"
  },
  "taskSelector": {
    "kind": "all|positions|random|mind2web",
    "positions": [1, 3, 5],
    "count": 3,
    "seed": "pilot-01"
  }
}
```

Keep Study lifecycle separate from operation progress:

```text
Study: draft -> publishing -> ready -> retiring -> retired

Publication Operation:
  specification_frozen
  -> artifact_requested -> artifact_ready
  -> deployment_ready
  -> revision_prepared
  -> collection_registered
  -> succeeded

Any operation step -> failed_retryable | failed_terminal
```

At `specification_frozen`, persist the exact specification digest, Website/Collection endpoint identities, and every derived creation/upsert idempotency key before the first remote call. At `revision_prepared`, persist the complete canonical Study Revision JSON, ID, `publishedAt`, task order, digest, and Collection idempotency key before registration. Every retry resends byte-equivalent content to the same service identities. Configuration changes affect only new operations.

Persist the result of each remote step before beginning the next. Retrying `publish` resumes the one existing Publication Operation and must converge on the same artifact job, acquisition, deployment, and Collection Study Registration. A second publish request after success returns that result; it never creates revision 2.

Retirement is a separate persisted operation:

```text
close Collection admission
  -> wait/refuse while active Participant Runs > 0
  -> release Website Deployment
  -> mark Collection registration retired
  -> mark Study retired
```

Closing admission is irreversible in v1 and is serialized with run creation, removing the check/release race. If runs remain, the Study stays `retiring` and the operation may be retried after they complete or are explicitly aborted. A completed Participant Run is merely one aggregate input; it never automatically retires the study.

### Wire-level behavior

The shared contract package must define all request and response bodies. The following behavior is fixed before service implementation:

| Endpoint | Request | First success | Idempotent replay | Conflict/precondition |
| --- | --- | --- | --- | --- |
| Website `POST /artifact-jobs` | source + required key | `202` operation | `202` same operation | `409` key/digest mismatch |
| Website `POST /artifact-jobs/:id/retry` | resource-addressed, no key | `202` same operation | `202` current operation | `409` terminal/not retryable |
| Website `POST /deployments` | artifact ID + required key | `201` descriptor | `200` same identity/current descriptor | `409` key/digest mismatch |
| Website `DELETE /deployments/:id` | resource-addressed, no key | `204` | `204` | `409` only for explicit service precondition |
| Collection `POST /admin/study-revisions` | frozen revision + required key | `201` registration receipt | `200` same identity/current admission | `409` key/digest or ID/content mismatch |
| Collection `POST .../:id/close` | resource-addressed, no key | `200` closed admission | `200` current admission | `409` already retired |
| Collection `POST .../:id/retire` | resource-addressed, no key | `200` retired admission | `200` current admission | `409` accepting or active runs remain |
| Collection `POST /participants/:id/runs` | Study Revision ID + required key | `201` run/tasks/capability | `200` same run identity + current representation | `409` key mismatch, closed study, or another active run |
| Collection `POST /participants/:id/runs/resume` | participant + Study Revision, no key | `200` active run/current capability | `200` current representation | `404` none; `409` active run belongs to another revision |
| Collection run task `GET` | run capability | `200` frozen tasks | same | `401/404` |
| Manager `POST /studies` | complete v1 spec + required key | `201` Study | `200` same Study | `409` key/digest mismatch |
| Manager `POST /studies/:id/publish` | no mutable input | `202` operation | `202/200` same operation/result | `409` retired or terminal failed operation |
| Manager `POST /studies/:id/retire` | no mutable input | `202` operation | `202/200` same operation/result | `409` Study not ready |

Persist idempotency receipts for at least the lifetime of the resource they created. Scope a key by service, method, route/parent resource, and caller. A replay fixes resource identity, not a stale response body: return the resource's current representation, and use the task GET for current assignment/outcome state. The stable error envelope's `retryable` value is authoritative: transport errors, `408`, `425`, `429`, and `5xx` normally retry; other `4xx` do not unless their declared error code says otherwise.

Use these shared response shapes rather than service-specific ad hoc payloads:

```json
{
  "operation": {
    "operationId": "op_...",
    "status": "queued|running|failed_retryable|failed_terminal|succeeded",
    "step": "stable_step_name",
    "result": {},
    "error": null
  }
}
```

```json
{
  "registration": {
    "studyRevisionId": "str_...",
    "revisionDigest": "sha256:...",
    "admission": "accepting|closed|retired"
  },
  "runCounts": {
    "active": 0,
    "completed": 1,
    "aborted": 0,
    "total": 1
  }
}
```

Artifact/deployment/Study/run GETs return their full shared descriptor with `200`, missing resources return stable `404 *_not_found`, and health endpoints return process/store readiness plus a stable `serviceInstanceId` persisted in that service's data root. Each Manager operation pins base URL plus `serviceInstanceId`; recovery fails explicitly instead of sending old resource IDs to a different data root now mounted at the same URL. The contracts package must provide concrete schemas for operation results at each successful terminal step and for the existing run/tasks/capability response; `result: {}` is not accepted as an unspecified escape hatch in implementation.

## Runtime flows

### Publish a study

```text
Operator -> Manager: create Study Specification
Operator -> Manager: publish revision
Manager -> Website: create/recover artifact job
Manager -> Website: create/recover deployment
Manager: select tasks from immutable artifact catalog
Manager: persist byte-equivalent Study Revision request
Manager -> Collection: register immutable Study Revision snapshot
Manager -> Operator: ready + collector URL + studyRevisionId
```

### Start and complete participant work

```text
Extension -> Collection: create/recover Participant Run(studyRevisionId)
Collection -> Extension: frozen assignments + target URLs + run capability
Extension -> Website: open target URL
Extension -> Collection: attempt/trace/snapshot/video/outcome requests
Collection: mark Participant Run completed
```

Neither the Manager nor Website Service is called synchronously by Collection during the second flow.

### Restart and partial failure

- Manager stops: published studies and active collection continue; publication resumes from its persisted step.
- Website Service restarts: deployment IDs and base URLs resolve from persisted deployment records.
- Collection Service restarts: existing filesystem ownership and idempotent attempt recovery continue.
- Website artifact succeeds but Collection registration fails: Manager retries registration; it does not create a second artifact or delete the first.
- Manager crashes after Collection registration but before marking ready: it resends the persisted revision bytes and receives the same registration receipt.
- Deployment becomes unavailable during a task: Collection evidence remains valid; the attempt may follow the existing recording-problem path. Manager/operator restores the same logical deployment URL.
- Two studies use the same artifact: they reuse immutable content but have distinct acquisitions when provenance differs, and v1 always creates separate deployments and Study Registrations.
- Retirement races with run creation: the shared admission lock orders one first; a committed run keeps retirement waiting, while a committed close makes run creation fail before a deployment can be released.

## Target repository layout

```text
package.json                         # npm workspaces and aggregate scripts
packages/
  contracts/
    src/
      common.ts
      website.ts
      study.ts
      errors.ts
    test/
services/
  website-server/
    src/
      api/
      domain/
      providers/
      storage/
      static/
    test/
  manager/
    src/
      api/
      clients/
      domain/
      storage/
      workflows/
    test/
server/                              # Collection Service; keep path during migration
extension files at repository root  # move only in optional cleanup
tests/
  architecture-boundaries.test.js
  three-service.e2e.test.js
```

Use npm workspaces so all three Node services consume exactly one contract package and one lockfile. Regenerate the lockfile with npm; do not hand-edit or concatenate lockfiles.

## Execution discipline for the implementing model

- Execute tasks in order and keep one working compatibility path at every commit.
- Start each task with its failing unit/contract/integration test where practical.
- Do not delete the old launcher behavior until the three-service E2E test is green.
- Do not modify evidence finalization semantics as part of this refactor.
- Do not perform live Hugging Face writes in tests.
- Use a local fixture artifact containing a tiny SPA and three tasks for integration tests.
- Use ephemeral ports in automated tests; never assume 3000 or 4173 is free.
- Store each service's test data under a distinct temporary directory.
- After each phase run existing extension tests, Collection Service tests, typecheck, and the new service tests.
- Treat file/directory moves as a final mechanical cleanup, not an architectural milestone.

## Phase 0 — Freeze behavior and introduce shared contracts

### Task 0.1: Add characterization tests for the current boundary

**Modify:**

- `tests/mvp-source.test.js`
- `tests/task-selection.test.js`
- `tests/participant-store.integration.test.js`

**Add:**

- `tests/fixtures/website-artifact/dist/index.html`
- `tests/fixtures/website-artifact/dist/assets/app.js`
- `tests/fixtures/website-artifact/trials-config.json`

**Work:**

1. Capture the existing guarantees that task order, source positions, provenance, run ownership, outcome finalization, and evidence paths must preserve.
2. Add a three-task static fixture with root-relative assets/navigation, `history.pushState`, and a directly loadable deep SPA route. A path-prefix deployment must make this fixture fail, proving the test covers the current generated-site constraint.
3. Ensure tests use fixture paths and temporary data roots rather than current cache/data folders.

**Done when:** Existing behavior is protected without making any network request.

### Task 0.2: Create the workspace and runtime contract package

**Add:**

- `package.json`
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/common.ts`
- `packages/contracts/src/errors.ts`
- `packages/contracts/src/website.ts`
- `packages/contracts/src/study.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`

**Modify:**

- `server/package.json`
- `server/next.config.ts`

**Remove only after root install succeeds:**

- `server/package-lock.json`

**Work:**

1. Introduce npm workspaces for `server`, `services/*`, and `packages/*`.
2. Rename only the package name, not the directory, from `ui-rater` to `@ui-rater/collection-server`.
3. Add one runtime schema/validator implementation for every cross-service request, response, and persisted descriptor.
4. Export inferred TypeScript types from the same runtime schemas.
5. Implement one shared canonical JSON serializer and SHA-256 request-digest helper. It serializes validated schema fields in deterministic key order and excludes transport headers such as `Idempotency-Key`; every service uses this helper for receipts.
6. Add tests for valid examples, missing IDs, invalid URL schemes, duplicate task IDs/positions, unknown schema versions, mismatched artifact digests, acquisitions with identical content/different provenance, admission transitions, canonical serialization, and idempotency key/request-digest mismatch.
7. Configure Next.js to transpile the workspace contract package if needed.

**Done when:** All services can depend on `@ui-rater/contracts`, malformed boundary data fails deterministically, and existing server commands still work from their documented locations.

## Phase 1 — Build the independent Website Service

### Task 1.1: Implement immutable artifact storage

**Add:**

- `services/website-server/package.json`
- `services/website-server/tsconfig.json`
- `services/website-server/src/config.ts`
- `services/website-server/src/domain/artifact.ts`
- `services/website-server/src/storage/artifact-store.ts`
- `services/website-server/src/storage/acquisition-store.ts`
- `services/website-server/src/storage/operation-store.ts`
- `services/website-server/src/storage/atomic-file.ts`
- `services/website-server/test/artifact-store.test.ts`

**Work:**

1. Give Website Service its own required absolute `WEBSITE_SERVICE_DATA_DIR` in production and a safe local default in development. Persist a stable `serviceInstanceId`; bind the control API to loopback by default and configure the runtime wildcard origin separately.
2. Import a candidate website into a staging directory.
3. Validate `dist/index.html`, parse and normalize the task catalog, reject symlinks and paths escaping the candidate root, and compute a deterministic detached content manifest/digest. Digest inputs include normalized task content and website bytes but exclude provenance, IDs, timestamps, and the manifest itself.
4. Publish an immutable artifact directory atomically under `artifacts/<websiteArtifactId>/`.
5. Publish a separate immutable acquisition record for every resolved source. If the same digest is imported twice, reuse the content artifact but preserve both provenance records.
6. Never expose `source_dir`, `task_file`, cache paths, or deployment paths in a public artifact or acquisition descriptor.

**Done when:** Restarting the store reproduces the same descriptors, duplicate content converges without losing distinct provenance, and partial staging folders are never visible as artifacts/acquisitions.

### Task 1.2: Extract acquisition providers

**Add:**

- `services/website-server/src/providers/provider.ts`
- `services/website-server/src/providers/local-provider.ts`
- `services/website-server/src/providers/huggingface-provider.ts`
- `services/website-server/test/providers.test.ts`

**Modify:**

- `scripts/resolve_hf_website.py`
- `tests/test_resolve_hf_website.py`

**Work:**

1. Define `ArtifactProvider.resolve(request, stagingDir)` returning one common candidate-artifact plus acquisition-provenance shape.
2. Move local directory validation/copy behavior out of `start-with-tasks.mjs` into `LocalProvider`.
3. Refactor the Python Hugging Face resolver so it downloads and reports a pinned source artifact but does not deploy into `server/public/apps`.
4. Have `HuggingFaceProvider` invoke the resolver and then import through the same immutable artifact store as local sources.
5. Normalize Mind2Web information from both task metadata and `mind2web_tasks.txt` into `isMind2Web`/`taskSource`. Also preserve `legacyAppId` and `suggestedFlows` needed by compatibility projections. Manager never reads source sidecars.
6. Keep the provider boundary limited to local and Hugging Face loaders. Website generation is an upstream concern and must hand the loader an ordinary website directory or an equivalent future loader input; no generator protocol belongs in this service.

**Done when:** Local and mocked-HF providers yield identical public descriptor shapes and no provider writes outside its staging directory.

### Task 1.3: Implement deployment and static serving

**Add:**

- `services/website-server/src/domain/deployment.ts`
- `services/website-server/src/storage/deployment-store.ts`
- `services/website-server/src/static/site-handler.ts`
- `services/website-server/test/static-site.test.ts`

**Work:**

1. Persist deployment identity separately from artifact identity.
2. Route a dedicated DNS-safe label such as `d-abc123.localhost` to one immutable artifact and serve it at origin root without copying into the Collection Service tree. Persist the label separately from the underscore-bearing deployment ID. Keep Website control APIs on a different origin/port.
3. Support SPA fallback to that deployment's `index.html` at root and reject unknown Host values. Do not use a path prefix except for an artifact explicitly declaring and testing `basePathCompatible=true`; that mode is outside v1.
4. Return correct content types, `ETag` from artifact content, and explicit cache behavior.
5. Persist hostname/routing configuration and preserve the exact base URL after a Website Service restart.
6. Make release idempotent. A released deployment returns `410 Gone`; do not delete its artifact automatically.

**Done when:** Root-relative assets/navigation, `pushState`, direct deep routes, and SPA fallback work on two simultaneous deployment origins; traversal, unknown-host, and cross-deployment requests fail; restart retains URLs; and release does not affect another deployment of the same artifact.

### Task 1.4: Expose Website Service HTTP API

**Add:**

- `services/website-server/src/server.ts`
- `services/website-server/src/api/artifact-jobs.ts`
- `services/website-server/src/api/artifacts.ts`
- `services/website-server/src/api/acquisitions.ts`
- `services/website-server/src/api/deployments.ts`
- `services/website-server/src/api/health.ts`
- `services/website-server/test/api.integration.test.ts`

**Work:**

1. Implement the Website Service endpoints from this plan, including acquisition lookup and artifact/acquisition association validation.
2. Persist operation state before starting work and after each transition.
3. Bound worker concurrency; a process restart changes stale `running` operations to `failed_retryable`. Only the explicit retry transition moves them back to `queued`, retaining the same operation/idempotency receipt.
4. Validate every request/response using the shared contracts.
5. Return readiness only after stores are writable and existing deployment records can be loaded; include the stable data-root `serviceInstanceId` used by Manager recovery.

**Done when:** A fixture can be resolved, deployed, served, inspected, restarted, and released entirely through HTTP.

## Phase 2 — Make Collection Service configuration explicit

### Task 2.1: Add immutable Study Revision storage

**Add:**

- `server/lib/study-revisions.ts`
- `server/lib/study-admission.ts`
- `server/app/api/v1/admin/study-revisions/route.ts`
- `server/app/api/v1/admin/study-revisions/[studyRevisionId]/route.ts`
- `server/app/api/v1/admin/study-revisions/[studyRevisionId]/summary/route.ts`
- `server/app/api/v1/admin/study-revisions/[studyRevisionId]/close/route.ts`
- `server/app/api/v1/admin/study-revisions/[studyRevisionId]/retire/route.ts`
- `server/app/api/v1/health/live/route.ts`
- `server/app/api/v1/health/ready/route.ts`
- `tests/study-revisions.integration.test.js`

**Modify:**

- `server/lib/paths.ts`
- `server/types/index.ts`

**Work:**

1. Persist immutable snapshots and mutable admission separately under the Collection Service data root, for example `data/study-revisions/<studyRevisionId>/revision.json` and `admission.json`.
2. Validate with shared contracts before writing.
3. Enforce immutable identity: replaying identical content succeeds; the same ID with different content returns conflict.
4. Persist a canonical content digest and idempotency receipt so registration can be audited and key reuse with different content returns 409.
5. Implement admission transitions `accepting -> closed -> retired`; close and retire are idempotent, and there is no reopen transition in v1.
6. Serialize admission close with Participant Run creation using one study-registration lock and a documented lock order.
7. Implement an aggregate summary from canonical Participant Runs: active, completed, aborted, and total.
8. Apply the existing local-admin guard to registration, close, retire, and summary endpoints.
9. Persist a Collection `serviceInstanceId` in its data root and return it from readiness so Manager cannot replay old IDs against a different Collection store at the same URL.

**Done when:** Study registration/admission is restart-safe, close-vs-create concurrency has no check/use gap, conflicting replay fails, and no Website Service call or shared file read is involved.

### Task 2.2: Bind Participant Runs to Study Revisions

**Modify:**

- `server/lib/participant-store.ts`
- `server/lib/participant-state.ts`
- `server/types/index.ts`
- `server/app/api/participants/[participantId]/runs/route.ts`
- `server/app/api/tasks/route.ts`
- `server/app/api/complete-task/route.ts`
- `server/app/api/admin/runs/[runId]/route.ts`
- `server/app/[participantId]/[comparisonNumber]/page.tsx`
- `tests/participant-store.integration.test.js`

**Add:**

- `server/app/api/v1/participants/[participantId]/runs/route.ts`
- `server/app/api/v1/participants/[participantId]/runs/resume/route.ts`
- `server/app/api/v1/participants/[participantId]/runs/[participantRunId]/tasks/route.ts`
- `server/lib/run-projections.ts`
- `tests/managed-study-flow.integration.test.js`

**Work:**

1. Add `study_revision_id` and the complete frozen website snapshot to new `run.json` records.
2. Add `website_task_id`, `target_url`, normalized source flags, `legacy_app_id`, and `suggested_flows` to new Task Assignments; keep `site_url`/`app_id` as compatibility projections during migration.
3. Change `createRun` so its canonical input is a validated Study Revision, not process-global trial configs and active website metadata.
4. Replace key-only creation recovery with a receipt containing scoped key, canonical request digest, and Participant Run ID. Same key/same Study Revision returns the same run identity with its current representation/capability; same key/different revision returns 409.
5. Enforce one active Participant Run per participant. A new run is allowed only when the prior run is terminal; an active prior run returns its ID and Study Revision ID in a 409 response. Keep explicit abort separate.
6. Add the explicit resume endpoint that verifies participant plus Study Revision and returns the current run capability/current representation. Persist the extension's run-creation idempotency key before its first request, but make resume work after the key and capability are both lost.
7. Make every transition into `active`, including admin unarchive/reactivation, take the Study Registration lock and check accepting admission. Make completed/aborted terminal in v1 and add close-vs-reactivate tests.
8. Make the new task read endpoint side-effect free and require the matching run capability.
9. Copy normalized compatibility fields from Study Revision into Assignment and derive managed session manifests, compatibility `results.json`, `app_id`, task prompt, target URL, and website provenance exclusively from the canonical Run/Assignment snapshot. The managed branch of `complete-task` must not call `getTrialConfigs()` or `generateTrials()` from globals.
10. Refactor the participant comparison page to read the participant's active managed Run and build its compatibility view through `run-projections.ts`; when no active Run exists, show an explicit no-run state instead of creating trials. Remove its import of `manifest.ts` and cover the page in the no-global-config build test.
11. Do not add a new legacy-config adapter. The compatibility launcher imports a website through Website Service and creates a Manager Study; Collection receives only the resulting immutable Study Revision.

**Done when:** With no trials/website global environment variables set, two Study Revisions can create runs and each complete a managed attempt without task, result-projection, session-manifest, or provenance leakage. Concurrent create requests, same-key/different-revision, cache/key/capability-loss resume, active-run conflicts, and reactivation after admission close are covered.

### Task 2.3: Remove Collection-to-launcher lifecycle coupling

**Modify:**

- `server/lib/attempt-outcomes.ts`
- `server/app/[participantId]/complete/page.tsx`
- `popup.js`
- `tests/mvp-source.test.js`

**Eventually remove:**

- `server/lib/launcher-shutdown.ts`
- `server/app/api/runs/[runId]/finish/route.ts`

**Work:**

1. Stop writing `UI_RATER_SHUTDOWN_FILE` from outcome or finish paths.
2. Remove `requestLauncherFinish()` from the extension and remove the finish route: the existing outcome transition has already made the Participant Run terminal, so this endpoint has no remaining domain action. “Keep Local Only” records only the local UI choice and must not promise to close localhost.
3. Keep Hugging Face upload independent of study/service lifecycle.
4. During compatibility, let the old launcher decide its own shutdown locally without a write from Collection; remove auto-close if it cannot do so without coupling.

**Done when:** Completing a run has no process-control side effect and multiple participants can complete independently.

## Phase 3 — Implement the Manager Service

### Task 3.1: Implement Manager persistence and state machine

**Add:**

- `services/manager/package.json`
- `services/manager/tsconfig.json`
- `services/manager/src/config.ts`
- `services/manager/src/domain/study.ts`
- `services/manager/src/domain/publication-operation.ts`
- `services/manager/src/storage/study-store.ts`
- `services/manager/src/storage/operation-store.ts`
- `services/manager/test/state-machine.test.ts`

**Work:**

1. Give Manager its own data root and stable `serviceInstanceId`, and bind its control API to loopback by default.
2. Persist Study Specifications separately from immutable published revisions. In v1 the specification is complete at creation, freezes when publishing starts, and can produce only one revision.
3. Model Study lifecycle (`draft`, `publishing`, `ready`, `retiring`, `retired`) separately from Publication/Retirement Operation step and failure state (`failed_retryable`, `failed_terminal`, `succeeded`).
4. Implement explicit allowed transitions and reject out-of-order transitions; retry resumes the existing operation rather than producing another revision.
5. Store the frozen specification, service endpoint identities, remote resource IDs, canonical requests/responses, and digests at every publication checkpoint.
6. Recover stale in-progress operations after restart without reading current mutable configuration into an old operation.

**Done when:** State transition and restart tests cover every phase and no operation depends only on in-memory promises.

### Task 3.2: Move task selection into Manager

**Add:**

- `services/manager/src/domain/task-selection.ts`
- `services/manager/test/task-selection.test.ts`

**Modify:**

- `server/scripts/task-selection.mjs`

**Work:**

1. Port the current exact-position, random/seeded, all, and Mind2Web selection rules without changing results.
2. Select by immutable artifact task identity while preserving `sourcePosition` and producing sequential Study Revision positions.
3. Consume only normalized artifact fields (`isMind2Web`, `taskSource`, `legacyAppId`, `suggestedFlows`); Manager must not read a task file or `mind2web_tasks.txt` sidecar.
4. Keep `server/scripts/task-selection.mjs` as a temporary compatibility re-export or wrapper.
5. Add parity tests that run legacy and Manager selectors against fixtures representing both embedded Mind2Web metadata and the old adjacent sidecar.

**Done when:** Every existing task-selection test passes against the Manager-owned implementation and seeded results are stable.

### Task 3.3: Implement service clients and publication saga

**Add:**

- `services/manager/src/clients/website-client.ts`
- `services/manager/src/clients/collection-client.ts`
- `services/manager/src/workflows/publish-study.ts`
- `services/manager/src/workflows/retire-study.ts`
- `services/manager/test/publication-saga.test.ts`

**Work:**

1. Use configured Website and Collection base URLs; never import their code or storage modules.
2. Implement bounded request timeouts and decide retries from stable error codes/`retryable`, including retryable `408`, `425`, and `429`, rather than treating every 4xx as terminal.
3. Before the first remote call, freeze the specification, both service endpoint identities, and derived keys. Persist each remote result before advancing.
4. On retry, read persisted IDs and byte-equivalent request bodies and reissue the same idempotent request to the pinned endpoint identity.
5. For opaque references, fetch both artifact and acquisition descriptors and verify their artifact ID/digest association. Construct the Study Revision only from those validated descriptors plus the deployment descriptor and deterministic task selection. Persist the complete revision/digest before calling Collection.
6. Implement retirement in this order: close Collection admission; query/wait for zero active runs; release the Website Deployment; mark the Collection registration retired; mark the Study retired. Do not add a force bypass in this architecture phase.

**Failure tests:**

- crash after artifact request but before persisting response;
- artifact ready, deployment request times out after remote success;
- deployment ready, Collection registration returns 500;
- Collection registration succeeds but Manager crashes before marking ready;
- current Manager service URLs change while an old operation is recovering;
- repeated publish calls race;
- same idempotency key is replayed with a different request;
- close admission races with Participant Run creation;
- Manager crashes after admission close and after Website release;
- retirement requested with an active Participant Run.

**Done when:** Every failure test converges to one acquisition/artifact operation, one deployment, one Study Revision/Registration, and a safe admission state after retry.

### Task 3.4: Expose Manager API and CLI

**Add:**

- `services/manager/src/server.ts`
- `services/manager/src/api/studies.ts`
- `services/manager/src/api/publication-operations.ts`
- `services/manager/src/api/health.ts`
- `services/manager/src/cli.ts`
- `services/manager/test/api.integration.test.ts`

**Work:**

1. Implement the Manager endpoints and a CLI that mirrors current `dev:tasks` selectors.
2. Print the exact Study Revision ID, selected source positions, Website URL, Collection URL, and extension setup values.
3. Make `--dry-run` resolve/select without registering a Study Revision or starting collection.
4. For `--website-dir`, have the compatibility/operator CLI import directly through the Website Service operator API, then create a Manager Study Specification referencing only returned artifact/acquisition IDs. Manager never receives the path.
5. Do not have the Manager proxy extension or website traffic.

**Done when:** An operator can create and publish a study using either HTTP or CLI and inspect a failed/retried operation.

## Phase 4 — Switch the extension to explicit Study Revisions

### Task 4.1: Make Collection URL and Study Revision explicit

**Modify:**

- `popup.html`
- `popup.js`
- `background.js`
- `task-session.js`
- `tests/popup-source.test.js`
- `tests/background-source.test.js`
- `tests/task-session.test.js`

**Work:**

1. Rename in-memory/new storage usage from `serverUrl` to `collectorUrl`; read `serverUrl` once as a migration fallback and write only the new key.
2. Add a required Study Revision field to setup and persist it with the selected Participant Run.
3. Create/recover a run using `POST /api/v1/participants/:participantId/runs` with an idempotency key.
4. If local run identity/key/capability is missing or Collection reports an active matching run, use the explicit resume endpoint and then load tasks from the side-effect-free run-scoped endpoint. A different-revision conflict requires the user/operator to finish or abort that run.
5. Continue sending every attempt/evidence call only to `collectorUrl`.
6. Open `targetUrl` supplied by the frozen assignment. Never construct a Website Service URL in the extension.
7. Clear-cache/start-over may clear local study/run selection but must not mutate Manager, Website, or Collection data; the next setup must be able to resume a matching active run.

**Done when:** The extension has exactly one control API origin, can run two different Study Revisions sequentially, and never calls Manager APIs.

## Phase 5 — Replace the launcher without breaking developer workflow

### Task 5.1: Turn `dev:tasks` into a compatibility wrapper

**Modify:**

- `server/scripts/start-with-tasks.mjs`
- `server/package.json`
- root `package.json`
- `README.md`
- `tests/mvp-source.test.js`

**Work:**

1. Add aggregate development commands for starting Website, Collection, and Manager services independently.
2. Replace launcher internals with a thin call to the Manager CLI/API. Preserve current selectors where semantics remain valid.
3. In local convenience mode, Manager CLI may spawn missing processes, but it must coordinate only through health/API endpoints and explicit process handles. It may not inject task metadata through env/files or embed the Website HTTP handler.
4. Remove copying into `server/public/apps`.
5. Remove runtime task/metadata/shutdown files.
6. Print process ownership clearly: stopping the convenience CLI stops only children it started; it never stops independently running services.

**Done when:** The old command gives a comparable operator experience while all runtime integration follows the new contracts.

### Task 5.2: Materialize historical Study bindings before removing globals

**Add:**

- `scripts/migrate_study_revisions.py`
- `tests/test_migrate_study_revisions.py`

**Modify:**

- `scripts/export_traces.py`
- `scripts/audit_evidence.py`
- `docs/HF_PARTICIPANT_DATASET_V2.md`

**Work:**

1. Run a dry compatibility inventory before deleting any legacy config reader. Cover runs with full website metadata, partial metadata, and no website metadata.
2. Define a `HistoricalStudySnapshot` variant owned only by Collection. It may retain an original target URL/provenance while omitting unavailable artifact, acquisition, deployment, or digest fields. It is permanently `retired` and cannot create new Participant Runs.
3. Do not forge strict v1 artifact/deployment identifiers for history. New published Study Revisions continue to require the full strict contract.
4. Materialize a deterministic historical snapshot plus `study-binding.json` sidecar for each legacy Participant Run. Do not rewrite existing `run.json`, Task Assignment, Task Attempt, trace, recording, snapshot, or analysis files.
5. Update read/export/audit projections to merge the sidecar when present and retain legacy fallback for un-migrated data.
6. Make the command dry-run by default, show every planned sidecar/new record, require an explicit apply flag, and make a second apply a no-op.
7. Compare hashes of all pre-existing files before and after; only newly added historical snapshot/binding files may differ in the directory listing.

**Done when:** Full, partial, and missing-metadata fixtures migrate without fake provenance, no pre-existing byte changes, a second apply is empty, and Collection can read the historical runs with all global website/task variables unset.

### Task 5.3: Remove legacy global configuration

**Remove after all callers migrate:**

- `server/lib/manifest.ts`
- `server/lib/website-metadata.ts`
- `server/lib/launcher-shutdown.ts`
- `server/config/trials-config.json` (the Collection-owned default task list)
- Collection routing/use of artifacts under `server/public/apps` (do not automatically delete local artifact files as part of startup or migration)

**Modify:**

- `server/lib/paths.ts`
- `server/types/index.ts`
- `.env.example`
- `README.md`
- tests that assert the old coupling

**Delete support for:**

- `UI_RATER_TRIALS_CONFIG`
- `UI_RATER_WEBSITE_METADATA_FILE`
- `UI_RATER_WEBSITE_RUN_ID`
- `UI_RATER_SHUTDOWN_FILE`
- `UI_RATER_DEFER_SHUTDOWN_FOR_COMPLETION_CHOICE`

Before removal, require Task 5.2's inventory/migration gate and add an architecture test that fails if any production file still references those names or imports/calls `getTrialConfigs` or `getActiveWebsiteMetadata`.

**Done when:** Collection builds and starts with no active website or task config, all managed evidence paths use Run/Assignment snapshots, and existing Participant Runs remain readable from strict or historical snapshots.

## Phase 6 — Architecture and end-to-end assurance

### Task 6.1: Add architecture-boundary tests

**Add:**

- `tests/architecture-boundaries.test.js`

**Assertions:**

1. Collection production code does not import from `services/website-server` or `services/manager`.
2. Manager production code does not import Website or Collection implementation modules.
3. No forbidden legacy environment variable or shutdown marker remains.
4. Website Service paths do not point into `server/public` or Collection data.
5. Extension code contains no Manager API URL and no Website Service API call.
6. New cross-service handlers import runtime validators from `@ui-rater/contracts`.
7. Collection production code contains no `getTrialConfigs` or `getActiveWebsiteMetadata` call and the old task/run bootstrap routes are 410 migration sentinels.
8. Manager Study Specifications and service clients contain no local filesystem path field.
9. Website deployment descriptors use distinct origin roots and never generic `/sites/<deploymentId>/` prefixes.

**Done when:** A deliberate boundary violation makes the test fail with a useful message.

### Task 6.2: Add three-service E2E test

**Add:**

- `tests/three-service.e2e.test.js`
- `tests/three-service-real.e2e.test.js`

**Implemented automated coverage:**

1. Start all three services on ephemeral ports with separate temporary roots.
2. Publish the fixture artifact and select tasks 1 and 3; verify its root-relative navigation and direct deep route on a deployment-specific origin.
3. Stop Manager.
4. Create a Participant Run in Collection and verify two frozen assignments.
5. Load both target URLs from Website Service, including one SPA route.
6. Verify Collection idempotent run replay after admission close, single-active-run enforcement, corrupt-run fail-closed behavior, and rejection of reactivating an older Run while another Run is active.
7. Restart Website and Collection; verify the same deployment URL and Participant Run.
8. Restart Manager; verify it recovers the study as ready without duplicate remote resources. Unit-level fault injection separately covers terminal-operation/Study projection commit windows.
9. Close admission through Manager retirement, verify an active Run blocks release, explicitly abort it through the compatibility admin transition, retry the same retirement, and verify the deployment returns 410.

The original broader stress scenario (two fully finalized evidence flows, an explicit close-vs-create race, and crashes at every retirement step) remains desirable follow-up coverage; it is not claimed as part of the current real-service E2E.

**Done when:** The scenario is deterministic, credential-free, and passes repeatedly without fixed ports.

### Task 6.3: Final documentation and command verification

**Modify:**

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/PARTICIPANT_MANAGEMENT_V2.md`
- `docs/REPAIR_CONTRACT.md`

**Document:**

- three independent service commands and health checks;
- how to create, publish, resume, inspect, and retire a study;
- extension setup values;
- data-root ownership and backup boundaries;
- local/Hugging Face loader status;
- compatibility command deprecation timeline;
- recovery for each persisted publication step.

**Done when:** Every documented command is executed in a clean local checkout using only the fixture provider, and the documentation no longer describes run completion as closing localhost.

## Required verification commands

The workspace scripts created during implementation should make this final sequence possible:

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
python -m unittest discover -s tests -p 'test_*.py'
```

Also run extension syntax checks for `popup.js`, `background.js`, `content.js`, `offscreen.js`, and `task-session.js`. No verification step may require credentials or an external write.

## Cutover gates

Do not remove a compatibility path until its gate passes:

| Gate | Required evidence |
| --- | --- |
| G1: Website Service usable | Fixture resolves/deploys at a stable dedicated origin; root-relative/deep SPA routes survive restart |
| G2: Collection explicit config | Two concurrent Study Revisions complete attempts without global leakage; close-vs-create is atomic |
| G3: Manager recoverable | Frozen-request failure injection and retirement race tests converge without duplicates or premature release |
| G4: Extension switched | Extension uses collector URL + Study Revision and all evidence tests pass |
| G5: Launcher retired | Three-service E2E green; old CLI delegates only through APIs |
| G6: Globals removed | Collection has no legacy config/shutdown reader; old task/run bootstrap routes return migration 410; architecture test enforces the boundary |
| G7: Loader complete | Local and Hugging Face loader integration/fixture tests pass |

G7 is part of the initial cutover because local and Hugging Face loaders are the complete Website Service scope.

## Deferred security and operations review

Architecture correctness comes first in this plan. As a minimum during implementation, Website and Manager control APIs bind to loopback by default, and Collection registration/admission endpoints reuse the existing local-admin guard. Before any non-local deployment, schedule a separate review covering service authentication, Manager-to-service authorization, CSRF/CORS, artifact archive limits, decompression bombs, local-path provider exposure, SSRF/URL validation, rate limits, retention/force-retire policy, TLS, secrets, and audit access. Do not let those later concerns weaken the ownership and lifecycle boundaries above; also do not claim the system is production-safe before that review passes.

## Final acceptance criteria

- Website, Collection, and Manager can start, stop, and restart independently.
- No shared writable path, runtime metadata file, or shutdown marker connects services.
- The extension talks to one control service and opens Website target URLs as data.
- Manager can resume publication after failure without duplicate artifacts, deployments, or Study Revisions.
- Collection can serve and complete existing Participant Runs while Manager is offline.
- Two Study Revisions can be active concurrently without global task/website state.
- Admission close is atomic with run creation, and retirement cannot release a deployment referenced by a newly committed active run.
- One Participant Run completing never stops a service or retires a study.
- Every Website Deployment runs at a stable origin root compatible with current root-relative SPA routes.
- Website provenance and task identity remain frozen with every Participant Run and exported attempt.
- Existing evidence checksums and attempt ownership semantics remain unchanged through migration.
- Website loading is implemented through the local and Hugging Face providers; no website generator is part of this repository or its service contracts.
