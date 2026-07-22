#!/usr/bin/env python3
"""Run a controlled Method 1/3 UX-analysis experiment with optional ablations."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

try:
    from scripts.run_agent_analysis import prompt_for
    from scripts.run_direct_analysis import direct_prompt
    from scripts.ux_evidence import (
        atomic_write_json, exclusive_file_lock, load_evidence_manifest,
        resolve_case_dir, sha256_file, validate_case_integrity,
    )
except ModuleNotFoundError:
    from run_agent_analysis import prompt_for
    from run_direct_analysis import direct_prompt
    from ux_evidence import (
        atomic_write_json, exclusive_file_lock, load_evidence_manifest,
        resolve_case_dir, sha256_file, validate_case_integrity,
    )


REPO_ROOT = Path(__file__).resolve().parents[1]
METHODS = {
    "1": {
        "name": "agent-selective-evidence",
        "script": "run_agent_analysis.py",
        "args": ["--condition", "evidence-only"],
        "primary": True,
    },
    "2": {
        "name": "agent-selective-source",
        "script": "run_agent_analysis.py",
        "args": ["--condition", "source-explore"],
        "primary": False,
    },
    "3": {
        "name": "direct-full-context",
        "script": "run_direct_analysis.py",
        "args": ["--condition", "full"],
        "primary": True,
    },
    "4": {
        "name": "direct-trace-only",
        "script": "run_direct_analysis.py",
        "args": ["--condition", "trace-only"],
        "primary": False,
    },
}


def parse_methods(value: str) -> list[str]:
    if value.strip().lower() == "all":
        return list(METHODS)
    methods = [item.strip() for item in value.split(",") if item.strip()]
    unknown = set(methods) - set(METHODS)
    if unknown or not methods:
        raise ValueError(f"Unknown experiment methods: {sorted(unknown)}")
    return list(dict.fromkeys(methods))


def parse_summary(stdout: str) -> dict:
    for line in reversed(stdout.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return {}


def normalize_method_summary(summary: dict, method: str) -> dict:
    """Normalize the Codex multi-condition envelope and direct single result."""
    if method not in {"1", "2"}:
        return summary
    expected = "evidence-only" if method == "1" else "source-explore"
    result = next((
        item for item in summary.get("results", [])
        if isinstance(item, dict) and item.get("condition") == expected
    ), {})
    return {
        **result,
        "ok": result.get("ok") is True,
        "analysis_run_id": summary.get("analysis_run_id"),
        "experiment_id": summary.get("experiment_id"),
    }


def git_state() -> dict:
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True,
        capture_output=True, check=False,
    ).stdout.strip()
    dirty = bool(subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"], cwd=REPO_ROOT,
        text=True, capture_output=True, check=False,
    ).stdout.strip())
    return {"commit": commit or None, "dirty": dirty}


def method_prompt(case_dir: Path, method: str) -> str:
    if method in {"1", "2"}:
        condition = "evidence-only" if method == "1" else "source-explore"
        instructions = (case_dir / "contract" / "instructions.md").read_text(encoding="utf-8")
        return instructions + "\n" + prompt_for(condition)
    return direct_prompt("full" if method == "3" else "trace-only")


def command_for(args: argparse.Namespace, method: str, repetition: int, experiment_id: str) -> list[str]:
    specification = METHODS[method]
    command = [
        sys.executable, str(REPO_ROOT / "scripts" / specification["script"]),
        "--case", str(args.case),
        *specification["args"],
        "--model", args.model,
        "--reasoning-effort", args.reasoning_effort,
        "--timeout", str(args.timeout),
        "--experiment-id", experiment_id,
        "--repetition", str(repetition),
    ]
    if method in {"3", "4"}:
        command.extend(["--max-input-bytes", str(args.max_input_bytes)])
        if args.base_url:
            command.extend(["--base-url", args.base_url])
        if args.api_key_file:
            command.extend(["--api-key-file", args.api_key_file])
    elif args.codex_command:
        command.extend(["--codex-command", args.codex_command])
    return command


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True, type=Path)
    parser.add_argument("--methods", default="1,3", help="comma-separated 1,2,3,4 or all")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--reasoning-effort", default="medium")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--max-input-bytes", type=int, default=100 * 1024 * 1024)
    parser.add_argument("--codex-command", default=os.getenv("UI_RATER_CODEX_COMMAND", "codex"))
    parser.add_argument("--base-url", default=os.getenv("UI_RATER_PROXY_BASE_URL"))
    parser.add_argument("--api-key-file", default=".local-tools/cliproxyapi/api-key")
    parser.add_argument("--experiment-id")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be at least 1")
    methods = parse_methods(args.methods)
    case_dir = resolve_case_dir(args.case)
    # Pin every child command to this immutable revision. A later update to the
    # case root's latest pointer cannot change the experiment midway through.
    args.case = case_dir
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    integrity = validate_case_integrity(case_dir, case)
    evidence = load_evidence_manifest(case_dir, case)
    experiment_id = args.experiment_id or (
        f"exp_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"
    )
    commands = [
        {"method": method, "repetition": repetition,
         "command": command_for(args, method, repetition, experiment_id)}
        for repetition in range(1, args.repetitions + 1)
        for method in methods
    ]
    if args.dry_run:
        print(json.dumps({"experiment_id": experiment_id, "commands": commands}, indent=2))
        return 0

    experiments_root = case_dir / "output" / "experiments"
    experiment_dir = experiments_root / experiment_id
    with exclusive_file_lock(experiments_root / ".experiments.lock"):
        if experiment_dir.exists():
            raise FileExistsError(f"Experiment ID already exists: {experiment_id}")
        experiment_dir.mkdir(parents=True)

    started = datetime.now(timezone.utc)
    results = []
    for item in commands:
        completed = subprocess.run(
            item["command"], cwd=REPO_ROOT, text=True, capture_output=True, check=False,
        )
        summary = normalize_method_summary(parse_summary(completed.stdout), item["method"])
        output = Path(summary["output"]) if summary.get("output") else None
        metadata_path = output.parent / "run-metadata.json" if output else None
        metadata = json.loads(metadata_path.read_text(encoding="utf-8")) \
            if metadata_path and metadata_path.is_file() else {}
        results.append({
            "method": item["method"],
            "method_name": METHODS[item["method"]]["name"],
            "primary": METHODS[item["method"]]["primary"],
            "repetition": item["repetition"],
            "ok": completed.returncode == 0 and summary.get("ok") is True,
            "ineligible": summary.get("ineligible") is True,
            "exit_code": completed.returncode,
            "analysis_run_id": summary.get("analysis_run_id"),
            "output": str(output) if output else None,
            "metadata": str(metadata_path) if metadata_path and metadata_path.is_file() else None,
            "resolved_model": metadata.get("resolved_model"),
            "usage": metadata.get("usage"),
            "inspected_snapshot_ids": metadata.get("inspected_snapshot_ids", []),
            "error": summary.get("error") or (completed.stderr[-2_000:] if completed.returncode else None),
        })

    primary = [result for result in results if result["primary"]]
    requested_primary = {method for method in methods if METHODS[method]["primary"]}
    comparison_eligible = (
        requested_primary == {"1", "3"}
        and integrity.get("verified") is True
        and bool(evidence.get("root_sha256"))
        and case.get("artifact_verification", {}).get("verified") is True
        and all(result["ok"] for result in primary)
        and all(
            json.loads(Path(result["metadata"]).read_text(encoding="utf-8"))
            .get("comparison_eligible") is True
            for result in primary
            if result.get("metadata")
        )
        and all(result.get("metadata") for result in primary)
        and len({result.get("resolved_model") for result in primary}) == 1
        and all(result.get("resolved_model") == args.model for result in primary)
    )
    prompts = {
        method: {
            "text": method_prompt(case_dir, method),
            "sha256": hashlib.sha256(method_prompt(case_dir, method).encode("utf-8")).hexdigest(),
        }
        for method in methods
    }
    manifest = {
        "schema_version": 1,
        "experiment_id": experiment_id,
        "status": "complete" if all(result["ok"] for result in results) else "partial_or_failed",
        "comparison_eligible": comparison_eligible,
        "started_at": started.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "attempt_id": case.get("attempt_id"),
        "case_revision_id": case.get("case_revision_id"),
        "case_integrity": integrity,
        "evidence_manifest_sha256": sha256_file(
            case_dir / case.get("evidence_manifest", "evidence-manifest.json")
        ),
        "evidence_root_sha256": evidence.get("root_sha256"),
        "website_source": case.get("source_verification"),
        "model": args.model,
        "reasoning_effort": args.reasoning_effort,
        "repetitions": args.repetitions,
        "methods": methods,
        "prompts": prompts,
        "available_snapshot_ids": [item["snapshot_id"] for item in evidence.get("snapshots", [])],
        "git": git_state(),
        "results": results,
    }
    atomic_write_json(experiment_dir / "experiment.json", manifest)
    if comparison_eligible:
        latest = case_dir / "output" / "experiments" / "latest-success.json"
        with exclusive_file_lock(latest.with_suffix(".lock")):
            atomic_write_json(latest, {
                "schema_version": 1, "experiment_id": experiment_id,
                "path": f"{experiment_id}/experiment.json",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
    print(json.dumps({
        "ok": all(result["ok"] for result in results),
        "comparison_eligible": comparison_eligible,
        "experiment_id": experiment_id,
        "manifest": str(experiment_dir / "experiment.json"),
        "results": results,
    }))
    return 0 if all(result["ok"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
