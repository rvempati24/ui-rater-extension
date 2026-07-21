# LLM and Coding-Agent Input v2

## Decision

`uxBench/ux-task-trace` is the portable baseline dataset, but it is not passed directly to a model as one large prompt. An input materializer selects one accepted attempt, resolves its exact website source from run provenance, validates the evidence, and creates a bounded sandbox for either the existing API analyzer or a repository-aware coding agent.

```text
HF participant dataset or local participant folders
                |
        select accepted attempt
                |
      validate IDs + checksums
                |
   resolve exact website revision
                |
       materialize case sandbox
          /                 \
 evidence-only         source-explore
```

This makes local and downloaded cases use the same contract while keeping model prompts lean.

## Two analysis conditions

### Evidence-only baseline

This condition sends compact case metadata, the full attempt trace, and selected key screenshots through Codex. Its temporary workspace does not contain `website/`, so source access is structurally impossible rather than discouraged only by the prompt.

Use this condition first to establish latency, cost, and UX-problem quality baselines.

### Source-explore condition

Codex receives a read-only filesystem sandbox containing the selected attempt evidence and the website application source. The task is diagnosis only: it reports UX problems encountered during the specific task and does not propose or apply code changes.

Use this condition to test whether source exploration improves evidence-grounded UX diagnosis. The agent is not given Hugging Face credentials or unrestricted network access.

## Case selection

The materializer accepts one of:

- local `attempt_id` resolved through the participant indexes/folder tree;
- HF dataset revision plus `attempt_id` resolved through `index/attempts.jsonl`;
- an explicit local attempt directory for migration/debugging.

Only `status: accepted` is eligible by default. `--include-invalidated` is an explicit audit-only option. Selection by participant/run/task is translated to one immutable attempt ID before files are copied.

## Exact source resolution

The materializer reads website provenance from the attempt's parent `run.json`. It never guesses source from a display name.

Resolution order:

1. Reuse a verified local cache matching repository, revision/path, and commit SHA.
2. Download the exact website run from `uxBench/website-generation` using `repo_id`, `revision`, and `path_in_repo`.
3. For a configured Git source, check out the recorded commit SHA into a disposable worktree.
4. Fail with `source_unavailable` if exact provenance cannot be resolved.

The resolved source is checked against recorded metadata/checksums when available. A mismatch is an error, not a warning followed by best-effort analysis.

## Sandbox layout

```text
<sandbox>/
  case.json
  analysis-case.json
  evidence-manifest.json
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

`website/` and `evidence/` are read-only. Agent instruction/config files such as `AGENTS.md`, `.codex/`, `.claude/`, and OpenCode configs are excluded while materializing application source. Dependency caches, `.git` credentials, environment secrets, HF tokens, and unrelated local files are not exposed to the analysis run.

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
  "evidence_manifest": "evidence-manifest.json"
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

Allowed tools are filesystem read, filename/text search, and optional non-mutating source inspection commands. Package installation, network calls, commits, uploads, and source writes are disabled for this analysis task.

## Output linkage

Each condition's immutable `output/runs/<analysis-run-id>/<condition>/run-metadata.json` records:

- Codex harness and version;
- model name;
- prompt/contract version;
- dataset repo, revision, and HF commit SHA;
- input attempt ID and artifact checksums;
- resolved source commit SHA;
- start/end time, exit status, and process output needed for failure diagnosis.

Validated outputs can be copied back under the attempt's `analysis/<analysis-id>/` directory and included in a later HF synchronization. Original evidence is never modified by analysis.

## CLI design

Implemented commands:

```bash
# Materialize from local participant storage.
python scripts/materialize_case.py --attempt-id att_01 --output .cases/att_01

# Materialize from an exact HF dataset revision.
python scripts/materialize_case.py \
  --hf-repo uxBench/ux-task-trace \
  --hf-revision participant-v2 \
  --attempt-id att_01 \
  --output .cases/att_01

# Run both Codex comparison conditions.
python scripts/run_agent_analysis.py \
  --case .cases/att_01 \
  --condition both --model gpt-5.4
```

The runner requires an already authenticated Codex CLI. It reuses saved Codex authentication directly and does not require an API proxy.

## Implementation layers

1. **Identity/provenance (implemented):** participant/run/assignment/attempt IDs and frozen website provenance provide stable join keys.
2. **Participant HF exporter (implemented):** accepted/audit export, checksums, indexes, revision selection, and sync state establish the dataset baseline.
3. **Materializer (implemented):** the same sandbox can be built from local storage or an exact HF commit.
4. **Compact API input v2 (implemented):** the existing multimodal input now carries stable IDs and website provenance.
5. **Codex comparison harness (implemented):** evidence-only and source-explore runs share the same model, prompt contract, screenshot set, schema, and read-only Codex sandbox.
6. **Output synchronization (future):** agent output is local today; attaching validated derived analysis to HF is not automatic.

Do not begin with a general-purpose agent runner. The first three steps establish stable evidence and source resolution, which both API and coding-agent experiments require.

## Validation criteria

- The same accepted attempt produces equivalent `case.json` from local storage and HF.
- Every evidence path and checksum is valid before agent launch.
- The website source matches the exact recorded provenance.
- The agent cannot write outside `output/` or access credentials/network by default.
- Every finding cites real event or attached-screenshot evidence IDs.
- Re-materializing the same dataset revision and attempt is deterministic.
- Analysis output records both the evidence dataset commit and website source commit.
