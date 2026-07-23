# UI Usability Evaluator

`ui-usability-evaluator` is the offline Method 3 analysis boundary for UI Rater.
It imports a closed EvidenceBundle, derives action-adjacent video frames, sends
the bounded evidence set to an OpenAI-compatible endpoint, validates citations,
and emits a normalized UX assessment.

The package never reads Collection, Website, or Manager storage. Remediation
preparation is deliberately input-only: it selects validated problems and emits
a deterministic coding-agent request, but cannot publish a website or merge code.

Python 3.9+ is required. Materialization also requires `ffmpeg` and `ffprobe`.
Evaluation uses a loopback OpenAI-compatible Responses endpoint.

## Commands

```bash
ux-eval validate-bundle --bundle /path/to/evidence-bundle
ux-eval materialize --bundle /path/to/evidence-bundle --output-root ./cases
ux-eval evaluate --case ./cases/revisions/<case-id> --api-key-file ./key
ux-eval normalize --case ./cases/revisions/<case-id> \
  --findings ./findings.json --output ./assessment.json
ux-eval prepare-remediation --assessment ./assessment.json \
  --problem-id <problem-id> --source-snapshot-id <snapshot-id> \
  --output ./request.json
ux-eval snapshot-source --source ./website --output-root ./sources
```

The request is the handoff to a Coding Agent; this release does not execute
untrusted source or tests. An isolated runner, candidate import, and publication
remain separate gates. A generated patch is engineering output, not evidence
that usability improved; that requires fresh participant evidence and a frozen
comparison.

The bundled calibration is intentionally marked `pending`. A real-browser
calibration artifact is required before production cutover or remediation claims.
