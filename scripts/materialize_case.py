#!/usr/bin/env python3
"""Materialize a UI Rater attempt and its exact website source."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile


REPO_ROOT = Path(__file__).resolve().parents[1]


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def find_local_attempt(participants_dir: Path, attempt_id: str) -> Path:
    index = participants_dir.parent / "index" / "attempts.jsonl"
    if index.exists():
        for line in index.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("attempt_id") == attempt_id:
                candidate = participants_dir / row["artifact_path"]
                if candidate.exists():
                    return candidate
    for candidate in participants_dir.glob("*/runs/*/tasks/*/attempts/*/attempt.json"):
        if load_json(candidate).get("attempt_id") == attempt_id:
            return candidate.parent
    raise FileNotFoundError(f"Attempt {attempt_id} was not found")


def download_hf_attempt(repo_id: str, revision: str, attempt_id: str, token: str | None, cache: Path) -> tuple[Path, str]:
    try:
        from huggingface_hub import HfApi, hf_hub_download, snapshot_download
    except ImportError as error:
        raise SystemExit("Install huggingface_hub with: python -m pip install huggingface_hub") from error
    index_file = Path(hf_hub_download(
        repo_id=repo_id, repo_type="dataset", revision=revision,
        filename="index/attempts.jsonl", token=token, cache_dir=cache,
    ))
    row = next((json.loads(line) for line in index_file.read_text(encoding="utf-8").splitlines()
                if json.loads(line).get("attempt_id") == attempt_id), None)
    if not row:
        raise FileNotFoundError(f"Attempt {attempt_id} is absent from {repo_id}@{revision}")
    artifact = Path(row["artifact_path"])
    task = artifact.parent.parent
    run = task.parent.parent
    participant = run.parent.parent
    patterns = [
        "dataset-info.json", "index/*.jsonl",
        f"{participant.as_posix()}/participant.json",
        f"{run.as_posix()}/run.json", f"{task.as_posix()}/task.json",
        f"{artifact.as_posix()}/**",
    ]
    root = Path(snapshot_download(
        repo_id=repo_id, repo_type="dataset", revision=revision, token=token,
        cache_dir=cache, allow_patterns=patterns,
    ))
    info = HfApi(token=token).dataset_info(repo_id, revision=revision)
    return root / artifact, info.sha


def parents(attempt_dir: Path) -> tuple[Path, Path, Path]:
    task_dir = attempt_dir.parent.parent
    run_dir = task_dir.parent.parent
    participant_dir = run_dir.parent.parent
    return task_dir, run_dir, participant_dir


def resolve_source(run: dict, explicit: Path | None, token: str | None, cache: Path) -> tuple[Path, str]:
    website = run.get("website") or {}
    if explicit:
        source = explicit.resolve()
        if not source.is_dir():
            raise FileNotFoundError(f"Website source does not exist: {source}")
        return source, str(website.get("commit_sha") or "explicit-local")
    local = website.get("source_dir")
    if local and Path(local).is_dir():
        return Path(local).resolve(), str(website.get("commit_sha") or "local")
    repo_id = website.get("repo_id")
    revision = website.get("revision")
    path_in_repo = website.get("path_in_repo")
    if not repo_id or not revision or not path_in_repo:
        raise FileNotFoundError("Exact website source provenance is unavailable; pass --website-source")
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise SystemExit("Install huggingface_hub with: python -m pip install huggingface_hub") from error
    root = Path(snapshot_download(
        repo_id=repo_id, repo_type="dataset", revision=revision, token=token,
        cache_dir=cache, allow_patterns=[f"{path_in_repo}/**"],
    ))
    source = root / path_in_repo
    if not source.is_dir():
        raise FileNotFoundError(f"Downloaded website path is absent: {path_in_repo}")
    return source, str(website.get("commit_sha") or revision)


def make_read_only(root: Path) -> None:
    if os.name == "nt":
        return  # Windows ACL isolation is enforced by the runner's digest check.
    for item in [root, *root.rglob("*")]:
        try:
            if item.is_dir():
                item.chmod(stat.S_IREAD | stat.S_IEXEC)
            else:
                item.chmod(stat.S_IREAD)
        except OSError:
            pass


def materialize(
    attempt_dir: Path,
    destination: Path,
    source: Path,
    dataset: dict,
    no_video: bool = False,
    audit: bool = False,
) -> dict:
    attempt = load_json(attempt_dir / "attempt.json")
    if attempt.get("status") != "accepted" and not audit:
        raise ValueError("Only accepted attempts can be materialized by default")
    allowed = {"accepted", "failed", "invalidated"} if audit else {"accepted"}
    if attempt.get("status") not in allowed:
        raise ValueError(f"Attempt status {attempt.get('status')!r} is not materializable")
    if not (attempt_dir / "trace.json").is_file():
        raise ValueError("A materialized attempt must contain trace.json")
    task_dir, run_dir, participant_dir = parents(attempt_dir)
    task = load_json(task_dir / "task.json")
    run = load_json(run_dir / "run.json")
    participant = load_json(participant_dir / "participant.json")
    target = destination.resolve()
    for protected in (attempt_dir.resolve(), source.resolve()):
        if target == protected or protected in target.parents or target in protected.parents:
            raise ValueError("Case destination must not overlap evidence or website source")
    if destination.exists():
        marker = destination / "case.json"
        if any(destination.iterdir()) and (
            not marker.exists() or load_json(marker).get("schema_version") != "2.0"
        ):
            raise ValueError("Refusing to replace a directory that is not a materialized v2 case")
        shutil.rmtree(destination)
    evidence = destination / "evidence"
    contract = destination / "contract"
    output = destination / "output"
    evidence.mkdir(parents=True)
    contract.mkdir()
    output.mkdir()
    for name, value in (("participant.json", participant), ("run.json", run), ("task.json", task)):
        (evidence / name).write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    for item in attempt_dir.iterdir():
        if no_video and item.name == "recording.webm":
            continue
        target = evidence / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    shutil.copytree(source, destination / "website", ignore=shutil.ignore_patterns(".git", "node_modules", ".next"))
    schema = {
        "type": "object", "required": ["schema_version", "attempt_id", "findings"],
        "properties": {
            "schema_version": {"const": 2}, "attempt_id": {"const": attempt["attempt_id"]},
            "findings": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "observation", "inference", "recommendation", "evidence", "source_paths"],
                "properties": {
                    "title": {"type": "string"}, "observation": {"type": "string"},
                    "inference": {"type": "string"}, "recommendation": {"type": "string"},
                    "evidence": {"type": "object", "required": ["event_seq", "snapshot_ids"],
                                 "properties": {"event_seq": {"type": "array", "items": {"type": "integer"}},
                                                "snapshot_ids": {"type": "array", "items": {"type": "string"}}}},
                    "source_paths": {"type": "array", "items": {"type": "string"}},
                },
            }},
        },
    }
    (contract / "finding.schema.json").write_text(json.dumps(schema, indent=2), encoding="utf-8")
    review_scope = "accepted task attempt" if attempt.get("status") == "accepted" else "audit task attempt"
    (contract / "instructions.md").write_text(
        f"Review this {review_scope} for usability problems.\n"
        "Cite real trace event sequence numbers and snapshot IDs. Separate observation from inference.\n"
        "Inspect source before citing paths. Recommend changes but do not edit website/.\n"
        "Write JSON matching finding.schema.json to output/findings.json.\n",
        encoding="utf-8",
    )
    snapshots = sorted(path.relative_to(destination).as_posix() for path in (evidence / "snapshots").glob("*.jpg")) if (evidence / "snapshots").exists() else []
    case = {
        "schema_version": "2.0", "case_id": attempt["attempt_id"],
        "participant_id": participant["participant_id"], "run_id": run["run_id"],
        "assignment_id": task["assignment_id"], "attempt_id": attempt["attempt_id"],
        "session_id": attempt["session_id"],
        "attempt_status": attempt.get("status"), "outcome": attempt.get("outcome"),
        "reason": attempt.get("reason"), "outcome_at": attempt.get("outcome_at"),
        "task": {
            "position": task["position"],
            "source_position": task.get("source_position"),
            "prompt": task["task_prompt"],
            "start_url": task.get("site_url", ""),
        },
        "task_status": task.get("status"),
        "website": run.get("website", {}),
        "dataset": dataset,
        "evidence": {"trace": "evidence/trace.json", "snapshots": snapshots,
                     "recording": None if no_video or not (evidence / "recording.webm").is_file()
                     else "evidence/recording.webm"},
        "source_root": "website", "output_schema": "contract/finding.schema.json",
    }
    (destination / "case.json").write_text(json.dumps(case, indent=2, ensure_ascii=False), encoding="utf-8")
    make_read_only(evidence)
    make_read_only(destination / "website")
    return case


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--participants-dir", default=str(REPO_ROOT / "data" / "participants"))
    parser.add_argument("--hf-repo")
    parser.add_argument("--hf-revision", default="participant-v2")
    parser.add_argument("--website-source")
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache-dir", default=str(REPO_ROOT / ".case-cache"))
    parser.add_argument("--no-video", action="store_true")
    parser.add_argument("--audit", action="store_true",
                        help="Explicitly allow a failed or invalidated terminal attempt")
    args = parser.parse_args()
    token = os.getenv("HF_TOKEN") or None
    cache = Path(args.cache_dir).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    if args.hf_repo:
        attempt_dir, dataset_sha = download_hf_attempt(args.hf_repo, args.hf_revision, args.attempt_id, token, cache)
        dataset = {"repo_id": args.hf_repo, "revision": args.hf_revision, "commit_sha": dataset_sha}
    else:
        attempt_dir = find_local_attempt(Path(args.participants_dir).resolve(), args.attempt_id)
        dataset = {"source": "local"}
    _, run_dir, _ = parents(attempt_dir)
    run = load_json(run_dir / "run.json")
    source, source_sha = resolve_source(run, Path(args.website_source) if args.website_source else None, token, cache)
    case = materialize(
        attempt_dir, Path(args.output).resolve(), source,
        {**dataset, "source_commit_sha": source_sha}, args.no_video, args.audit,
    )
    print(json.dumps({"ok": True, "case": str(Path(args.output).resolve()), "attempt_id": case["attempt_id"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
