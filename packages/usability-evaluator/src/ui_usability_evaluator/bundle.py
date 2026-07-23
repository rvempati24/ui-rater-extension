"""Strict reader for Collection-owned EvidenceBundle v1 artifacts."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path, PurePosixPath

from .evidence import javascript_canonical_json, sha256_file


REQUIRED_FILES = {
    "context/study-revision.json",
    "context/task-assignment.json",
    "evidence/attempt.json",
    "evidence/capture-manifest.json",
    "evidence/trace.json",
    "evidence/recording.webm",
}


def _closed(value: dict, required: set[str], allowed: set[str], name: str) -> None:
    if not required.issubset(value) or set(value) - allowed:
        raise ValueError(f"EvidenceBundle {name} fields are invalid")


def _number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def validate_payloads(
    study: dict, task: dict, attempt: dict, capture: dict, trace: dict
) -> None:
    _closed(study, {
        "schemaVersion", "studyRevisionId", "studyRevisionDigest",
        "websiteArtifactId", "websiteArtifactDigest",
    }, {
        "schemaVersion", "studyRevisionId", "studyRevisionDigest",
        "websiteArtifactId", "websiteAcquisitionId", "websiteArtifactDigest",
    }, "study")
    _closed(task, {
        "schemaVersion", "assignmentId", "artifactTaskId", "taskProtocolId",
        "taskSemanticDigest", "prompt", "targetPath",
    }, {
        "schemaVersion", "assignmentId", "position", "sourcePosition",
        "artifactTaskId", "taskProtocolId", "taskSemanticDigest", "prompt",
        "targetPath",
    }, "task")
    _closed(attempt, {
        "schemaVersion", "attemptId", "attemptNumber", "status", "outcome",
        "method3Eligible",
    }, {
        "schemaVersion", "attemptId", "attemptNumber", "status", "outcome",
        "outcomeAt", "method3Eligible", "ineligibilityReason",
    }, "attempt")
    _closed(capture, {
        "schemaVersion", "clock", "videoStartEpochMs", "videoStopEpochMs",
        "traceOriginEpochMs", "traceToVideoOffsetMs", "captureProfile",
    }, {
        "schemaVersion", "clock", "videoStartEpochMs", "videoStopEpochMs",
        "traceOriginEpochMs", "traceToVideoOffsetMs", "startSource",
        "captureProfile",
    }, "capture")
    _closed(trace, {"schemaVersion", "clock", "interactions"}, {
        "schemaVersion", "clock", "interactions",
    }, "trace")
    if (
        study["schemaVersion"] != "evidence-study-revision/v1"
        or task["schemaVersion"] != "evidence-task-assignment/v1"
        or attempt["schemaVersion"] != "evidence-attempt/v1"
        or capture["schemaVersion"] != "evidence-capture/v1"
        or trace["schemaVersion"] != "evidence-trace/v1"
        or capture["clock"] != "unix-epoch-ms"
        or trace["clock"] != "trace-relative-ms"
    ):
        raise ValueError("EvidenceBundle payload version or clock is invalid")
    if (
        any(
            not isinstance(value, str) or not value
            for value in (
                study["studyRevisionId"], study["studyRevisionDigest"],
                study["websiteArtifactId"], study["websiteArtifactDigest"],
                task["assignmentId"], task["artifactTaskId"],
                task["taskProtocolId"], task["taskSemanticDigest"],
            )
        )
        or
        not isinstance(task["prompt"], str) or not task["prompt"].strip()
        or not isinstance(task["targetPath"], str)
        or not task["targetPath"].startswith("/")
        or not isinstance(attempt["attemptNumber"], int)
        or attempt["attemptNumber"] < 1
        or attempt["status"] not in {"accepted", "failed", "invalidated"}
        or attempt["outcome"] not in {
            "succeeded", "failed_retry", "failed_no_retry", "skipped",
            "recording_problem",
        }
        or not isinstance(attempt["method3Eligible"], bool)
        or not isinstance(capture["captureProfile"], dict)
    ):
        raise ValueError("EvidenceBundle payload values are invalid")
    if (
        ("position" in task and (
            not isinstance(task["position"], int) or task["position"] < 1
        ))
        or (
            task.get("sourcePosition") is not None
            and (
                not isinstance(task["sourcePosition"], int)
                or task["sourcePosition"] < 1
            )
        )
        or (
            attempt["method3Eligible"]
            and attempt["status"] == "invalidated"
        )
    ):
        raise ValueError("EvidenceBundle payload values are invalid")
    allowed_outcomes = {
        "accepted": {"succeeded"},
        "failed": {"failed_retry", "failed_no_retry", "skipped"},
        "invalidated": {"recording_problem"},
    }
    if attempt["outcome"] not in allowed_outcomes[attempt["status"]]:
        raise ValueError("EvidenceBundle attempt status/outcome is inconsistent")
    timing = [
        capture["videoStartEpochMs"], capture["videoStopEpochMs"],
        capture["traceOriginEpochMs"], capture["traceToVideoOffsetMs"],
    ]
    if (
        not all(_number(value) for value in timing)
        or timing[1] <= timing[0]
        or timing[2] - timing[0] != timing[3]
    ):
        raise ValueError("EvidenceBundle recording timing is inconsistent")


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected an object: {path}")
    return value


def identity_digest(identity: dict) -> str:
    canonical = javascript_canonical_json(identity).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def validate_bundle(value: Path) -> dict:
    if value.is_symlink():
        raise ValueError("EvidenceBundle root must be a real directory")
    root = value.resolve()
    if not root.is_dir():
        raise ValueError("EvidenceBundle root must be a real directory")
    if any(item.is_symlink() for item in root.rglob("*")):
        raise ValueError("EvidenceBundle forbids symlinks")
    manifest_path = root / "bundle-manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("EvidenceBundle has no safe bundle-manifest.json")
    manifest = load_json(manifest_path)
    if manifest.get("schemaVersion") != "evidence-bundle/v1":
        raise ValueError("Unsupported EvidenceBundle version")

    records = manifest.get("files")
    if not isinstance(records, list):
        raise ValueError("EvidenceBundle files must be an array")
    expected: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("EvidenceBundle file record must be an object")
        relative = PurePosixPath(str(record.get("path") or ""))
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or "\\" in relative.as_posix()
            or ":" in relative.as_posix()
            or relative.as_posix() in expected
        ):
            raise ValueError("EvidenceBundle contains an unsafe or duplicate path")
        relative_text = relative.as_posix()
        if not (
            relative_text.startswith("context/")
            or relative_text.startswith("evidence/")
        ):
            raise ValueError("EvidenceBundle file is outside its closed roots")
        path = root.joinpath(*relative.parts)
        resolved = path.resolve()
        if (
            path.is_symlink()
            or root not in resolved.parents
            or not resolved.is_file()
            or resolved.stat().st_size != record.get("bytes")
            or f"sha256:{sha256_file(resolved)}" != record.get("sha256")
        ):
            raise ValueError(f"EvidenceBundle file mismatch: {relative_text}")
        expected.add(relative_text)

    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*") if path.is_file()
    }
    if actual != expected | {"bundle-manifest.json"}:
        raise ValueError("EvidenceBundle closed file set does not match its manifest")
    if not REQUIRED_FILES.issubset(expected):
        raise ValueError("EvidenceBundle is missing a required payload")

    identity_keys = (
        "schemaVersion", "studyRevisionId", "assignmentId", "attemptId",
        "taskProtocolId", "taskSemanticDigest", "files",
    )
    if any(key not in manifest for key in identity_keys):
        raise ValueError("EvidenceBundle identity is incomplete")
    identity = {key: manifest[key] for key in identity_keys}
    expected_id = f"evb_{identity_digest(identity).removeprefix('sha256:')[:32]}"
    if manifest.get("bundleId") != expected_id:
        raise ValueError("EvidenceBundle ID does not match its content")

    study = load_json(root / "context/study-revision.json")
    task = load_json(root / "context/task-assignment.json")
    attempt = load_json(root / "evidence/attempt.json")
    capture = load_json(root / "evidence/capture-manifest.json")
    trace = load_json(root / "evidence/trace.json")
    validate_payloads(study, task, attempt, capture, trace)
    if (
        study.get("studyRevisionId") != manifest["studyRevisionId"]
        or task.get("assignmentId") != manifest["assignmentId"]
        or attempt.get("attemptId") != manifest["attemptId"]
        or task.get("taskProtocolId") != manifest["taskProtocolId"]
        or task.get("taskSemanticDigest") != manifest["taskSemanticDigest"]
    ):
        raise ValueError("EvidenceBundle payload identities are inconsistent")
    events = trace.get("interactions")
    if not isinstance(events, list):
        raise ValueError("EvidenceBundle trace is invalid")
    prior = 0
    for event in events:
        if (
            not isinstance(event, dict)
            or not isinstance(event.get("seq"), int)
            or isinstance(event.get("seq"), bool)
            or event["seq"] <= prior
            or not _number(event.get("ts"))
            or event["ts"] < 0
            or not isinstance(event.get("kind"), str)
            or not event["kind"]
        ):
            raise ValueError("EvidenceBundle trace order or event is invalid")
        prior = event["seq"]
    return {
        "root": root,
        "manifest": manifest,
        "study": study,
        "task": task,
        "attempt": attempt,
        "capture": capture,
        "trace": trace,
    }
