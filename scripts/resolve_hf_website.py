#!/usr/bin/env python3
"""Select and cache one generated website from a Hugging Face dataset."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import random
import shutil
import sys
import uuid

try:
    from scripts.collection_json import atomic_write_json
except ModuleNotFoundError:
    from collection_json import atomic_write_json


DEFAULT_REPO = "uxBench/website-generation"
DEFAULT_REVISION = "prompt-userflow-regen-20260624"


def split_run_path(value: str) -> tuple[str, str, str]:
    parts = PurePosixPath(value.strip("/")).parts
    if len(parts) != 3 or any(part in {"", ".", ".."} for part in parts):
        raise ValueError("website must be model/website/run-id")
    return parts[0], parts[1], parts[2]


def discover_runs(paths: list[str], model: str | None, website: str | None) -> list[str]:
    runs: set[str] = set()
    for value in paths:
        parts = PurePosixPath(value).parts
        if len(parts) == 4 and parts[-1] == "trials-config.json":
            candidate_model, candidate_website, run_id, _ = parts
            if model and candidate_model.lower() != model.lower():
                continue
            if website and candidate_website.lower() != website.lower():
                continue
            runs.add("/".join((candidate_model, candidate_website, run_id)))
    return sorted(runs)


def choose_run(runs: list[str], seed: str) -> str:
    if not runs:
        raise ValueError("no generated website matches the requested filters")
    return random.Random(seed).choice(runs)


def load_hf():
    try:
        from huggingface_hub import HfApi, snapshot_download
    except ImportError as error:
        raise SystemExit(
            "Website download needs huggingface_hub. Install it with: "
            "python -m pip install huggingface_hub"
        ) from error
    return HfApi, snapshot_download


def replace_tree(source: Path, destination: Path) -> None:
    """Publish a complete directory without retaining files from an older run."""
    source = source.resolve()
    destination = destination.resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("deployment directory must not overlap the downloaded source")
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = destination.parent / f".{destination.name}.stage-{uuid.uuid4().hex}"
    backup = destination.parent / f".{destination.name}.backup-{uuid.uuid4().hex}"
    try:
        shutil.copytree(source, stage)
        if destination.exists():
            destination.rename(backup)
        stage.rename(destination)
        if backup.exists():
            shutil.rmtree(backup)
    except BaseException:
        if not destination.exists() and backup.exists():
            backup.rename(destination)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup.exists() and destination.exists():
            shutil.rmtree(backup)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-id", default=DEFAULT_REPO)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--website", help="Exact model/website/run-id")
    parser.add_argument("--model")
    parser.add_argument("--site")
    parser.add_argument("--seed", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--deploy-dir", required=True)
    parser.add_argument("--no-deploy", action="store_true")
    args = parser.parse_args()

    HfApi, snapshot_download = load_hf()
    # Avoid stale machine-level credentials for public datasets. Authenticate only
    # when the operator explicitly supplies HF_TOKEN.
    token: str | bool = os.getenv("HF_TOKEN") or False
    api = HfApi(token=token)
    info = api.dataset_info(args.repo_id, revision=args.revision, token=token)
    pinned_revision = info.sha

    if args.website:
        selected = "/".join(split_run_path(args.website))
        selected_model, selected_site, run_id = split_run_path(selected)
        entries = list(api.list_repo_tree(
            args.repo_id, path_in_repo=selected, recursive=True,
            revision=pinned_revision, repo_type="dataset", token=token,
        ))
        paths = [entry.path for entry in entries]
        if f"{selected}/trials-config.json" not in paths:
            raise SystemExit(f"Selected website has no trials-config.json: {selected}")
    else:
        root_entries = list(api.list_repo_tree(
            args.repo_id, recursive=False, revision=pinned_revision,
            repo_type="dataset", token=token,
        ))
        models = sorted(
            entry.path for entry in root_entries
            if entry.__class__.__name__ == "RepoFolder" and "/" not in entry.path
        )
        if args.model:
            models = [value for value in models if value.lower() == args.model.lower()]
        all_paths: list[str] = []
        for model_name in models:
            all_paths.extend(entry.path for entry in api.list_repo_tree(
                args.repo_id, path_in_repo=model_name, recursive=True,
                revision=pinned_revision, repo_type="dataset", token=token,
            ))
        selected = choose_run(discover_runs(all_paths, args.model, args.site), args.seed)
        selected_model, selected_site, run_id = split_run_path(selected)
        entries = list(api.list_repo_tree(
            args.repo_id, path_in_repo=selected, recursive=True,
            revision=pinned_revision, repo_type="dataset", token=token,
        ))
        paths = [entry.path for entry in entries]

    cache_dir = Path(args.cache_dir).resolve()
    snapshot_download(
        repo_id=args.repo_id,
        repo_type="dataset",
        revision=pinned_revision,
        allow_patterns=[f"{selected}/**"],
        local_dir=str(cache_dir),
        token=token,
    )
    source_dir = cache_dir.joinpath(*PurePosixPath(selected).parts)
    task_file = source_dir / "trials-config.json"
    dist_dir = source_dir / "dist"
    if not task_file.is_file() or not (dist_dir / "index.html").is_file():
        raise SystemExit(f"Downloaded run is incomplete: {source_dir}")

    deployment = Path(args.deploy_dir).resolve() / run_id
    if not args.no_deploy:
        replace_tree(dist_dir, deployment)

    existing_metadata = [
        str(PurePosixPath(value).relative_to(selected))
        for value in paths
        if "metadata" in PurePosixPath(value).name.lower()
        or PurePosixPath(value).name in {"opencode-session.json", "status.txt"}
    ]
    files = [{
        "path": str(PurePosixPath(entry.path).relative_to(selected)),
        "size": getattr(entry, "size", None),
        "blob_id": getattr(entry, "blob_id", None),
    } for entry in entries if entry.__class__.__name__ == "RepoFile"]
    metadata = {
        "schema_version": 1,
        "source": "huggingface",
        "repo_id": args.repo_id,
        "revision": args.revision,
        "commit_sha": info.sha,
        "model": selected_model,
        "website": selected_site,
        "run_id": run_id,
        "path_in_repo": selected,
        "source_url": f"https://huggingface.co/datasets/{args.repo_id}/tree/{args.revision}/{selected}",
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "source_dir": str(source_dir),
        "task_file": str(task_file),
        "deployment_dir": str(deployment),
        "existing_metadata_files": sorted(existing_metadata),
        "files": files,
    }
    metadata_file = source_dir / "ui-rater-website.json"
    atomic_write_json(metadata_file, metadata)
    compact = {key: value for key, value in metadata.items() if key != "files"}
    compact["file_count"] = len(files)
    compact["metadata_file"] = str(metadata_file)
    print(json.dumps(compact, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"Website resolution failed: {error}", file=sys.stderr)
        raise SystemExit(1)
