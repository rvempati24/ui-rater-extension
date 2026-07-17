#!/usr/bin/env python3
"""Compare local participant attempts with an exact Hugging Face dataset revision."""

import argparse
import hashlib
import json
import os
from pathlib import Path


def checksum(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{digest}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--participants-dir", default="data/participants")
    parser.add_argument("--hf-repo", default="uxBench/ux-task-trace")
    parser.add_argument("--hf-revision", default="participant-v2")
    args = parser.parse_args()
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise SystemExit("Install huggingface_hub with: python -m pip install huggingface_hub") from error
    remote_file = Path(hf_hub_download(
        repo_id=args.hf_repo, repo_type="dataset", revision=args.hf_revision,
        filename="index/attempts.jsonl", token=os.getenv("HF_TOKEN") or None,
    ))
    remote = {row["attempt_id"]: row for row in map(json.loads, remote_file.read_text(encoding="utf-8").splitlines())}
    local: dict[str, Path] = {}
    root = Path(args.participants_dir).resolve()
    for file in root.glob("*/runs/*/tasks/*/attempts/*/attempt.json"):
        local[json.loads(file.read_text(encoding="utf-8"))["attempt_id"]] = file.parent
    missing_remote = sorted(set(local) - set(remote))
    missing_local = sorted(set(remote) - set(local))
    stale = []
    for attempt_id in sorted(set(local) & set(remote)):
        expected = remote[attempt_id].get("artifact_checksums") or {}
        for name in ("manifest.json", "trace.json", "recording.webm"):
            file = local[attempt_id] / name
            if name in expected and (not file.exists() or checksum(file) != expected[name]):
                stale.append({"attempt_id": attempt_id, "file": name})
    report = {"missing_remote": missing_remote, "missing_local": missing_local, "stale": stale}
    print(json.dumps(report, indent=2))
    return 1 if any(report.values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
