#!/usr/bin/env python3
"""Export one terminal attempt as a closed, immutable EvidenceBundle v1."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from urllib.parse import urlsplit

try:
    from scripts.collection_json import atomic_write_json
except ModuleNotFoundError:
    from collection_json import atomic_write_json


TERMINAL_STATUSES = {"accepted", "failed", "invalidated"}
PRIVATE_KEYS = {
    "participant_id", "participantId", "run_id", "runId", "assignment_id",
    "assignmentId", "attempt_id", "attemptId", "session_id", "sessionId",
}
PUBLIC_TRACE_FIELDS = {
    "seq", "ts", "kind", "url", "tag", "x", "y", "text", "href",
    "action_id", "scrollX", "scrollY", "inputType", "key", "code",
    "ctrl", "meta", "alt", "shift", "action", "method", "reason",
    "phase", "eventKind", "snapshot_id",
}


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def canonical_bytes(value: object) -> bytes:
    """Canonical RFC-8785 subset used by contract IDs (no floating hash inputs)."""
    def reject_float(item: object) -> None:
        if isinstance(item, float):
            raise ValueError("Content-ID inputs may not contain floating-point values")
        if isinstance(item, list):
            for child in item:
                reject_float(child)
        elif isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise ValueError("Canonical object keys must be strings")
                reject_float(child)

    reject_float(value)
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def canonical_digest(value: object) -> str:
    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def find_attempt(participants_dir: Path, attempt_id: str) -> Path:
    matches = [
        path.parent for path in participants_dir.glob(
            "*/runs/*/tasks/*/attempts/*/attempt.json"
        )
        if load_json(path).get("attempt_id") == attempt_id
    ]
    if len(matches) != 1:
        raise FileNotFoundError(
            f"Expected exactly one attempt {attempt_id}, found {len(matches)}"
        )
    return matches[0]


def hierarchy(attempt_dir: Path) -> tuple[Path, Path, Path]:
    task_dir = attempt_dir.parents[1]
    run_dir = task_dir.parents[1]
    participant_dir = run_dir.parents[1]
    return task_dir, run_dir, participant_dir


def safe_url_path(value: object) -> str:
    text = str(value or "/")
    parsed = urlsplit(text)
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = f"/{path}"
    return path


def protocol_identity(protocol: dict) -> tuple[str, str]:
    semantic = {
        "schemaVersion": "task-protocol/v1",
        "prompt": str(protocol.get("prompt") or "").strip(),
        "startPath": safe_url_path(protocol.get("startPath") or "/"),
        "timeoutMs": protocol.get("timeoutMs"),
        "successOracle": protocol.get("successOracle"),
    }
    if (
        not semantic["prompt"]
        or not isinstance(semantic["timeoutMs"], int)
        or semantic["timeoutMs"] < 1000
        or not isinstance(semantic["successOracle"], dict)
    ):
        raise ValueError("TaskProtocol is incomplete")
    digest = canonical_digest(semantic)
    protocol_id = f"taskp_{digest.removeprefix('sha256:')[:32]}"
    expected_id = protocol.get("taskProtocolId")
    expected_digest = protocol.get("taskSemanticDigest")
    if expected_id and expected_id != protocol_id:
        raise ValueError("TaskProtocol ID does not match its semantic content")
    if expected_digest and expected_digest != digest:
        raise ValueError("TaskProtocol digest does not match its semantic content")
    return protocol_id, digest


def resolve_protocol(
    run: dict, task: dict, registry_path: Path | None
) -> tuple[dict, str, str]:
    native = task.get("task_protocol")
    if isinstance(native, dict):
        protocol = native
    else:
        if registry_path is None:
            raise ValueError(
                "Historical attempts require --legacy-task-protocol-bindings"
            )
        registry = load_json(registry_path)
        if registry.get("schemaVersion") != "legacy-task-protocol-bindings/v1":
            raise ValueError("Unsupported legacy task protocol registry")
        website = run.get("website_snapshot") or (
            run.get("study_revision") or {}
        ).get("website") or {}
        key = (
            run.get("study_revision_id"),
            website.get("websiteArtifactId"),
            task.get("website_task_id"),
        )
        matches = [
            item for item in registry.get("bindings", [])
            if (
                item.get("studyRevisionId"),
                item.get("websiteArtifactId"),
                item.get("websiteTaskId"),
            ) == key
        ]
        if len(matches) != 1:
            raise ValueError("Legacy task has no unique approved TaskProtocol binding")
        if not matches[0].get("approvedBy") or not matches[0].get("approvedAt"):
            raise ValueError("Legacy TaskProtocol binding is not approved")
        protocol = matches[0].get("taskProtocol")
    if not isinstance(protocol, dict):
        raise ValueError("TaskProtocol must be an object")
    protocol_id, semantic_digest = protocol_identity(protocol)
    return protocol, protocol_id, semantic_digest


def public_trace(trace: dict) -> dict:
    interactions = trace.get("interactions")
    if not isinstance(interactions, list):
        raise ValueError("Trace interactions must be an array")
    result = []
    prior_seq = 0
    for raw in interactions:
        if not isinstance(raw, dict):
            raise ValueError("Trace event must be an object")
        seq, ts, kind = raw.get("seq"), raw.get("ts"), raw.get("kind")
        if not isinstance(seq, int) or seq <= prior_seq:
            raise ValueError("Trace sequence must be strictly increasing")
        if not isinstance(ts, (int, float)) or ts < 0 or not isinstance(kind, str):
            raise ValueError(f"Trace event {seq} has invalid time or kind")
        event = {
            key: value for key, value in raw.items()
            if key in PUBLIC_TRACE_FIELDS and key not in PRIVATE_KEYS
        }
        for key in ("url", "href", "action"):
            if key in event:
                event[key] = safe_url_path(event[key])
        if raw.get("value") is not None:
            event["valueRedacted"] = True
            event["valueLength"] = min(len(str(raw["value"])), 200)
        if (
            isinstance(event.get("key"), str)
            and len(event["key"]) == 1
        ):
            event["key"] = "Printable"
        result.append(event)
        prior_seq = seq
    return {
        "schemaVersion": "evidence-trace/v1",
        "clock": "trace-relative-ms",
        "interactions": result,
    }


@contextmanager
def run_lock(data_root: Path, run_id: str, timeout_seconds: float = 15.0):
    lock_root = data_root / ".locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(f"run:{run_id}".encode("utf-8")).hexdigest()
    lock = lock_root / f"{name}.lock"
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            lock.mkdir()
            atomic_write_json(lock / "owner.json", {
                "key": f"run:{run_id}",
                "pid": os.getpid(),
                "acquired_at": datetime.now(timezone.utc).isoformat(),
            })
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out acquiring run lock for {run_id}")
            time.sleep(0.05)
    try:
        yield
    finally:
        shutil.rmtree(lock, ignore_errors=True)


def write_payloads(
    stage: Path,
    run: dict,
    task: dict,
    attempt: dict,
    capture: dict,
    trace: dict,
    protocol_id: str,
    semantic_digest: str,
    attempt_dir: Path,
) -> None:
    revision = run.get("study_revision")
    website = run.get("website_snapshot") or (
        revision.get("website") if isinstance(revision, dict) else {}
    ) or {}
    study_revision_id = run.get("study_revision_id")
    if not study_revision_id or not run.get("study_revision_digest"):
        raise ValueError("Attempt has no frozen Study Revision")
    artifact_id = website.get("websiteArtifactId")
    artifact_digest = website.get("artifactDigest")
    artifact_task_id = task.get("website_task_id")
    if not artifact_id or not artifact_digest or not artifact_task_id:
        raise ValueError("Attempt has incomplete frozen website/task identity")

    atomic_write_json(stage / "context/study-revision.json", {
        "schemaVersion": "evidence-study-revision/v1",
        "studyRevisionId": study_revision_id,
        "studyRevisionDigest": run["study_revision_digest"],
        "websiteArtifactId": artifact_id,
        "websiteAcquisitionId": website.get("websiteAcquisitionId"),
        "websiteArtifactDigest": artifact_digest,
    })
    atomic_write_json(stage / "context/task-assignment.json", {
        "schemaVersion": "evidence-task-assignment/v1",
        "assignmentId": task.get("assignment_id"),
        "position": task.get("position"),
        "sourcePosition": task.get("source_position"),
        "artifactTaskId": artifact_task_id,
        "taskProtocolId": protocol_id,
        "taskSemanticDigest": semantic_digest,
        "prompt": str(task.get("task_prompt") or "").strip(),
        "targetPath": safe_url_path(task.get("target_url") or task.get("site_url")),
    })

    timing = capture.get("recording_timing")
    recording = attempt_dir / "recording.webm"
    eligible = (
        attempt.get("status") in {"accepted", "failed"}
        and recording.is_file()
        and recording.stat().st_size > 0
        and isinstance(timing, dict)
        and timing.get("video_stop_epoch_ms") is not None
    )
    reason = None if eligible else (
        "invalidated-recording" if attempt.get("status") == "invalidated"
        else "incomplete-recording-or-timing"
    )
    atomic_write_json(stage / "evidence/attempt.json", {
        "schemaVersion": "evidence-attempt/v1",
        "attemptId": attempt.get("attempt_id"),
        "attemptNumber": attempt.get("attempt_number"),
        "status": attempt.get("status"),
        "outcome": attempt.get("outcome"),
        "outcomeAt": attempt.get("outcome_at"),
        "method3Eligible": eligible,
        "ineligibilityReason": reason,
    })
    if not isinstance(timing, dict):
        raise ValueError("EvidenceBundle requires recording timing")
    timing_values = [
        timing.get("video_start_epoch_ms"),
        timing.get("video_stop_epoch_ms"),
        timing.get("trace_origin_epoch_ms"),
        timing.get("trace_to_video_offset_ms"),
    ]
    if (
        any(not isinstance(value, (int, float)) for value in timing_values)
        or timing_values[1] <= timing_values[0]
        or timing_values[2] - timing_values[0] != timing_values[3]
    ):
        raise ValueError("Recording timing is inconsistent")
    atomic_write_json(stage / "evidence/capture-manifest.json", {
        "schemaVersion": "evidence-capture/v1",
        "clock": timing.get("clock"),
        "videoStartEpochMs": timing.get("video_start_epoch_ms"),
        "videoStopEpochMs": timing.get("video_stop_epoch_ms"),
        "traceOriginEpochMs": timing.get("trace_origin_epoch_ms"),
        "traceToVideoOffsetMs": timing.get("trace_to_video_offset_ms"),
        "startSource": timing.get("start_source"),
        "captureProfile": timing.get("capture_profile") or {},
    })
    atomic_write_json(stage / "evidence/trace.json", trace)
    if not recording.is_file() or recording.stat().st_size == 0:
        raise ValueError("EvidenceBundle requires a non-empty recording")
    shutil.copy2(recording, stage / "evidence/recording.webm")


def file_records(stage: Path) -> list[dict]:
    media_types = {
        ".json": "application/json",
        ".webm": "video/webm",
    }
    records = []
    for path in sorted(item for item in stage.rglob("*") if item.is_file()):
        if path.name == "bundle-manifest.json":
            continue
        relative = path.relative_to(stage).as_posix()
        if path.is_symlink() or not (
            relative.startswith("context/") or relative.startswith("evidence/")
        ):
            raise ValueError(f"Unsafe bundle path: {relative}")
        records.append({
            "path": relative,
            "mediaType": media_types.get(path.suffix, "application/octet-stream"),
            "bytes": path.stat().st_size,
            "sha256": file_digest(path),
        })
    return records


def export_bundle(
    participants_dir: Path,
    attempt_id: str,
    output_root: Path,
    legacy_bindings: Path | None = None,
) -> tuple[Path, dict]:
    if participants_dir.is_symlink() or output_root.is_symlink():
        raise ValueError("Evidence input and output roots may not be symlinks")
    participants_dir = participants_dir.resolve()
    output_root = output_root.resolve()
    data_root = participants_dir.parent
    if (
        output_root == data_root
        or output_root in data_root.parents
        or data_root in output_root.parents
    ):
        raise ValueError("Evidence output must not overlap the Collection data root")
    attempt_dir = find_attempt(participants_dir, attempt_id)
    task_dir, run_dir, _participant_dir = hierarchy(attempt_dir)
    inputs = [
        run_dir / "run.json", task_dir / "task.json",
        attempt_dir / "attempt.json", attempt_dir / "manifest.json",
        attempt_dir / "trace.json", attempt_dir / "recording.webm",
    ]
    if any(path.is_symlink() for path in inputs):
        raise ValueError("EvidenceBundle source files may not be symlinks")
    initial_run = load_json(run_dir / "run.json")
    run_id = str(initial_run.get("run_id") or "")
    if not run_id:
        raise ValueError("Attempt run has no run_id")
    output_root.mkdir(parents=True, exist_ok=True)

    with run_lock(data_root, run_id):
        run = load_json(run_dir / "run.json")
        task = load_json(task_dir / "task.json")
        attempt = load_json(attempt_dir / "attempt.json")
        capture = load_json(attempt_dir / "manifest.json")
        trace = load_json(attempt_dir / "trace.json")
        if (
            attempt.get("attempt_id") != attempt_id
            or attempt.get("run_id") != run_id
            or task.get("run_id") != run_id
            or attempt.get("assignment_id") != task.get("assignment_id")
        ):
            raise ValueError("Attempt hierarchy is inconsistent")
        if attempt.get("status") not in TERMINAL_STATUSES:
            raise ValueError("Only terminal attempts can be exported")
        _protocol, protocol_id, semantic_digest = resolve_protocol(
            run, task, legacy_bindings
        )
        public = public_trace(trace)
        stage = Path(tempfile.mkdtemp(prefix=".evidence-stage-", dir=output_root))
        try:
            write_payloads(
                stage, run, task, attempt, capture, public,
                protocol_id, semantic_digest, attempt_dir,
            )
            records = file_records(stage)
            identity = {
                "schemaVersion": "evidence-bundle/v1",
                "studyRevisionId": run.get("study_revision_id"),
                "assignmentId": task.get("assignment_id"),
                "attemptId": attempt_id,
                "taskProtocolId": protocol_id,
                "taskSemanticDigest": semantic_digest,
                "files": records,
            }
            digest = canonical_digest(identity)
            bundle_id = f"evb_{digest.removeprefix('sha256:')[:32]}"
            manifest = {
                **identity,
                "bundleId": bundle_id,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            atomic_write_json(stage / "bundle-manifest.json", manifest)
            target = output_root / bundle_id
            if target.exists():
                existing = load_json(target / "bundle-manifest.json")
                existing_identity = {
                    key: existing[key] for key in identity
                }
                if existing_identity != identity:
                    raise ValueError("Existing bundle ID has different content")
                shutil.rmtree(stage)
                return target, existing
            os.replace(stage, target)
            return target, manifest
        except BaseException:
            shutil.rmtree(stage, ignore_errors=True)
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--participants-dir", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--legacy-task-protocol-bindings")
    args = parser.parse_args()
    path, manifest = export_bundle(
        Path(args.participants_dir),
        args.attempt_id,
        Path(args.output_root),
        Path(args.legacy_task_protocol_bindings)
        if args.legacy_task_protocol_bindings else None,
    )
    print(json.dumps({
        "schemaVersion": manifest["schemaVersion"],
        "id": manifest["bundleId"],
        "path": str(path),
        "digest": canonical_digest({
            key: manifest[key] for key in (
                "schemaVersion", "studyRevisionId", "assignmentId", "attemptId",
                "taskProtocolId", "taskSemanticDigest", "files",
            )
        }),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
