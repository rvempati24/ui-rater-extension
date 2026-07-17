#!/usr/bin/env python3
"""Package completed UI Rater sessions locally and optionally upload them to HF."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
import re


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / "scripts" / "trace-export.example.json"


def parse_bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def resolve_path(value: str | None, fallback: Path) -> Path:
    if not value:
        return fallback.resolve()
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()


def load_config(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def completed_sessions(sessions_dir: Path) -> list[Path]:
    result: list[Path] = []
    if not sessions_dir.exists():
        return result
    for candidate in sorted(sessions_dir.iterdir()):
        manifest_file = candidate / "manifest.json"
        if not candidate.is_dir() or not manifest_file.exists():
            continue
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("status") == "complete" and (candidate / "trace.json").exists():
            result.append(candidate)
    return result


def safe_segment(value: object, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip()).strip(".-")
    return cleaned or fallback


def session_export_path(manifest: dict) -> Path:
    website = manifest.get("website") or {}
    model = safe_segment(website.get("model"), "unknown-model")
    site = safe_segment(website.get("website"), "unknown-site")
    run_id = safe_segment(website.get("run_id") or manifest.get("app_id"), "unknown-run")
    attempt = safe_segment(manifest.get("attempt_id"), "attempt-001")
    user = safe_segment(manifest.get("participant_id"), "anonymous")
    session = safe_segment(manifest.get("session_id"), "unknown-session")
    return Path(model, site, run_id, "attempts", attempt, "users", user, "sessions", session)


def copy_sessions(sessions: list[Path], destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    indexed: list[dict] = []
    for source in sessions:
        manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
        relative = session_export_path(manifest)
        shutil.copytree(source, destination / relative, dirs_exist_ok=True)
        indexed.append({**manifest, "export_path": relative.as_posix()})

    index_file = destination / "sessions.jsonl"
    with index_file.open("w", encoding="utf-8") as handle:
        for manifest in indexed:
            handle.write(json.dumps(manifest, ensure_ascii=False) + "\n")


def upload_to_hf(folder: Path, repo_id: str, path_prefix: str, token: str) -> None:
    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise SystemExit(
            "HF upload needs huggingface_hub. Install it with: "
            "python -m pip install huggingface_hub"
        ) from error

    HfApi(token=token).upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(folder),
        path_in_repo=path_prefix or None,
        commit_message="Upload UI Rater task traces",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--sessions-dir")
    parser.add_argument("--local-export-dir")
    parser.add_argument("--upload-hf", action="store_true")
    parser.add_argument("--no-upload-hf", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = load_config(Path(args.config).expanduser().resolve())
    sessions_dir = resolve_path(
        args.sessions_dir or os.getenv("UI_RATER_SESSIONS_DIR") or config.get("sessions_dir"),
        REPO_ROOT / "data" / "sessions",
    )
    local_dir = resolve_path(
        args.local_export_dir
        or os.getenv("UI_RATER_LOCAL_EXPORT_DIR")
        or config.get("local_export_dir"),
        REPO_ROOT / "exports" / "ux-task-trace",
    )
    keep_local = parse_bool(
        os.getenv("UI_RATER_KEEP_LOCAL_EXPORT", config.get("keep_local_export")), True
    )
    upload_hf = parse_bool(
        os.getenv("UI_RATER_UPLOAD_HF", config.get("upload_hf")), False
    )
    if args.upload_hf:
        upload_hf = True
    if args.no_upload_hf:
        upload_hf = False

    repo_id = os.getenv("HF_DATASET_REPO", config.get("hf_repo_id", "uxBench/ux-task-trace"))
    path_prefix = os.getenv("HF_PATH_PREFIX", config.get("hf_path_prefix", ""))
    token = os.getenv("HF_TOKEN", "")
    sessions = completed_sessions(sessions_dir)

    print(f"Completed sessions: {len(sessions)}")
    print(f"Source: {sessions_dir}")
    print(f"Keep local export: {keep_local}")
    if keep_local:
        print(f"Local export: {local_dir}")
    print(f"Upload to HF: {upload_hf} ({repo_id}/{path_prefix})")

    if args.dry_run or not sessions:
        return 0
    if upload_hf and not token:
        raise SystemExit("HF_TOKEN is required when HF upload is enabled")

    if keep_local:
        copy_sessions(sessions, local_dir)
        upload_dir = local_dir
        if upload_hf:
            upload_to_hf(upload_dir, repo_id, path_prefix, token)
    elif upload_hf:
        with tempfile.TemporaryDirectory(prefix="ui-rater-export-") as temp:
            upload_dir = Path(temp)
            copy_sessions(sessions, upload_dir)
            upload_to_hf(upload_dir, repo_id, path_prefix, token)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
