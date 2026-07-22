# UX analysis harness decision

## Worker scope

This machine is an analysis worker. It downloads one immutable UX task attempt and the matching mocked website source, then reports UX problems the participant encountered while completing that attempt's specific task. It does not collect new traces, modify websites, propose code changes, or aggregate across attempts.

## Decision

Use Codex CLI for Method 1 and the local CLIProxyAPI Responses endpoint for Method 3. Methods 1 and 3 are the primary comparison requested for the study; source access and trace-only input remain optional ablations.

| Harness | Strengths for this experiment | Main confounders | Decision |
| --- | --- | --- | --- |
| Codex CLI | Native model/harness pairing, image inputs, read-only non-interactive sandbox, JSON Schema final output, ephemeral runs | Requires an existing Codex login | Selected |
| Direct Responses via CLIProxyAPI | Every JSON document and screenshot can be supplied in one multimodal request with strict JSON output; no harness/tool-loop confounder | Large context, no selective exploration, and no source access | Selected as one-shot ablation |
| OpenCode | Custom Responses providers, file attachments, granular tool permissions | Structured output is not enforced by an equivalent CLI schema flag; isolation depends more on OpenCode permissions and config precedence | Not implemented |
| Claude Code | Mature print mode and tool allow/deny lists; supports LLM gateways | Anthropic harness and Messages protocol must be translated to a Codex model, adding a system-prompt/tool-protocol confounder | Not implemented |

Primary references:

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex custom model providers](https://developers.openai.com/codex/config-advanced)
- [OpenCode providers](https://dev.opencode.ai/docs/providers)
- [OpenCode permissions](https://dev.opencode.ai/docs/permissions/)
- [Claude Code LLM gateways](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)

## Controlled comparison

`scripts/run-ux-experiment.sh` pins the attempt revision, model, reasoning effort, output schema, repetition, and experiment ID across methods. Defaults are `gpt-5.6-sol`, `medium`, and Methods `1,3`. Method 1 exposes the complete screenshot catalog but lets Codex select what to inspect. Method 3 pre-attaches the complete canonical image set. No primary run uses `--max-screenshots`; Method 3 fails as ineligible before transport if its complete encoded request exceeds the input budget.

Screenshot metadata distinguishes requested time, capture start, and capture completion. `phase: before` means best-effort rather than a guaranteed pre-action frame; analyzers are instructed to compare `captured_ts` with the linked trace event before drawing a before/after conclusion. Action IDs include a session prefix and UUID so pairs remain unambiguous across full-page navigations.

### Method 1: `evidence-only`

Codex receives a temporary workspace containing compact case metadata, `trace.json`, the complete screenshot catalog/metadata, and copies of every canonical screenshot. Images are not attached to the initial prompt; Codex chooses which images to open with its image-viewing tool. The website source is absent. A finding that cites a screenshot absent from the harness's inspected-image log is rejected.

### Method 2: `source-explore`

Codex receives a temporary workspace containing the same trace and complete screenshot catalog plus a copy of the read-only `website/` tree. Prior condition outputs are absent, preventing accidental cross-condition result leakage. It may search source to clarify UI structure or state that appears in the evidence, but may not report source-only hypothetical problems or output source paths.

### Method 3: `direct-one-shot`

One Responses API call receives `analysis-case.json`, the canonical evidence manifest, the complete trace, every screenshot metadata document, and every listed screenshot at high image detail. It receives no website source or recording and has no tools, shell, web access, or multi-turn agent loop. The request is sent to a loopback-only CLIProxyAPI endpoint with `store: false` and strict JSON Schema output.

### Method 4: `direct-trace-only`

One Responses API call receives only `analysis-case.json` and the complete `trace.json`. It receives no screenshots, other evidence metadata, website source, recording, or tools. The prompt forbids unsupported visual claims and snapshot citations; output validation rejects any finding that cites a snapshot. This condition measures what the same model can infer from behavioral event data alone.

Each invocation receives a unique analysis run ID and writes immutable artifacts:

```text
output/runs/<analysis-run-id>/<condition>/findings.json
output/runs/<analysis-run-id>/<condition>/run-metadata.json
```

The one-shot condition additionally writes `response.json` and `input-manifest.json` beside its findings. A Codex run writes `comparison.json`; the orchestrator writes `output/experiments/<experiment-id>/experiment.json`. Only a validated success updates `output/latest-success.json` or the experiment's `latest-success.json`. Human comparison should score task relevance, evidence grounding, specificity, unsupported claims, and useful unique findings. The runner does not ask one model condition to judge the other.

## Security and reproducibility

- `codex exec` uses `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `--sandbox read-only`.
- Agent instruction/config files are excluded from the materialized website, the UX contract is supplied as the task prompt, and Codex web search is disabled.
- Codex reuses its existing saved authentication; model-generated subprocesses inherit no environment variables.
- Hugging Face tokens and unrelated user environment variables are not passed to Codex.
- Evidence and website digests are checked before and after each run.
- Detached artifact, case-integrity, and evidence manifests fix the exact file sets, byte counts, and hashes consumed by both primary methods.
- Findings are rejected when they cite unknown event sequence numbers or snapshot IDs.
- Direct analysis accepts only a loopback HTTP endpoint, reads its proxy key from a local ignored file, exposes no tools, and records hashes for every transmitted case file.
- The Codex read-only sandbox is not a filesystem namespace or VM. Run Method 1 only on this dedicated mocked-data worker, keep unrelated secrets off the worker, and treat Method 3 as the stronger no-tools isolation baseline.
