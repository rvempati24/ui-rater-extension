# UX analysis module

This folder is the complete LLM boundary for the UI Rater baseline.

- `input.ts` prepares the trace, screenshot metadata, and inspectable `analysis/input.json`.
- `source-context.ts` reads a server-configured website source root with path and size limits.
- `prompt.ts` owns the lean source-aware prompt and structured-output schema.
- `openai.ts` is the only file that makes the model request.
- `validate.ts` rejects unknown event, snapshot, and source references.
- `report.ts` renders the human-readable report.
- `index.ts` orchestrates preparation and analysis for the API route.

Set `UI_RATER_WEBSITE_SOURCE_DIR` to the synthetic website repository to include source. The HTTP API never accepts a source path from the request.
