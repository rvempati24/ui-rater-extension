# Versioned LLM and agent input contract

## Decision

`uxBench/ux-task-trace@participant-v3-integrity` is the portable evidence baseline. The materializer pins a dataset commit, verifies the detached attempt manifest, resolves exact website source from run provenance, and publishes a content-addressed case revision. The retired server analyzer is not part of this contract.

```text
HF participant dataset or local participant folders
                |
        select accepted attempt
                |
      validate IDs + checksums
                |
   resolve exact website revision
                |
   materialize immutable case revision
          /                 \
 evidence-only         source-explore
```

This makes local and downloaded cases use the same contract while keeping model prompts lean.

## Two analysis conditions

### Evidence-only baseline

This condition gives Codex compact case metadata, the full attempt trace, and the complete screenshot catalog. Images remain available in the temporary workspace and Codex selects which ones to inspect; they are not all attached to the initial prompt. The workspace does not contain `website/`.

Use this condition first to establish latency, cost, and UX-problem quality baselines.

### Source-explore condition

Codex receives a read-only filesystem sandbox containing the selected attempt evidence and the website application source. The task is diagnosis only: it reports UX problems encountered during the specific task and does not propose or apply code changes.

Use this condition to test whether source exploration improves evidence-grounded UX diagnosis. The agent is not given Hugging Face credentials or unrestricted network access.

## Case selection

The materializer accepts one of:

- local `attempt_id` resolved through the participant indexes/folder tree;
- HF dataset revision plus `attempt_id` resolved through `index/attempts.jsonl`;
- a local canonical participant tree plus `attempt_id`.

Only `status: accepted` is eligible by default. `--audit` explicitly permits terminal failed or invalidated attempts for diagnosis, but those runs are not primary-comparison eligible.

## Exact source resolution

The materializer reads website provenance from the attempt's parent `run.json`. It never guesses source from a display name.

Resolution order:

1. Use an explicitly supplied local source directory and verify its `ui-rater-website.json` commit when present.
2. Reuse the run's recorded local `source_dir` with the same verification.
3. Otherwise download `repo_id/path_in_repo` at the recorded commit or revision.
4. Fail if source cannot be resolved.

The resolved source is checked against recorded metadata/checksums when available. A mismatch is an error, not a warning followed by best-effort analysis.

## Sandbox layout

```text
<case-root>/revisions/<case_revision_id>/
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
    snapshots/
  website/
    ... application source from the exact revision ...
  contract/
    instructions.md
    finding.schema.json
  output/runs/<analysis-run-id>/
    evidence-only/
      findings.json
      run-metadata.json
    source-explore/
      findings.json
      run-metadata.json
    comparison.json
```

`website/` and `evidence/` are made read-only. Agent instruction/config files such as `AGENTS.md`, `.codex/`, `.claude/`, and OpenCode configs are excluded while materializing source. Dependency caches, `.git`, HF tokens, and analysis outputs are not copied into the workspace. Codex's `read-only` sandbox prevents writes but is not a VM/filesystem namespace, so Method 1 must run on the dedicated mocked-data worker; Method 3 has no tools and is the stronger isolation baseline.

Video can be omitted with `--no-video` for agents that cannot inspect it or when download cost matters. Trace and referenced screenshots are required.

## `case.json` contract

```json
{
  "schema_version": "2.0",
  "case_id": "att_01...",
  "participant_id": "P004",
  "run_id": "run_01...",
  "assignment_id": "asg_01...",
  "attempt_id": "att_01...",
  "session_id": "session_01...",
  "task": {
    "position": 3,
    "prompt": "Open the reviews of a recipe with beef sirloin",
    "start_url": "..."
  },
  "website": {
    "repo_id": "uxBench/website-generation",
    "revision": "prompt-userflow-regen-20260624",
    "commit_sha": "...",
    "path_in_repo": "model/site/run-id"
  },
  "evidence": {
    "trace": "evidence/trace.json",
    "snapshots": ["evidence/snapshots/s0001.jpg"],
    "recording": "evidence/recording.webm"
  },
  "source_root": "website",
  "output_schema": "contract/finding.schema.json",
  "evidence_manifest": "evidence-manifest.json",
  "integrity_manifest": "case-integrity.json"
}
```

Paths are sandbox-relative. Prompts do not contain host filesystem paths.

## Agent instructions and boundaries

The agent instruction should stay short:

1. Identify usability problems supported by the supplied attempt evidence.
2. Describe the observed UX problem and its task impact.
3. Cite existing event sequence numbers and snapshot IDs.
4. Explain how each observed problem impeded the specific task.
5. Do not perform a generic heuristic audit or propose code/implementation changes.
6. In source-explore mode, use source only to clarify observed behavior; do not report hypothetical source-only issues.

Method 1 allows filesystem reads, search, and image viewing inside a read-only Codex run; web search and inherited subprocess environment are disabled. Method 3 has no tools. Package installation, commits, uploads, and source writes are outside the analysis contract.

## Output linkage

Each condition's immutable `output/runs/<analysis-run-id>/<condition>/run-metadata.json` records:

- Codex harness and version;
- model name;
- prompt/contract version;
- dataset repo, revision, and HF commit SHA;
- input attempt ID and artifact checksums;
- resolved source commit SHA;
- start/end time, exit status, and process output needed for failure diagnosis.

Validated outputs remain local under the case revision. Automatic synchronization into canonical attempt evidence or HF is intentionally not implemented.

## CLI design

Implemented commands:

```bash
# Materialize from local participant storage.
python scripts/materialize_case.py --attempt-id att_01 --output .cases/att_01

# Materialize from an exact HF dataset revision.
python scripts/materialize_case.py \
  --hf-repo uxBench/ux-task-trace \
  --hf-revision participant-v3-integrity \
  --attempt-id att_01 \
  --output .cases/att_01

# Run the primary Method 1/3 experiment.
python scripts/run_ux_experiment.py \
  --case .cases/att_01 --methods 1,3 \
  --model gpt-5.6-sol --reasoning-effort medium
```

The runner requires an already authenticated Codex CLI. It reuses saved Codex authentication directly and does not require an API proxy.

## Implementation layers

1. **Identity/provenance (implemented):** participant/run/assignment/attempt IDs and frozen website provenance provide stable join keys.
2. **Participant HF exporter (implemented):** accepted/audit export, checksums, indexes, revision selection, and sync state establish the dataset baseline.
3. **Materializer (implemented):** the same sandbox can be built from local storage or an exact HF commit.
4. **Versioned case (implemented):** exact context, source, contract, evidence, and file-set hashes determine a revision ID; older revisions are retained.
5. **Controlled harness (implemented):** Methods 1/3 are primary and Methods 2/4 are ablations under one experiment manifest.
6. **Output synchronization (out of scope):** analysis remains derived local data and never mutates canonical evidence.

Do not begin with a general-purpose agent runner. The first three steps establish stable evidence and source resolution, which both API and coding-agent experiments require.

## Validation criteria

- A verified local export and its pinned HF copy produce the same artifact root and case revision.
- Every evidence path and checksum is valid before agent launch.
- The website source matches the exact recorded provenance.
- Method 1 cannot write through Codex tools and Method 3 has no tools; both run without web access.
- Every finding cites real event or attached-screenshot evidence IDs.
- Re-materializing the same inputs resolves the same immutable revision without deleting prior output.
- Analysis output records both the evidence dataset commit and website source commit.
