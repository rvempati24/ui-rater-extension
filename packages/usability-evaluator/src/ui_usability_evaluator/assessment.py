"""Normalize evidence-backed Method 3 findings into UXAssessment v1."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .evidence import (
    atomic_write_json, javascript_canonical_json, sha256_file,
    validate_case_integrity,
)
from .method3 import validate_findings


def _digest(value: object) -> str:
    encoded = javascript_canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def normalize(case_dir: Path, findings_file: Path, output_file: Path) -> dict:
    case_dir = case_dir.resolve()
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    validate_case_integrity(case_dir, case)
    findings = json.loads(findings_file.read_text(encoding="utf-8"))
    validate_findings(case_dir, case, findings)
    raw_findings_digest = f"sha256:{sha256_file(findings_file)}"
    assessment_identity = {
        "schemaVersion": "ux-assessment/v1",
        "attemptId": case["attempt_id"],
        "caseRevisionId": case["case_revision_id"],
        "bundleId": case["dataset"]["bundle_id"],
        "method": "method-3",
        "rawFindingsSha256": raw_findings_digest,
    }
    assessment_id = (
        f"uxa_{_digest(assessment_identity).removeprefix('sha256:')[:32]}"
    )
    normalized = []
    for index, item in enumerate(findings["findings"]):
        evidence = item["evidence"]
        record = {
            "severity": item["severity"],
            "confidence": item["confidence"],
            "title": item["title"],
            "uxProblem": item["ux_problem"],
            "observation": item["observation"],
            "taskImpact": item["task_impact"],
            "evidence": {
                "eventSeq": sorted(evidence.get("event_seq") or []),
                "snapshotIds": sorted(evidence.get("snapshot_ids") or []),
            },
        }
        problem_identity = {
            "assessmentId": assessment_id,
            "findingIndex": index,
            "finding": record,
        }
        normalized.append({
            "problemId": (
                f"uxp_{_digest(problem_identity).removeprefix('sha256:')[:24]}"
            ),
            **record,
        })
    problem_ids = [item["problemId"] for item in normalized]
    if len(problem_ids) != len(set(problem_ids)):
        raise ValueError("Raw findings contain duplicate UX problems")
    assessment_body = {
        "schemaVersion": "ux-assessment/v1",
        "assessmentId": assessment_id,
        "attemptId": case["attempt_id"],
        "caseRevisionId": case["case_revision_id"],
        "bundleId": case["dataset"]["bundle_id"],
        "method": "method-3",
        "problems": normalized,
        "lineage": {
            "caseIntegrity": case["integrity_manifest"],
            "rawFindingsSha256": raw_findings_digest,
        },
    }
    atomic_write_json(output_file, assessment_body)
    return assessment_body
