# ADR 0002: Extract the usability evaluator

Status: Accepted

## Context

The collection system currently contains both participant evidence capture and
Method 3 analysis scripts. Analysis must be independently releasable, while
participant collection must continue when no evaluator is installed.

## Decision

`ui-rater-extension` owns Website, Manager, Collection, the extension, and two
published artifacts:

- `EvidenceBundle v1` for one terminal attempt;
- a future `CandidateBuildBundle v1` as the only evaluator-to-Website import
  format.

`ui-usability-evaluator` owns frame derivation, Method 3, assessment
normalization, and remediation requests. It will own isolated agent execution
and comparison after their explicit gates pass.

The evaluator first lives at `packages/usability-evaluator/`. It may read only
published bundles and package resources. After parity and calibration it is
split to `Oscar-Ge/ui-usability-evaluator`; the original repository keeps no
LLM prompt, provider credential lookup, or frame-analysis implementation.

Each external contract has one publisher. Consumers pin the schema version and
digest; repositories never import one another's implementation code or share a
writable data root.

## Consequences

- Collection exports purpose-specific DTOs instead of its internal files.
- Historical attempts require an explicit task-protocol binding.
- Source snapshots and requests may be prepared now. Execution remains
  ineligible until a clean baseline build reproduces the Website artifact seen
  by participants and the isolated runner gate passes.
- Coding Agent output creates a new candidate artifact and cannot modify or
  publish the baseline.
- Usability claims require fresh randomized holdout evidence; agent smoke tests
  and discovery attempts are not confirmatory evidence.
