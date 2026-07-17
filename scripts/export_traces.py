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


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / "scripts" / "trace-export.example.json"
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


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


def iter_runs(participants_dir: Path, run_id: str | None = None):
    if not participants_dir.exists():
        return
    for participant_dir in sorted(path for path in participants_dir.iterdir() if path.is_dir()):
        participant_file = participant_dir / "participant.json"
        if not participant_file.exists():
            continue
        participant = load_json(participant_file)
        validate_id(participant.get("participant_id"), "participant_id")
        runs_dir = participant_dir / "runs"
        if not runs_dir.exists():
            continue
        for run_dir in sorted(path for path in runs_dir.iterdir() if path.is_dir()):
            run_file = run_dir / "run.json"
            if not run_file.exists():
                continue
            run = load_json(run_file)
            validate_id(run.get("run_id"), "run_id")
            if run_id and run.get("run_id") != run_id:
                continue
            yield participant_dir, participant, run_dir, run


def selected_attempts(run_dir: Path, mode: str) -> list[tuple[Path, dict, dict]]:
    selected: list[tuple[Path, dict, dict]] = []
    tasks_dir = run_dir / "tasks"
    if not tasks_dir.exists():
        return selected
    for task_dir in sorted(path for path in tasks_dir.iterdir() if path.is_dir()):
        task = load_json(task_dir / "task.json")
        validate_id(task.get("assignment_id"), "assignment_id")
        attempts_dir = task_dir / "attempts"
        if not attempts_dir.exists():
            continue
        for attempt_dir in sorted(path for path in attempts_dir.iterdir() if path.is_dir()):
            attempt = load_json(attempt_dir / "attempt.json")
            validate_id(attempt.get("attempt_id"), "attempt_id")
            if mode == "accepted" and attempt.get("status") != "accepted":
                continue
            if mode == "audit" and attempt.get("status") == "recording":
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
    snapshots = attempt_dir / "snapshots"
    if snapshots.exists():
        for metadata in snapshots.glob("*.json"):
            image = snapshots / f"{metadata.stem}.jpg"
            if not image.exists():
                raise ValueError(f"Snapshot {metadata.stem} has no JPEG")
            checksums[f"snapshots/{metadata.name}"] = sha256(metadata)
            checksums[f"snapshots/{image.name}"] = sha256(image)
    return checksums


def copy_participant_export(
    participants_dir: Path,
    destination: Path,
    mode: str = "accepted",
    run_id: str | None = None,
    require_video: bool = True,
) -> list[dict]:
    source_root = participants_dir.resolve()
    target_root = destination.resolve()
    if source_root == target_root or source_root in target_root.parents or target_root in source_root.parents:
        raise ValueError("Export destination must not overlap the canonical participants directory")
    if destination.exists():
        marker = destination / "dataset-info.json"
        if any(destination.iterdir()) and (
            not marker.exists() or load_json(marker).get("layout") != "participant-v2"
        ):
            raise ValueError("Refusing to replace a non-participant-v2 export directory")
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    participant_rows: dict[str, dict] = {}
    run_rows: list[dict] = []
    attempt_rows: list[dict] = []

    for participant_dir, participant, source_run_dir, run in iter_runs(participants_dir, run_id):
        if mode == "accepted" and run.get("status") != "completed":
            continue
        attempts = selected_attempts(source_run_dir, mode)
        if not attempts:
            continue
        participant_id = validate_id(participant["participant_id"], "participant_id")
        current_run_id = validate_id(run["run_id"], "run_id")
        target_participant = destination / "participants" / participant_id
        target_run = target_participant / "runs" / current_run_id
        target_participant.mkdir(parents=True, exist_ok=True)
        shutil.copy2(participant_dir / "participant.json", target_participant / "participant.json")
        target_run.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_run_dir / "run.json", target_run / "run.json")
        participant_rows[participant_id] = participant
        run_rows.append(run)

        for source_attempt, attempt, task in attempts:
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
                **attempt, "artifact_checksums": checksums,
                "artifact_complete": all(name in checksums for name in ("manifest.json", "trace.json"))
                    and (not require_video or "recording.webm" in checksums),
            }
            (target_attempt / "attempt.json").write_text(
                json.dumps(enriched, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            relative = target_attempt.relative_to(destination).as_posix()
            website = run.get("website") or {}
            attempt_rows.append({
                **enriched,
                "task_position": task.get("position"),
                "task_prompt": task.get("task_prompt"),
                "task_origin": task.get("task_origin"),
                "generator_model": website.get("model"),
                "website": website.get("website"),
                "artifact_path": relative,
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
        "schema_version": "2.0", "layout": "participant-v2", "export_mode": mode,
        "participants": len(participant_rows), "runs": len(run_rows), "attempts": len(attempt_rows),
    }, indent=2), encoding="utf-8")
    return attempt_rows


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
    return api.upload_folder(
        repo_id=repo_id, repo_type="dataset", revision=revision,
        folder_path=str(folder), commit_message="Sync participant-v2 UI Rater traces",
    )


def write_sync_state(sync_state_dir: Path, sync_queue_dir: Path, rows: list[dict], repo_id: str, revision: str, commit_sha: str):
    sync_state_dir.mkdir(parents=True, exist_ok=True)
    runs = {(row["participant_id"], row["run_id"]) for row in rows}
    for participant_id, run_id in runs:
        state = {
            "schema_version": 2, "run_id": run_id, "participant_id": participant_id,
            "hf_repo_id": repo_id, "hf_revision": revision, "hf_commit_sha": commit_sha,
            "synced_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        }
        (sync_state_dir / f"{run_id}.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
        queue = sync_queue_dir / f"{run_id}.json"
        if queue.exists():
            queue.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--participants-dir")
    parser.add_argument("--local-export-dir")
    parser.add_argument("--mode", choices=["accepted", "audit"], default=None)
    parser.add_argument("--run-id")
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
    sync_queue_dir = resolve_path(config.get("sync_queue_dir"), REPO_ROOT / "data" / "sync-queue")
    keep_local = parse_bool(os.getenv("UI_RATER_KEEP_LOCAL_EXPORT", config.get("keep_local_export")), True)
    upload_hf = parse_bool(os.getenv("UI_RATER_UPLOAD_HF", config.get("upload_hf")), False)
    if args.upload_hf:
        upload_hf = True
    if args.no_upload_hf:
        upload_hf = False
    mode = args.mode or config.get("export_mode", "accepted")
    repo_id = os.getenv("HF_DATASET_REPO", config.get("hf_repo_id", "uxBench/ux-task-trace"))
    revision = os.getenv("HF_DATASET_REVISION", config.get("hf_revision", "participant-v2"))
    token = os.getenv("HF_TOKEN", "")

    runs = list(iter_runs(participants_dir, args.run_id))
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

    with tempfile.TemporaryDirectory(prefix="ui-rater-export-") as temp:
        stage = local_dir if keep_local else Path(temp) / "dataset"
        rows = copy_participant_export(
            participants_dir, stage, mode=mode, run_id=args.run_id, require_video=not args.no_video,
        )
        print(f"Exported attempts: {len(rows)}")
        if upload_hf and rows:
            commit = upload_to_hf(stage, repo_id, revision, token)
            commit_sha = getattr(commit, "oid", None) or getattr(commit, "commit_url", "unknown")
            write_sync_state(sync_state_dir, sync_queue_dir, rows, repo_id, revision, str(commit_sha))
            print(f"HF commit: {commit_sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
