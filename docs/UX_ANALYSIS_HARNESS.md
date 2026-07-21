# UX analysis harness decision

## Worker scope

This machine is an analysis worker. It downloads one immutable UX task attempt and the matching mocked website source, then reports UX problems the participant encountered while completing that attempt's specific task. It does not collect new traces, modify websites, propose code changes, or aggregate across attempts.

## Decision

Use Codex CLI as the repository-aware harness and reuse the machine's existing ChatGPT/Codex login directly. Also implement a deliberately simpler direct Responses baseline through the local CLIProxyAPI so the value of agentic exploration can be measured rather than assumed.

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

The two Codex conditions use the same attempt, model, prompt contract, screenshot cap, output schema, and Codex version. The pinned defaults are `gpt-5.6-sol` with `medium` reasoning effort; both values are recorded in run metadata. A third condition uses the same model, reasoning effort, attempt, and schema, but intentionally changes the harness and input strategy.

### `evidence-only`

Codex receives a temporary workspace containing only compact case metadata and `trace.json`. Key screenshots are attached as image inputs. The website source is absent, not merely hidden by prompt instructions.

### `source-explore`

Codex receives the full materialized case and may search the read-only `website/` tree to clarify UI structure or state that appears in the evidence. It may not report source-only hypothetical problems or output source paths.

### `direct-one-shot`

One Responses API call receives `case.json`, every JSON document under `evidence/`, and every listed screenshot at high image detail. It receives no website source or recording and has no tools, shell, web access, or multi-turn agent loop. The request is sent to a loopback-only CLIProxyAPI endpoint with `store: false` and strict JSON Schema output.

### `direct-trace-only`

One Responses API call receives only `case.json` and the complete `trace.json`. It receives no screenshots, other evidence metadata, website source, recording, or tools. The prompt forbids unsupported visual claims and snapshot citations; output validation rejects any finding that cites a snapshot. This condition measures what the same model can infer from behavioral event data alone.

Each condition writes:

```text
output/<condition>/findings.json
output/<condition>/run-metadata.json
```

The one-shot condition additionally writes `response.json` and `input-manifest.json` under `output/direct-one-shot/`. `output/comparison.json` records whether both Codex runs completed. Human comparison should score task relevance, evidence grounding, specificity, unsupported claims, and useful unique findings. The runner does not ask one model condition to judge the other.

## Security and reproducibility

- `codex exec` uses `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `--sandbox read-only`.
- Agent instruction/config files are excluded from the materialized website, the UX contract is supplied as the task prompt, and Codex web search is disabled.
- Codex reuses its existing saved authentication; model-generated subprocesses inherit no environment variables.
- Hugging Face tokens and unrelated user environment variables are not passed to Codex.
- Evidence and website digests are checked before and after each run.
- Findings are rejected when they cite unknown event sequence numbers or snapshot IDs.
- Direct analysis accepts only a loopback HTTP endpoint, reads its proxy key from a local ignored file, exposes no tools, and records hashes for every transmitted case file.
