#!/usr/bin/env python3
"""Validate and export participant/run/task/attempt trees locally or to Hugging Face."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import uuid

try:
    from scripts.collection_json import atomic_write_json, canonical_sha256
except ModuleNotFoundError:
    from collection_json import atomic_write_json, canonical_sha256


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / "scripts" / "trace-export.example.json"
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
AUDIT_ATTEMPT_STATUSES = {"accepted", "failed", "invalidated"}


def parse_bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def resolve_path(value: str | None, fallback: Path) -> Path:
    if not value:
        return fallback.resolve()
    target = Path(value).expanduser()
    return target.resolve() if target.is_absolute() else (REPO_ROOT / target).resolve()


def load_config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def validate_id(value: object, label: str) -> str:
    text = str(value or "")
    if not SAFE_ID.fullmatch(text):
        raise ValueError(f"Invalid {label}: {text!r}")
    return text


def reject_symlinks(root: Path, label: str) -> None:
    if root.is_symlink():
        raise ValueError(f"{label} may not be a symlink")
    for item in root.rglob("*"):
        if item.is_symlink():
            raise ValueError(f"{label} contains a symlink: {item.relative_to(root)}")


def iter_runs(
    participants_dir: Path, run_id: str | None = None, participant_id: str | None = None
):
    if not participants_dir.exists():
        return
    for participant_dir in sorted(
        path for path in participants_dir.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    ):
        reject_symlinks(participant_dir, f"Participant tree {participant_dir.name}")
        participant_file = participant_dir / "participant.json"
        if not participant_file.exists():
            continue
        participant = load_json(participant_file)
        stored_participant_id = validate_id(participant.get("participant_id"), "participant_id")
        if participant_dir.name != stored_participant_id:
            raise ValueError("Participant directory does not match participant_id")
        if participant_id and participant.get("participant_id") != participant_id:
            continue
        runs_dir = participant_dir / "runs"
        if not runs_dir.exists():
            continue
        for run_dir in sorted(
            path for path in runs_dir.iterdir()
            if path.is_dir() and not path.name.startswith(".")
        ):
            if run_dir.is_symlink():
                raise ValueError(f"Run directory may not be a symlink: {run_dir}")
            run_file = run_dir / "run.json"
            if not run_file.exists():
                continue
            run = load_json(run_file)
            stored_run_id = validate_id(run.get("run_id"), "run_id")
            if run_dir.name != stored_run_id:
                raise ValueError("Run directory does not match run_id")
            if run_id and run.get("run_id") != run_id:
                continue
            yield participant_dir, participant, run_dir, run


def selected_attempts(run_dir: Path, mode: str) -> list[tuple[Path, dict, dict]]:
    selected: list[tuple[Path, dict, dict]] = []
    tasks_dir = run_dir / "tasks"
    if not tasks_dir.exists():
        return selected
    for task_dir in sorted(
        path for path in tasks_dir.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    ):
        if task_dir.is_symlink():
            raise ValueError(f"Task directory may not be a symlink: {task_dir}")
        task = load_json(task_dir / "task.json")
        assignment_id = validate_id(task.get("assignment_id"), "assignment_id")
        position = task.get("position")
        if not isinstance(position, int) or task_dir.name != f"{position:03d}-{assignment_id}":
            raise ValueError(f"Task directory does not match task {assignment_id}")
        attempts_dir = task_dir / "attempts"
        if not attempts_dir.exists():
            continue
        attempts: list[tuple[Path, dict]] = []
        for attempt_dir in sorted(
            path for path in attempts_dir.iterdir()
            if path.is_dir() and not path.name.startswith(".")
        ):
            reject_symlinks(attempt_dir, f"Attempt tree {attempt_dir.name}")
            attempt = load_json(attempt_dir / "attempt.json")
            attempt_id = validate_id(attempt.get("attempt_id"), "attempt_id")
            attempt_number = attempt.get("attempt_number")
            if (not isinstance(attempt_number, int)
                    or attempt_dir.name != f"{attempt_number:03d}-{attempt_id}"):
                raise ValueError(f"Attempt directory does not match attempt {attempt_id}")
            if attempt.get("assignment_id") != task.get("assignment_id"):
                raise ValueError(f"Attempt {attempt.get('attempt_id')} belongs to another task")
            attempts.append((attempt_dir, attempt))
        accepted = [attempt for _, attempt in attempts if attempt.get("status") == "accepted"]
        task_status = task.get("status") or ("completed" if task.get("accepted_attempt_id") else "pending")
        if len(accepted) > 1:
            raise ValueError(f"Task {task.get('assignment_id')} has multiple accepted attempts")
        if task_status == "completed":
            if len(accepted) != 1 or task.get("accepted_attempt_id") != accepted[0].get("attempt_id"):
                raise ValueError(f"Task {task.get('assignment_id')} has an invalid accepted_attempt_id")
        elif task.get("accepted_attempt_id") or accepted:
            raise ValueError(f"Non-completed task {task.get('assignment_id')} has an accepted attempt")
        for attempt_dir, attempt in attempts:
            if mode == "accepted" and attempt.get("status") != "accepted":
                continue
            if mode == "audit" and attempt.get("status") not in AUDIT_ATTEMPT_STATUSES:
                continue
            selected.append((attempt_dir, attempt, task))
    return selected


def validate_attempt(
    attempt_dir: Path, attempt: dict, require_video: bool = True, allow_incomplete: bool = False
) -> dict[str, str]:
    required = ["attempt.json", "manifest.json", "trace.json"]
    if require_video:
        required.append("recording.webm")
    checksums: dict[str, str] = {}
    for name in required:
        file = attempt_dir / name
        if not file.is_file() or file.stat().st_size == 0:
            if allow_incomplete and name != "attempt.json":
                continue
            raise ValueError(f"Attempt {attempt.get('attempt_id')} is missing non-empty {name}")
        checksums[name] = sha256(file)
    manifest_file = attempt_dir / "manifest.json"
    manifest = load_json(manifest_file) if manifest_file.exists() else None
    if manifest and manifest.get("session_id") != attempt.get("session_id"):
        raise ValueError(f"Attempt {attempt.get('attempt_id')} has a session mismatch")
    if attempt.get("status") == "accepted" and require_video:
        timing = (manifest or {}).get("recording_timing")
        if not isinstance(timing, dict) or timing.get("video_stop_epoch_ms") is None:
            raise ValueError(f"Attempt {attempt.get('attempt_id')} has no complete recording timing")
    trace_file = attempt_dir / "trace.json"
    trace = load_json(trace_file) if trace_file.exists() else None
    interactions = trace.get("interactions") if trace else None
    if trace and not isinstance(interactions, list):
        raise ValueError(f"Attempt {attempt.get('attempt_id')} trace interactions are invalid")
    if manifest and isinstance(interactions, list) and manifest.get("interaction_count") is not None:
        if manifest.get("interaction_count") != len(interactions):
            raise ValueError(f"Attempt {attempt.get('attempt_id')} interaction count is inconsistent")
    snapshots = attempt_dir / "snapshots"
    snapshot_count = 0
    snapshot_bytes = 0
    snapshot_reasons: set[str] = set()
    if snapshots.exists():
        metadata_files = sorted(snapshots.glob("*.json"))
        image_files = sorted(snapshots.glob("*.jpg"))
        metadata_stems = {path.stem for path in metadata_files}
        image_stems = {path.stem for path in image_files}
        if metadata_stems != image_stems:
            raise ValueError(f"Attempt {attempt.get('attempt_id')} has an incomplete snapshot pair")
        for metadata in metadata_files:
            image = snapshots / f"{metadata.stem}.jpg"
            detail = load_json(metadata)
            if detail.get("snapshot_id") != metadata.stem:
                raise ValueError(f"Snapshot {metadata.stem} has inconsistent metadata")
            if not image.is_file() or image.stat().st_size == 0:
                raise ValueError(f"Snapshot {metadata.stem} has no non-empty JPEG")
            checksums[f"snapshots/{metadata.name}"] = sha256(metadata)
            checksums[f"snapshots/{image.name}"] = sha256(image)
            snapshot_count += 1
            snapshot_bytes += image.stat().st_size
            snapshot_reasons.add(str(detail.get("reason") or ""))
    if manifest and manifest.get("snapshot_count") is not None:
        if manifest.get("snapshot_count") != snapshot_count:
            raise ValueError(f"Attempt {attempt.get('attempt_id')} snapshot count is inconsistent")
    if manifest and manifest.get("snapshot_bytes") is not None:
        if manifest.get("snapshot_bytes") != snapshot_bytes:
            raise ValueError(f"Attempt {attempt.get('attempt_id')} snapshot bytes are inconsistent")
    if attempt.get("status") == "accepted" and manifest and manifest.get("schema_version") == 2:
        finalization = manifest.get("finalization_report")
        if (not isinstance(finalization, dict)
                or finalization.get("interaction_flush") != "acknowledged"
                or finalization.get("task_end_snapshot") != "acknowledged"
                or manifest.get("final_flush_status") != "complete"
                or "task-end" not in snapshot_reasons):
            raise ValueError(f"Attempt {attempt.get('attempt_id')} has incomplete v2 finalization")
    return checksums


def _copy_participant_export_uncommitted(
    participants_dir: Path,
    destination: Path,
    mode: str = "accepted",
    run_id: str | None = None,
    participant_id: str | None = None,
    require_video: bool = True,
) -> list[dict]:
    source_root = participants_dir.resolve()
    target_root = destination.resolve()
    if source_root == target_root or source_root in target_root.parents or target_root in source_root.parents:
        raise ValueError("Export destination must not overlap the canonical participants directory")
    if destination.exists():
        marker = destination / "dataset-info.json"
        if any(destination.iterdir()) and (
            not marker.exists() or load_json(marker).get("layout") != "participant-v3-integrity"
        ):
            raise ValueError("Refusing to replace a non-participant-v3-integrity export directory")
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    participant_rows: dict[str, dict] = {}
    run_rows: list[dict] = []
    attempt_rows: list[dict] = []

    for participant_dir, participant, source_run_dir, run in iter_runs(
        participants_dir, run_id, participant_id
    ):
        if mode == "accepted" and run.get("status") != "completed":
            continue
        attempts = selected_attempts(source_run_dir, mode)
        if not attempts:
            continue
        participant_id = validate_id(participant["participant_id"], "participant_id")
        current_run_id = validate_id(run["run_id"], "run_id")
        if run.get("participant_id") != participant_id:
            raise ValueError(f"Run {current_run_id} belongs to another participant")
        target_participant = destination / "participants" / participant_id
        target_run = target_participant / "runs" / current_run_id
        target_participant.mkdir(parents=True, exist_ok=True)
        shutil.copy2(participant_dir / "participant.json", target_participant / "participant.json")
        target_run.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_run_dir / "run.json", target_run / "run.json")
        participant_rows[participant_id] = participant
        run_rows.append(run)

        for source_attempt, attempt, task in attempts:
            if task.get("run_id") != current_run_id or task.get("participant_id") != participant_id:
                raise ValueError(f"Task {task.get('assignment_id')} has inconsistent parent IDs")
            if (attempt.get("run_id") != current_run_id
                    or attempt.get("participant_id") != participant_id):
                raise ValueError(f"Attempt {attempt.get('attempt_id')} has inconsistent parent IDs")
            checksums = validate_attempt(
                source_attempt, attempt, require_video=require_video,
                allow_incomplete=mode == "audit" and attempt.get("status") != "accepted",
            )
            source_task = source_attempt.parent.parent
            target_task = target_run / "tasks" / source_task.name
            target_attempt = target_task / "attempts" / source_attempt.name
            target_task.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_task / "task.json", target_task / "task.json")
            shutil.copytree(source_attempt, target_attempt)
            enriched = {
                **attempt, "artifact_manifest": "artifact-manifest.json",
                "artifact_complete": all(name in checksums for name in ("manifest.json", "trace.json"))
                    and (not require_video or "recording.webm" in checksums),
            }
            atomic_write_json(target_attempt / "attempt.json", enriched)
            artifact_records = []
            for artifact_file in sorted(path for path in target_attempt.rglob("*") if path.is_file()):
                if artifact_file.is_symlink():
                    raise ValueError(f"Attempt artifact contains a symlink: {artifact_file}")
                if artifact_file.name == "artifact-manifest.json":
                    continue
                artifact_records.append({
                    "path": artifact_file.relative_to(target_attempt).as_posix(),
                    "bytes": artifact_file.stat().st_size,
                    "sha256": sha256(artifact_file),
                })
            artifact_manifest = {
                "schema_version": 1,
                "attempt_id": attempt["attempt_id"],
                "files": artifact_records,
            }
            artifact_manifest["root_sha256"] = canonical_sha256(artifact_manifest)
            atomic_write_json(target_attempt / "artifact-manifest.json", artifact_manifest)
            artifact_manifest_sha256 = sha256(target_attempt / "artifact-manifest.json")
            artifact_checksums = {
                record["path"]: record["sha256"] for record in artifact_records
            }
            relative = target_attempt.relative_to(destination).as_posix()
            website = run.get("website_snapshot") or (run.get("study_revision") or {}).get("website") or {}
            attempt_rows.append({
                **enriched,
                "artifact_checksums": artifact_checksums,
                "task_position": task.get("position"),
                "task_source_position": task.get("source_position"),
                "task_prompt": task.get("task_prompt"),
                "task_status": task.get("status"),
                "task_outcome": task.get("outcome"),
                "task_reason": task.get("reason"),
                "task_outcome_at": task.get("outcome_at"),
                "study_revision_id": run.get("study_revision_id"),
                "study_revision_digest": run.get("study_revision_digest"),
                "website_artifact_id": website.get("websiteArtifactId"),
                "website_acquisition_id": website.get("websiteAcquisitionId"),
                "website_deployment_id": website.get("websiteDeploymentId"),
                "website_artifact_digest": website.get("artifactDigest"),
                "artifact_path": relative,
                "artifact_root_sha256": artifact_manifest["root_sha256"],
                "artifact_manifest_sha256": artifact_manifest_sha256,
            })

    index = destination / "index"
    index.mkdir(exist_ok=True)
    for name, rows in (
        ("participants", list(participant_rows.values())),
        ("runs", run_rows),
        ("attempts", attempt_rows),
    ):
        with (index / f"{name}.jsonl").open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (destination / "dataset-info.json").write_text(json.dumps({
        "schema_version": "3.0", "layout": "participant-v3-integrity", "export_mode": mode,
        "participants": len(participant_rows), "runs": len(run_rows), "attempts": len(attempt_rows),
    }, indent=2), encoding="utf-8")
    return attempt_rows


def copy_participant_export(
    participants_dir: Path,
    destination: Path,
    mode: str = "accepted",
    run_id: str | None = None,
    participant_id: str | None = None,
    require_video: bool = True,
) -> list[dict]:
    """Build a complete export in a sibling stage and publish it atomically."""
    destination = destination.resolve()
    source_root = participants_dir.resolve()
    if (source_root == destination or source_root in destination.parents or destination in source_root.parents):
        raise ValueError("Export destination must not overlap the canonical participants directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{destination.name}.stage-", dir=destination.parent))
    backup: Path | None = None
    try:
        rows = _copy_participant_export_uncommitted(
            participants_dir, stage, mode=mode, run_id=run_id,
            participant_id=participant_id, require_video=require_video,
        )
        if destination.exists():
            marker = destination / "dataset-info.json"
            allowed = {"participant-v2", "participant-v3-integrity"}
            if any(destination.iterdir()) and (
                not marker.is_file() or load_json(marker).get("layout") not in allowed
            ):
                raise ValueError("Refusing to replace an unrecognized export directory")
            backup = destination.with_name(
                f".{destination.name}.backup-{os.getpid()}-{uuid.uuid4().hex[:8]}"
            )
            os.replace(destination, backup)
        os.replace(stage, destination)
        if backup:
            shutil.rmtree(backup)
        return rows
    except BaseException:
        if backup and backup.exists() and not destination.exists():
            os.replace(backup, destination)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def merge_rows(
    remote: list[dict], local: list[dict], key: str, immutable_hash_key: str | None = None
) -> list[dict]:
    merged = {str(row[key]): row for row in remote if row.get(key)}
    for row in local:
        value = str(row.get(key) or "")
        if not value:
            continue
        prior = merged.get(value)
        if prior and immutable_hash_key and prior.get(immutable_hash_key) != row.get(immutable_hash_key):
            raise ValueError(
                f"Immutable {key} {value} already exists with different evidence"
            )
        merged[value] = prior if prior and immutable_hash_key else row
    return [merged[value] for value in sorted(merged)]


def merge_remote_indexes(folder: Path, repo_id: str, revision: str, token: str) -> None:
    from huggingface_hub import hf_hub_download

    keys = {"participants": "participant_id", "runs": "run_id", "attempts": "attempt_id"}
    counts: dict[str, int] = {}
    for name, key in keys.items():
        local_file = folder / "index" / f"{name}.jsonl"
        local = [json.loads(line) for line in local_file.read_text(encoding="utf-8").splitlines() if line]
        try:
            remote_file = Path(hf_hub_download(
                repo_id=repo_id, repo_type="dataset", revision=revision,
                filename=f"index/{name}.jsonl", token=token,
            ))
            remote = [
                json.loads(line) for line in remote_file.read_text(encoding="utf-8").splitlines()
                if line
            ]
        except Exception as error:
            if "404" not in str(error) and "not found" not in str(error).lower():
                raise
            remote = []
        merged = merge_rows(
            remote, local, key,
            "artifact_root_sha256" if name == "attempts" else None,
        )
        local_file.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in merged),
            encoding="utf-8",
        )
        counts[name] = len(merged)
    info_file = folder / "dataset-info.json"
    info = load_json(info_file)
    info.update(counts)
    info_file.write_text(json.dumps(info, indent=2), encoding="utf-8")


def upload_to_hf(folder: Path, repo_id: str, revision: str, token: str):
    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise SystemExit("Install huggingface_hub with: python -m pip install huggingface_hub") from error
    api = HfApi(token=token)
    try:
        api.create_branch(repo_id=repo_id, repo_type="dataset", branch=revision)
    except Exception as error:  # branch commonly already exists
        if "already exists" not in str(error).lower() and "409" not in str(error):
            raise
    merge_remote_indexes(folder, repo_id, revision, token)
    return api.upload_folder(
        repo_id=repo_id, repo_type="dataset", revision=revision,
        folder_path=str(folder), commit_message="Sync participant-v3-integrity UI Rater traces",
    )


def write_sync_state(sync_state_dir: Path, rows: list[dict], repo_id: str, revision: str, commit_sha: str):
    sync_state_dir.mkdir(parents=True, exist_ok=True)
    runs = {(row["participant_id"], row["run_id"]) for row in rows}
    for participant_id, run_id in runs:
        state = {
            "schema_version": 2, "run_id": run_id, "participant_id": participant_id,
            "hf_repo_id": repo_id, "hf_revision": revision, "hf_commit_sha": commit_sha,
            "synced_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        }
        atomic_write_json(sync_state_dir / f"{run_id}.json", state)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--participants-dir")
    parser.add_argument("--local-export-dir")
    parser.add_argument("--mode", choices=["accepted", "audit"], default=None)
    parser.add_argument("--run-id")
    parser.add_argument("--participant-id")
    parser.add_argument("--no-video", action="store_true")
    parser.add_argument("--upload-hf", action="store_true")
    parser.add_argument("--no-upload-hf", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = load_config(Path(args.config).expanduser().resolve())
    participants_dir = resolve_path(
        args.participants_dir or os.getenv("UI_RATER_PARTICIPANTS_DIR") or config.get("participants_dir"),
        REPO_ROOT / "data" / "participants",
    )
    local_dir = resolve_path(
        args.local_export_dir or os.getenv("UI_RATER_LOCAL_EXPORT_DIR") or config.get("local_export_dir"),
        REPO_ROOT / "exports" / "ux-task-trace",
    )
    sync_state_dir = resolve_path(config.get("sync_state_dir"), REPO_ROOT / "data" / "sync-state")
    keep_local = parse_bool(os.getenv("UI_RATER_KEEP_LOCAL_EXPORT", config.get("keep_local_export")), True)
    upload_hf = parse_bool(os.getenv("UI_RATER_UPLOAD_HF", config.get("upload_hf")), False)
    if args.upload_hf:
        upload_hf = True
    if args.no_upload_hf:
        upload_hf = False
    mode = args.mode or config.get("export_mode", "accepted")
    repo_id = os.getenv("HF_DATASET_REPO", config.get("hf_repo_id", "uxBench/ux-task-trace"))
    revision = os.getenv("HF_DATASET_REVISION", config.get("hf_revision", "participant-v3-integrity"))
    token = os.getenv("HF_TOKEN", "")

    if args.participant_id:
        validate_id(args.participant_id, "participant_id")
    if args.run_id:
        validate_id(args.run_id, "run_id")
    runs = list(iter_runs(participants_dir, args.run_id, args.participant_id))
    eligible = [item for item in runs if mode == "audit" or item[3].get("status") == "completed"]
    print(f"Participant layout: {participants_dir}")
    print(f"Eligible runs: {len(eligible)} (mode={mode})")
    print(f"Keep local export: {keep_local} ({local_dir})")
    print(f"Upload to HF: {upload_hf} ({repo_id}@{revision})")
    if args.dry_run:
        for _, participant, _, run in eligible:
            print(f"  {participant['participant_id']}/{run['run_id']}")
        return 0
    if upload_hf and not token:
        raise SystemExit("HF_TOKEN is required when HF upload is enabled")
    if upload_hf and os.getenv("UI_RATER_DISABLE_EXTERNAL_WRITES") == "1":
        raise SystemExit("External writes are disabled by UI_RATER_DISABLE_EXTERNAL_WRITES")

    with tempfile.TemporaryDirectory(prefix="ui-rater-export-") as temp:
        stage = local_dir if keep_local else Path(temp) / "dataset"
        rows = copy_participant_export(
            participants_dir, stage, mode=mode, run_id=args.run_id, require_video=not args.no_video,
            participant_id=args.participant_id,
        )
        print(f"Exported attempts: {len(rows)}")
        if upload_hf and rows:
            commit = upload_to_hf(stage, repo_id, revision, token)
            commit_sha = getattr(commit, "oid", None) or getattr(commit, "commit_url", "unknown")
            write_sync_state(sync_state_dir, rows, repo_id, revision, str(commit_sha))
            print(f"HF commit: {commit_sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
