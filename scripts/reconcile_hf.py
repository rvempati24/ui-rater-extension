#!/usr/bin/env python3
"""Reconcile a validated local participant export with one pinned HF commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile

try:
    from scripts.export_traces import copy_participant_export
    from scripts.ux_evidence import canonical_sha256
except ModuleNotFoundError:
    from export_traces import copy_participant_export
    from ux_evidence import canonical_sha256


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def read_rows(path: Path) -> tuple[dict[str, dict], list[str]]:
    rows: dict[str, dict] = {}
    duplicates: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        attempt_id = str(row.get("attempt_id") or "")
        if attempt_id in rows:
            duplicates.append(attempt_id)
        rows[attempt_id] = row
    return rows, sorted(set(duplicates))


def safe_repo_path(value: object) -> str:
    path = PurePosixPath(str(value or ""))
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe HF artifact path: {value!r}")
    return path.as_posix()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--participants-dir", default="data/participants")
    parser.add_argument("--hf-repo", default="uxBench/ux-task-trace")
    parser.add_argument("--hf-revision", default="participant-v3-integrity")
    parser.add_argument("--no-video", action="store_true")
    args = parser.parse_args()
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError as error:
        raise SystemExit("Install huggingface_hub with: python -m pip install huggingface_hub") from error

    token = os.getenv("HF_TOKEN") or None
    api = HfApi(token=token)
    commit = api.dataset_info(args.hf_repo, revision=args.hf_revision).sha
    remote_index = Path(hf_hub_download(
        repo_id=args.hf_repo, repo_type="dataset", revision=commit,
        filename="index/attempts.jsonl", token=token,
    ))
    remote, remote_duplicates = read_rows(remote_index)
    report: dict[str, object] = {
        "schema_version": 2,
        "repo_id": args.hf_repo,
        "requested_revision": args.hf_revision,
        "pinned_commit": commit,
        "remote_duplicate_attempt_ids": remote_duplicates,
        "missing_remote": [],
        "missing_local": [],
        "mismatches": [],
    }

    with tempfile.TemporaryDirectory(prefix="ui-rater-reconcile-") as temp:
        export = Path(temp) / "export"
        copy_participant_export(
            Path(args.participants_dir).resolve(), export, require_video=not args.no_video,
        )
        local, local_duplicates = read_rows(export / "index/attempts.jsonl")
        report["local_duplicate_attempt_ids"] = local_duplicates
        report["missing_remote"] = sorted(set(local) - set(remote))
        report["missing_local"] = sorted(set(remote) - set(local))
        mismatches: list[dict] = []
        for attempt_id in sorted(set(local) & set(remote)):
            local_row = local[attempt_id]
            remote_row = remote[attempt_id]
            if local_row.get("artifact_root_sha256") != remote_row.get("artifact_root_sha256"):
                mismatches.append({"attempt_id": attempt_id, "kind": "artifact_root"})
                continue
            artifact_path = safe_repo_path(remote_row.get("artifact_path"))
            manifest_name = f"{artifact_path}/artifact-manifest.json"
            remote_manifest_path = Path(hf_hub_download(
                repo_id=args.hf_repo, repo_type="dataset", revision=commit,
                filename=manifest_name, token=token,
            ))
            if checksum(remote_manifest_path) != remote_row.get("artifact_manifest_sha256"):
                mismatches.append({"attempt_id": attempt_id, "kind": "manifest_checksum"})
                continue
            manifest = json.loads(remote_manifest_path.read_text(encoding="utf-8"))
            root_input = {key: value for key, value in manifest.items() if key != "root_sha256"}
            if (canonical_sha256(root_input) != manifest.get("root_sha256")
                    or manifest.get("root_sha256") != remote_row.get("artifact_root_sha256")):
                mismatches.append({"attempt_id": attempt_id, "kind": "manifest_root"})
                continue
            expected_paths = {record["path"] for record in manifest.get("files", [])}
            remote_entries = api.list_repo_tree(
                args.hf_repo, path_in_repo=artifact_path, recursive=True,
                revision=commit, repo_type="dataset", token=token,
            )
            actual_paths = {
                PurePosixPath(entry.path).relative_to(artifact_path).as_posix()
                for entry in remote_entries if entry.__class__.__name__ == "RepoFile"
            }
            if actual_paths != expected_paths | {"artifact-manifest.json"}:
                mismatches.append({
                    "attempt_id": attempt_id, "kind": "remote_file_set",
                    "missing": sorted(expected_paths - actual_paths),
                    "unexpected": sorted(actual_paths - expected_paths - {"artifact-manifest.json"}),
                })
                continue
            for record in manifest.get("files", []):
                remote_file = Path(hf_hub_download(
                    repo_id=args.hf_repo, repo_type="dataset", revision=commit,
                    filename=f"{artifact_path}/{safe_repo_path(record['path'])}", token=token,
                ))
                if remote_file.stat().st_size != record["bytes"] or checksum(remote_file) != record["sha256"]:
                    mismatches.append({
                        "attempt_id": attempt_id, "kind": "artifact_checksum",
                        "path": record["path"],
                    })
        report["mismatches"] = mismatches

    print(json.dumps(report, indent=2))
    failures = any(report[key] for key in (
        "remote_duplicate_attempt_ids", "local_duplicate_attempt_ids",
        "missing_remote", "missing_local", "mismatches",
    ))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
