# Evaluator Extraction and Remediation Plan

## Outcome

LLM usability evaluation is separated from participant collection.

```text
UI Rater                                      UI Usability Evaluator
Website / Manager / Collection / extension   offline Method 3 package
                   |                                      |
                   +---- EvidenceBundle v1 -------------->+
                                                          |
                                                   UXAssessment v1
                                                          |
                                             RemediationRequest v1
```

UI Rater continues to run when the evaluator is absent. The evaluator receives
immutable artifacts; it never reads a service data root or calls Website,
Manager, or Collection.

The evaluator is temporarily developed in
`packages/usability-evaluator/` and is published to
`Oscar-Ge/ui-usability-evaluator`. The temporary package is removed from UI
Rater only after the standalone wheel passes compatibility and cutover gates.

## Ownership

### UI Rater

- Website owns website artifacts, deployments, and future candidate import.
- Manager owns Study Revisions and future experiment revisions.
- Collection owns participants, attempts, traces, recordings, and exports.
- The extension owns browser capture.
- `EvidenceBundle v1` is the only evaluation input published by this project.

### UI Usability Evaluator

- validates EvidenceBundles;
- derives action-adjacent frames from the recording;
- runs Method 3 through a loopback Responses endpoint;
- validates evidence citations and normalizes `UXAssessment v1`;
- selects approved problems and emits a deterministic coding-agent request;
- creates a closed source snapshot for a future isolated runner.

It does not publish websites, merge patches, allocate participants, or claim
that a candidate is more usable.

## Contracts

### EvidenceBundle v1

One terminal attempt is exported as a closed directory:

```text
bundle-manifest.json
context/study-revision.json
context/task-assignment.json
evidence/attempt.json
evidence/capture-manifest.json
evidence/trace.json
evidence/recording.webm
```

The manifest binds every file by path, byte count, and SHA-256 digest. The
exporter:

- takes a Collection run lock before reading;
- rejects nonterminal or inconsistent attempts;
- requires a native or explicitly approved legacy TaskProtocol;
- removes participant/session identifiers, input values, printable keys, URL
  origins, queries, and fragments;
- writes atomically outside the Collection data root.

The evaluator rejects extra files, symlinks, unsafe paths, digest mismatch,
payload-version mismatch, inconsistent identities, invalid outcomes, unordered
trace events, and inconsistent recording clocks.

### UXAssessment v1

Only schema-valid Method 3 findings with real trace or frame citations can be
normalized. Assessment and problem IDs are deterministic and bind the complete
finding record, its index, raw result digest, case revision, and EvidenceBundle.

### RemediationRequest v1

A request contains only:

- assessment and source-snapshot IDs;
- selected evidence-backed problems;
- bounded instructions and an untrusted-content warning.

Patch, commands, logs, tests, and candidate IDs are outputs and never appear in
the pre-execution request.

## Implemented workflow

```bash
module load python

# Project A: export one terminal attempt.
npm run export:evidence -- \
  --participants-dir /absolute/path/to/data/collection/participants \
  --attempt-id <attempt-id> \
  --output-root ./evidence-bundles \
  --legacy-task-protocol-bindings ./approved-bindings.json

# Project B: validate and materialize from only the bundle.
ux-eval validate-bundle --bundle ./evidence-bundles/<bundle-id>
ux-eval materialize \
  --bundle ./evidence-bundles/<bundle-id> \
  --output-root ./cases

# Run Method 3 and normalize its validated result.
ux-eval evaluate --case ./cases/revisions/<case-revision-id>
ux-eval normalize \
  --case ./cases/revisions/<case-revision-id> \
  --findings ./findings.json \
  --output ./assessment.json

# Prepare, but do not execute, remediation.
ux-eval snapshot-source \
  --source ./website-source \
  --output-root ./source-snapshots
ux-eval prepare-remediation \
  --assessment ./assessment.json \
  --problem-id <problem-id> \
  --source-snapshot-id <source-snapshot-id> \
  --output ./request.json
```

The packaged calibration is intentionally `pending`; production Method 3
materialization remains ineligible until the documented real-browser
calibration passes.

## Remaining gates

The following work is deliberately not represented as complete:

1. **Calibration and cutover** — pass real-browser calibration, compare against
   the frozen legacy baseline, and publish an immutable cutover record.
2. **Standalone release** — build and install the wheel outside either
   checkout, verify its resources and contract lock, then publish the split
   repository release.
3. **Isolated execution** — run both Coding Agent and untrusted build/test code
   in a non-root, resource-limited, secret-free, network-controlled sandbox.
4. **Source proof** — reproduce the baseline website artifact from the source
   snapshot before allowing a remediation run.
5. **Candidate import** — verify a closed candidate bundle through the
   Website-owned contract. Agent execution must never publish or merge.
6. **Experiment infrastructure** — freeze equivalent TaskProtocols, allocation,
   missingness rules, objective outcomes, guardrails, and a blinded comparator.
7. **Human study** — obtain separate approval and collect a fresh randomized
   holdout cohort. Discovery recordings and interaction-agent runs are not
   confirmatory evidence.

Only the final gate can support an `improved`, `inconclusive`, or `regressed`
usability conclusion.

## Validation

Before each release:

- run all Python, Node, TypeScript, build, lint, and service integration tests;
- build the evaluator wheel and install it into an unrelated directory;
- run package tests without the UI Rater source path;
- verify producer and vendored schema digests match;
- confirm Collection still exports when the evaluator is absent;
- confirm no evaluator code can read Collection/HF internal layouts;
- rerun an independent architecture and overengineering review.

## Completion criteria

The extraction is complete when the standalone wheel is authoritative and UI
Rater retains only Collection-owned exporters and contracts.

The remediation engineering flow is complete when an approved finding can
produce a source-attested candidate bundle in the isolated runner without
mutating or publishing the baseline.

A usability-improvement claim is complete only after the locked, blinded,
fresh-participant comparison passes all predeclared outcomes and guardrails.
