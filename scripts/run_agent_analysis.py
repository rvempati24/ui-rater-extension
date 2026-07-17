#!/usr/bin/env python3
"""Run a configured coding-agent CLI against a materialized read-only case."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
from datetime import datetime, timezone


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(path for path in root.rglob("*") if path.is_file()):
        digest.update(file.relative_to(root).as_posix().encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()


def command_for(adapter: str, override: str | None, prompt: str) -> list[str]:
    if override:
        base = shlex.split(override, posix=os.name != "nt")
    elif adapter == "opencode":
        base = shlex.split(os.getenv("UI_RATER_OPENCODE_COMMAND", "opencode run"), posix=os.name != "nt")
    else:
        base = shlex.split(os.getenv("UI_RATER_CLAUDE_COMMAND", "claude -p"), posix=os.name != "nt")
    if not base or not shutil.which(base[0]):
        raise FileNotFoundError(f"Agent executable not found: {base[0] if base else adapter}")
    return [*base, prompt]


def safe_environment(pass_names: list[str]) -> dict[str, str]:
    allowed = {
        "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE",
        "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG", "LC_ALL", "TERM",
    }
    allowed.update(pass_names)
    blocked = {"HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"}
    return {key: value for key, value in os.environ.items() if key in allowed and key not in blocked}


def validate_findings(case_dir: Path, case: dict, findings: dict) -> None:
    if findings.get("schema_version") != 2 or findings.get("attempt_id") != case.get("attempt_id"):
        raise ValueError("Output schema_version/attempt_id does not match case.json")
    trace = json.loads((case_dir / case["evidence"]["trace"]).read_text(encoding="utf-8"))
    events = trace.get("interactions", trace if isinstance(trace, list) else [])
    event_ids = {event.get("seq") for event in events if isinstance(event, dict)}
    snapshot_ids = {Path(path).stem for path in case["evidence"].get("snapshots", [])}
    source_root = (case_dir / case["source_root"]).resolve()
    for finding in findings.get("findings", []):
        evidence = finding.get("evidence") or {}
        unknown_events = set(evidence.get("event_seq") or []) - event_ids
        unknown_snapshots = set(evidence.get("snapshot_ids") or []) - snapshot_ids
        if unknown_events or unknown_snapshots:
            raise ValueError(f"Finding cites unknown evidence: events={unknown_events}, snapshots={unknown_snapshots}")
        for relative in finding.get("source_paths") or []:
            candidate = (source_root / relative).resolve()
            if source_root not in candidate.parents or not candidate.is_file():
                raise ValueError(f"Finding cites invalid source path: {relative}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True)
    parser.add_argument("--adapter", choices=["opencode", "claude"], required=True)
    parser.add_argument("--command", help="Override CLI prefix; prompt is appended as the final argument")
    parser.add_argument("--pass-env", action="append", default=[], help="Explicit environment variable to pass")
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    case_dir = Path(args.case).resolve()
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    instructions = (case_dir / "contract" / "instructions.md").read_text(encoding="utf-8")
    prompt = (
        f"{instructions}\nCase root: {case_dir}\n"
        "Read case.json first. Treat evidence/ and website/ as read-only. "
        "Write only output/findings.json."
    )
    before = {name: tree_digest(case_dir / name) for name in ("evidence", "website")}
    started = datetime.now(timezone.utc)
    command = command_for(args.adapter, args.command, prompt)
    result = subprocess.run(
        command, cwd=case_dir, env=safe_environment(args.pass_env),
        text=True, capture_output=True, timeout=args.timeout, check=False,
    )
    after = {name: tree_digest(case_dir / name) for name in ("evidence", "website")}
    if before != after:
        raise SystemExit("Agent modified read-only evidence or website source; output rejected")
    findings_file = case_dir / "output" / "findings.json"
    if result.returncode == 0 and not findings_file.exists():
        raise SystemExit("Agent exited successfully but did not create output/findings.json")
    findings = json.loads(findings_file.read_text(encoding="utf-8")) if findings_file.exists() else None
    if findings:
        try:
            validate_findings(case_dir, case, findings)
        except ValueError as error:
            raise SystemExit(f"Agent output validation failed: {error}") from error
    metadata = {
        "schema_version": 2, "adapter": args.adapter, "command": command[:-1],
        "case_id": case.get("case_id"), "attempt_id": case.get("attempt_id"),
        "dataset": case.get("dataset"), "website": case.get("website"),
        "started_at": started.isoformat(), "completed_at": datetime.now(timezone.utc).isoformat(),
        "exit_code": result.returncode,
        "stdout_tail": result.stdout[-4000:], "stderr_tail": result.stderr[-4000:],
        "input_digests": before,
    }
    (case_dir / "output" / "run-metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"ok": result.returncode == 0, "exit_code": result.returncode, "output": str(findings_file)}))
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
