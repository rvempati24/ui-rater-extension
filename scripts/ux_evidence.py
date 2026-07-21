#!/usr/bin/env python3
"""Canonical evidence and immutable analysis-run helpers."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(case_dir: Path, path: Path, kind: str) -> dict:
    return {
        "path": path.relative_to(case_dir).as_posix(),
        "kind": kind,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def build_evidence_manifest(case_dir: Path, case: dict) -> dict:
    analysis_case = case_dir / case["analysis_case"]
    if not analysis_case.is_file():
        raise FileNotFoundError(f"Analysis case is missing: {analysis_case}")
    trace = case_dir / case["evidence"]["trace"]
    if not trace.is_file():
        raise FileNotFoundError(f"Case trace is missing: {trace}")
    snapshots = []
    for image_value in case["evidence"].get("snapshots", []):
        image = case_dir / image_value
        metadata = image.with_suffix(".json")
        if not image.is_file() or not metadata.is_file():
            raise FileNotFoundError(f"Snapshot pair is incomplete: {image}")
        detail = json.loads(metadata.read_text(encoding="utf-8"))
        snapshots.append({
            "snapshot_id": image.stem,
            "ts": detail.get("ts"),
            "reason": detail.get("reason"),
            "action_id": detail.get("action_id"),
            "phase": detail.get("phase"),
            "event_kind": detail.get("event_kind"),
            "requested_ts": detail.get("requested_ts"),
            "capture_started_ts": detail.get("capture_started_ts"),
            "captured_ts": detail.get("ts"),
            "capture_latency_ms": detail.get("capture_latency_ms"),
            "timing_guarantee": detail.get("timing_guarantee"),
            "viewport": detail.get("viewport"),
            "image": file_record(case_dir, image, "image"),
            "metadata": file_record(case_dir, metadata, "snapshot-metadata"),
        })
    return {
        "schema_version": 1,
        "attempt_id": case.get("attempt_id"),
        "case": file_record(case_dir, analysis_case, "analysis-case"),
        "trace": file_record(case_dir, trace, "trace"),
        "snapshots": snapshots,
    }


def write_evidence_manifest(case_dir: Path, case: dict) -> Path:
    target = case_dir / "evidence-manifest.json"
    target.write_text(
        json.dumps(build_evidence_manifest(case_dir, case), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return target


def load_evidence_manifest(case_dir: Path, case: dict, verify: bool = True) -> dict:
    value = case.get("evidence_manifest", "evidence-manifest.json")
    path = case_dir / value
    if not path.is_file():
        raise FileNotFoundError(
            "Case has no canonical evidence manifest; rematerialize it with materialize-case"
        )
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or manifest.get("attempt_id") != case.get("attempt_id"):
        raise ValueError("Evidence manifest does not match case.json")
    if verify:
        records = [manifest["case"], manifest["trace"]]
        for snapshot in manifest.get("snapshots", []):
            records.extend([snapshot["metadata"], snapshot["image"]])
        for record in records:
            candidate = (case_dir / record["path"]).resolve()
            if case_dir != candidate and case_dir not in candidate.parents:
                raise ValueError("Evidence manifest path escapes the case directory")
            if not candidate.is_file() or sha256_file(candidate) != record["sha256"]:
                raise ValueError(f"Evidence manifest hash mismatch: {record['path']}")
    return manifest


def new_analysis_run_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"analysis_{timestamp}_{uuid.uuid4().hex[:8]}"


def update_latest(output_root: Path, harness: str, analysis_run_id: str) -> None:
    path = output_root / "latest.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {
        "schema_version": 1, "runs": {},
    }
    current["runs"][harness] = analysis_run_id
    current["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(current, indent=2), encoding="utf-8")
