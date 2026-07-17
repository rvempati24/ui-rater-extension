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
 compact API input      coding-agent tools
```

This makes local and downloaded cases use the same contract while keeping model prompts lean.

## Two analysis modes

### Compact API baseline

The current baseline remains useful for cheap, repeatable evaluation. It sends a compact trace, selected screenshots, and a bounded source excerpt to a multimodal API. Input v2 adds participant/run/assignment/attempt IDs and exact website provenance, but otherwise retains the current evidence-ID output rules.

Use this mode first to establish latency, cost, and recommendation-quality baselines.

### Coding-agent sandbox

OpenCode, Claude Code, or another coding agent receives a filesystem sandbox containing the complete website source plus the selected attempt evidence. It can search and inspect the repository, but the default recommendation task is read-only: it may write only its analysis output and must not edit the website.

Use this mode as the richer comparison condition when source exploration is expected to improve code-grounded recommendations. The agent is not given Hugging Face credentials or unrestricted network access.

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
    ... exact source tree ...
  contract/
    instructions.md
    finding.schema.json
  output/
    findings.json
    report.md
    run-metadata.json
```

`website/` and `evidence/` are read-only. `output/` is the only writable directory. Dependency caches, `.git` credentials, environment secrets, HF tokens, and unrelated local files are not mounted.

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
  "output_schema": "contract/finding.schema.json"
}
```

Paths are sandbox-relative. Prompts do not contain host filesystem paths.

## Agent instructions and boundaries

The agent instruction should stay short:

1. Identify usability problems supported by the supplied attempt evidence.
2. Separate observed behavior from inference.
3. Cite existing event sequence numbers and snapshot IDs.
4. Cite source paths only after inspecting them.
5. Recommend changes; do not modify source or claim that a change was tested.
6. Write the required JSON schema to `output/findings.json`.

Allowed tools are filesystem read, filename/text search, and optional non-mutating source inspection commands. Package installation, network calls, commits, uploads, and source writes are disabled for this analysis task.

## Output linkage

`output/run-metadata.json` records:

- agent adapter and version;
- model name;
- prompt/contract version;
- dataset repo, revision, and HF commit SHA;
- input attempt ID and artifact checksums;
- resolved source commit SHA;
- start/end time, exit status, and token/cost metrics when available.

Validated outputs can be copied back under the attempt's `analysis/<analysis-id>/` directory and included in a later HF synchronization. Original evidence is never modified by analysis.

## CLI design

Illustrative commands for the implementation phase:

```bash
# Materialize from local participant storage.
python scripts/materialize_case.py --attempt-id att_01 --output .cases/att_01

# Materialize from an exact HF dataset revision.
python scripts/materialize_case.py \
  --hf-repo uxBench/ux-task-trace \
  --hf-revision participant-v2 \
  --attempt-id att_01 \
  --output .cases/att_01

# Run a configured read-only agent adapter.
python scripts/run_agent_analysis.py \
  --case .cases/att_01 \
  --adapter opencode
```

These commands are a design contract, not currently implemented commands.

## Recommended implementation order

1. **Identity/provenance:** implement participant/run/assignment/attempt IDs and freeze exact website provenance. Goal: every analysis case has stable join keys.
2. **Participant HF exporter:** publish accepted attempts in the participant-v2 layout with checksums and indexes. Goal: establish the reproducible dataset baseline.
3. **Materializer:** build and validate the same sandbox from either local storage or an exact HF commit. Goal: separate data acquisition from model execution.
4. **Compact API input v2:** generate the current multimodal request from `case.json`. Goal: preserve a cheap baseline using the new dataset contract.
5. **Coding-agent adapter:** add one read-only adapter, preferably OpenCode first if it matches the available CLI proxy. Goal: measure whether repository exploration improves recommendations before supporting multiple agents.
6. **Output synchronization:** validate findings and optionally attach them as a new analysis artifact in HF. Goal: keep derived model output versioned without mutating evidence.

Do not begin with a general-purpose agent runner. The first three steps establish stable evidence and source resolution, which both API and coding-agent experiments require.

## Validation criteria

- The same accepted attempt produces equivalent `case.json` from local storage and HF.
- Every evidence path and checksum is valid before agent launch.
- The website source matches the exact recorded provenance.
- The agent cannot write outside `output/` or access credentials/network by default.
- Every finding cites real evidence IDs; every cited source path exists under `website/`.
- Re-materializing the same dataset revision and attempt is deterministic.
- Analysis output records both the evidence dataset commit and website source commit.
