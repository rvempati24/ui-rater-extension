#!/usr/bin/env python3
"""Evaluator-owned evidence and immutable analysis-run helpers."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import uuid
from contextlib import contextmanager
from decimal import Decimal
from typing import Any


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


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def javascript_canonical_json(value: Any) -> str:
    """Match JSON.stringify over recursively key-sorted JSON values."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Canonical JSON cannot contain non-finite numbers")
        if value == 0:
            return "0"
        magnitude = abs(value)
        if 1e-6 <= magnitude < 1e21:
            if value.is_integer():
                return str(int(value))
            return format(Decimal(repr(value)), "f").rstrip("0").rstrip(".")
        mantissa, exponent = repr(value).lower().split("e")
        mantissa = mantissa.rstrip("0").rstrip(".")
        exponent_value = int(exponent)
        sign = "+" if exponent_value >= 0 else ""
        return f"{mantissa}e{sign}{exponent_value}"
    if isinstance(value, list):
        return "[" + ",".join(javascript_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("Canonical JSON object keys must be strings")
        return "{" + ",".join(
            f"{javascript_canonical_json(key)}:{javascript_canonical_json(value[key])}"
            for key in sorted(value)
        ) + "}"
    raise ValueError("Unsupported canonical JSON value")


def javascript_canonical_digest(value: Any) -> tuple[str, str]:
    canonical = javascript_canonical_json(value)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"sha256:{digest}", canonical


def path_uses_symlink(root: Path, path: Path) -> bool:
    """Return true when any component below root is a symlink."""
    try:
        relative = path.relative_to(root)
    except ValueError:
        return True
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


@contextmanager
def exclusive_file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def tree_digest(root: Path) -> str:
    if root.is_symlink():
        raise ValueError(f"Symlinks are not allowed in an integrity tree: {root}")
    digest = hashlib.sha256()
    for file in sorted(path for path in root.rglob("*") if path.is_file()):
        if file.is_symlink():
            raise ValueError(f"Symlinks are not allowed in an integrity tree: {file}")
        digest.update(file.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(str(file.stat().st_size).encode("ascii") + b"\0")
        with file.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


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
    manifest = {
        "schema_version": 1,
        "attempt_id": case.get("attempt_id"),
        "case": file_record(case_dir, analysis_case, "analysis-case"),
        "trace": file_record(case_dir, trace, "trace"),
        "snapshots": snapshots,
    }
    manifest["root_sha256"] = canonical_sha256(manifest)
    return manifest


def write_evidence_manifest(case_dir: Path, case: dict) -> Path:
    target = case_dir / "evidence-manifest.json"
    atomic_write_json(target, build_evidence_manifest(case_dir, case))
    return target


def load_evidence_manifest(case_dir: Path, case: dict, verify: bool = True) -> dict:
    value = case.get("evidence_manifest", "evidence-manifest.json")
    path = case_dir / value
    if path_uses_symlink(case_dir, path) or not path.is_file():
        raise FileNotFoundError(
            "Case has no safe canonical evidence manifest; rematerialize it with materialize-case"
        )
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") not in {1, 2} or manifest.get("attempt_id") != case.get("attempt_id"):
        raise ValueError("Evidence manifest does not match case.json")
    if verify:
        expected_root = manifest.get("root_sha256")
        root_input = {key: value for key, value in manifest.items() if key != "root_sha256"}
        if not expected_root:
            raise ValueError("Evidence manifest has no root hash")
        if canonical_sha256(root_input) != expected_root:
            raise ValueError("Evidence manifest root hash mismatch")
        if manifest["schema_version"] == 1:
            records = [manifest["case"], manifest["trace"]]
            for snapshot in manifest.get("snapshots", []):
                records.extend([snapshot["metadata"], snapshot["image"]])
        else:
            records = [manifest[key] for key in (
                "analysis_case", "trace", "recording", "frame_selection", "model_input_sequence"
            )]
            for group in ("snapshots", "auxiliary_live_snapshots"):
                for snapshot in manifest.get(group, []):
                    records.extend([snapshot["metadata"], snapshot["image"]])
        seen_paths = set()
        for record in records:
            if record.get("path") in seen_paths:
                raise ValueError("Evidence manifest contains duplicate paths")
            seen_paths.add(record.get("path"))
            raw_candidate = case_dir / record["path"]
            candidate = raw_candidate.resolve()
            if case_dir != candidate and case_dir not in candidate.parents:
                raise ValueError("Evidence manifest path escapes the case directory")
            if (path_uses_symlink(case_dir, raw_candidate)
                    or not candidate.is_file()
                    or candidate.stat().st_size != record.get("bytes")
                    or sha256_file(candidate) != record["sha256"]):
                raise ValueError(f"Evidence manifest hash mismatch: {record['path']}")
        if manifest["schema_version"] == 2:
            sequence = json.loads((case_dir / manifest["model_input_sequence"]["path"]).read_text(encoding="utf-8"))
            sequence_ids = {
                item["snapshot_id"] for segment in sequence.get("segments", [])
                for item in segment.get("items", [])
            }
            snapshot_ids = {item["snapshot_id"] for item in manifest.get("snapshots", [])}
            if sequence_ids != snapshot_ids or len(snapshot_ids) != len(manifest.get("snapshots", [])):
                raise ValueError("Evidence manifest snapshot graph is not closed")
    return manifest


def new_analysis_run_id() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"analysis_{timestamp}_{uuid.uuid4().hex[:8]}"


def update_latest(output_root: Path, harness: str, analysis_run_id: str) -> None:
    path = output_root / "latest-success.json"
    with exclusive_file_lock(output_root / ".latest-success.lock"):
        current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {
            "schema_version": 2, "runs": {},
        }
        current["runs"][harness] = analysis_run_id
        current["updated_at"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(path, current)


def resolve_case_dir(value: Path) -> Path:
    root = value.resolve()
    pointer = root / "latest-case.json"
    if not pointer.is_file():
        if (root / "case.json").is_file():
            return root
        raise FileNotFoundError(f"No case.json or latest-case.json under {root}")
    if pointer.is_symlink():
        raise ValueError("latest-case.json may not be a symlink")
    data = json.loads(pointer.read_text(encoding="utf-8"))
    relative = Path(str(data.get("path", "")))
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("latest-case.json contains an unsafe path")
    target = (root / relative).resolve()
    if root not in target.parents or not (target / "case.json").is_file():
        raise ValueError("latest-case.json does not resolve to a case revision")
    return target


def validate_schema(instance: Any, schema: dict, location: str = "$") -> None:
    expected = schema.get("type")
    type_checks = {
        "object": lambda value: isinstance(value, dict),
        "array": lambda value: isinstance(value, list),
        "string": lambda value: isinstance(value, str),
        "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
        "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": lambda value: isinstance(value, bool),
        "null": lambda value: value is None,
    }
    if expected and (expected not in type_checks or not type_checks[expected](instance)):
        raise ValueError(f"{location} must have type {expected}")
    if "enum" in schema and instance not in schema["enum"]:
        raise ValueError(f"{location} is not one of the allowed values")
    if expected == "object":
        for key in schema.get("required", []):
            if key not in instance:
                raise ValueError(f"{location}.{key} is required")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extras = set(instance) - set(properties)
            if extras:
                raise ValueError(f"{location} has unexpected properties: {sorted(extras)}")
        for key, value in instance.items():
            if key in properties:
                validate_schema(value, properties[key], f"{location}.{key}")
    elif expected == "array":
        if len(instance) < schema.get("minItems", 0):
            raise ValueError(f"{location} has too few items")
        for index, value in enumerate(instance):
            validate_schema(value, schema.get("items", {}), f"{location}[{index}]")
    elif expected == "string" and len(instance) < schema.get("minLength", 0):
        raise ValueError(f"{location} is too short")


def validate_case_integrity(case_dir: Path, case: dict) -> dict:
    value = case.get("integrity_manifest")
    if not value:
        return {"verified": False, "reason": "legacy-case-without-integrity-manifest"}
    raw_manifest_path = case_dir / value
    manifest_path = raw_manifest_path.resolve()
    if case_dir != manifest_path and case_dir not in manifest_path.parents:
        raise ValueError("Case integrity manifest escapes the case directory")
    if path_uses_symlink(case_dir, raw_manifest_path):
        raise ValueError("Case integrity manifest may not use a symlink")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("schema_version") != 1
            or manifest.get("case_revision_id") != case.get("case_revision_id")):
        raise ValueError("Case integrity manifest does not match case.json")
    expected_paths = set()
    for record in manifest.get("files", []):
        relative = Path(str(record.get("path", "")))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Case integrity manifest contains an unsafe path")
        expected_paths.add(relative.as_posix())
        raw_path = case_dir / record["path"]
        path = raw_path.resolve()
        if (case_dir not in path.parents or path_uses_symlink(case_dir, raw_path)
                or not path.is_file()):
            raise ValueError(f"Unsafe or missing case file: {record['path']}")
        if path.stat().st_size != record["bytes"] or sha256_file(path) != record["sha256"]:
            raise ValueError(f"Case integrity mismatch: {record['path']}")
    root = {key: value for key, value in manifest.items() if key != "root_sha256"}
    if canonical_sha256(root) != manifest.get("root_sha256"):
        raise ValueError("Case integrity root hash mismatch")
    actual_paths = set()
    for path in case_dir.rglob("*"):
        relative = path.relative_to(case_dir).as_posix()
        if relative.startswith("output/"):
            continue
        if path.is_symlink():
            raise ValueError(f"Case contains a symlink: {path.relative_to(case_dir)}")
        if relative == str(value):
            continue
        if not path.is_file():
            continue
        actual_paths.add(relative)
    if actual_paths != expected_paths:
        missing = sorted(expected_paths - actual_paths)
        unexpected = sorted(actual_paths - expected_paths)
        raise ValueError(
            f"Case integrity file set mismatch: missing={missing}, unexpected={unexpected}"
        )
    return {"verified": True, "root_sha256": manifest["root_sha256"]}
