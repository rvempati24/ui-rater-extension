#!/usr/bin/env python3
"""Copy legacy results/sessions/recordings into participant-v2 folders."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
from datetime import datetime, timezone


REPO_ROOT = Path(__file__).resolve().parents[1]


def write_json(path: Path, value: dict, apply: bool):
    if apply:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def resolve_trial_state(data_dir: Path, participant_id: str, position: int, trial: dict) -> dict:
    session_id = trial.get("session_id")
    source_session = data_dir / "sessions" / str(session_id)
    has_outcome_fields = any(trial.get(key) for key in (
        "outcome", "attempt_status", "task_status"
    ))
    if has_outcome_fields:
        outcome = trial.get("outcome")
        attempt_status = trial.get("attempt_status")
        task_status = trial.get("task_status") or {
            "succeeded": "completed", "skipped": "skipped",
            "failed_no_retry": "failed_no_retry",
        }.get(outcome, "pending")
    else:
        outcome = "succeeded" if trial.get("completed") else None
        attempt_status = "accepted" if trial.get("completed") else None
        task_status = "completed" if trial.get("completed") else "pending"
    has_session = bool(session_id and source_session.is_dir())
    if task_status == "completed":
        if attempt_status != "accepted" or not has_session:
            raise ValueError(
                f"{participant_id} task {position}: completed requires an accepted attempt "
                "with an existing session directory"
            )
        if outcome not in (None, "succeeded"):
            raise ValueError(
                f"{participant_id} task {position}: completed conflicts with outcome {outcome}"
            )
        outcome = "succeeded"
    elif attempt_status == "accepted":
        raise ValueError(
            f"{participant_id} task {position}: accepted attempt requires completed task"
        )
    return {
        "session_id": session_id,
        "source_session": source_session,
        "outcome": outcome,
        "attempt_status": attempt_status,
        "task_status": task_status,
        "has_attempt": bool(
            has_session and attempt_status in {"accepted", "failed", "invalidated"}
        ),
    }


def migrate(data_dir: Path, apply: bool = False) -> dict:
    results_file = data_dir / "results.json"
    results = json.loads(results_file.read_text(encoding="utf-8")) if results_file.exists() else {}
    summary = {"participants": 0, "runs": 0, "attempts": 0, "skipped": 0, "apply": apply}
    now = datetime.now(timezone.utc).isoformat()
    for participant_id, participant_data in sorted(results.items()):
        trials = participant_data.get("trials") or []
        if not trials:
            continue
        run_id = f"legacy-{participant_id}"
        participant_root = data_dir / "participants" / participant_id
        run_root = participant_root / "runs" / run_id
        if (run_root / "run.json").exists():
            summary["skipped"] += 1
            continue
        # Validate the entire participant before writing any destination files.
        resolved_trials = [
            resolve_trial_state(data_dir, participant_id, position, trial)
            for position, trial in enumerate(trials, start=1)
        ]
        summary["participants"] += 1
        summary["runs"] += 1
        task_statuses: list[str] = []
        write_json(participant_root / "participant.json", {
            "schema_version": 2, "participant_id": participant_id, "status": "active",
            "active_run_id": run_id, "created_at": now, "updated_at": now,
        }, apply)
        for position, (trial, resolved) in enumerate(zip(trials, resolved_trials), start=1):
            assignment_id = f"legacy-asg-{position:03d}"
            task_root = run_root / "tasks" / f"{position:03d}-{assignment_id}"
            session_id = resolved["session_id"]
            source_session = resolved["source_session"]
            outcome = resolved["outcome"]
            attempt_status = resolved["attempt_status"]
            task_status = resolved["task_status"]
            has_attempt = resolved["has_attempt"]
            task_statuses.append(task_status)
            attempt_id = f"legacy-att-{position:03d}"
            task = {
                "schema_version": 2, "assignment_id": assignment_id, "run_id": run_id,
                "participant_id": participant_id, "position": position, "source_position": position,
                "task_prompt": trial.get("task_prompt", ""), "site_url": trial.get("site_url", ""),
                "group": trial.get("group", ""), "slug": trial.get("slug", ""),
                "app_id": trial.get("task_app", ""),
            }
            task["status"] = task_status
            if outcome:
                task.update({
                    "outcome": outcome,
                    "reason": trial.get("outcome_reason"),
                    "outcome_at": trial.get("outcome_at") or trial.get("timestamp") or now,
                })
            if attempt_status == "accepted" and has_attempt:
                task["accepted_attempt_id"] = attempt_id
            write_json(task_root / "task.json", task, apply)
            if not has_attempt:
                continue
            summary["attempts"] += 1
            attempt_root = task_root / "attempts" / f"001-{attempt_id}"
            if apply:
                shutil.copytree(source_session, attempt_root, dirs_exist_ok=True)
                recording_candidates = [
                    data_dir / "recordings" / f"{participant_id}_task{position}.webm",
                    data_dir / "recordings" / f"{participant_id}-trial-{position}.webm",
                ]
                recording = next((path for path in recording_candidates if path.exists()), None)
                if recording:
                    shutil.copy2(recording, attempt_root / "recording.webm")
            write_json(attempt_root / "attempt.json", {
                "schema_version": 2, "attempt_id": attempt_id, "assignment_id": assignment_id,
                "run_id": run_id, "participant_id": participant_id, "attempt_number": 1,
                "session_id": session_id, "status": attempt_status,
                "started_at": trial.get("view_start") or now,
                "evidence_completed_at": trial.get("outcome_at") or trial.get("timestamp") or now,
                "status_updated_at": trial.get("outcome_at") or trial.get("timestamp") or now,
                "outcome": outcome,
                "reason": trial.get("outcome_reason"),
                "outcome_at": trial.get("outcome_at") or trial.get("timestamp") or now,
                "migration": {"source": "data/results.json"},
            }, apply)
        terminal = {"completed", "skipped", "failed_no_retry"}
        run_completed = bool(task_statuses) and all(status in terminal for status in task_statuses)
        summary_by_status = {
            status: task_statuses.count(status)
            for status in ("completed", "skipped", "failed_no_retry")
        }
        write_json(run_root / "run.json", {
            "schema_version": 2, "run_id": run_id, "participant_id": participant_id,
            "status": "completed" if run_completed else "active",
            "created_at": now, "completed_at": now if run_completed else None,
            "outcome": "all_tasks_terminal" if run_completed else None,
            "reason": "tasks_terminal" if run_completed else None,
            "outcome_at": now if run_completed else None,
            "outcome_summary": summary_by_status if run_completed else None,
            "task_count": len(trials), "migration": {"source": "data/results.json"},
        }, apply)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(REPO_ROOT / "data"))
    parser.add_argument("--apply", action="store_true", help="Write copied participant-v2 data")
    args = parser.parse_args()
    summary = migrate(Path(args.data_dir).resolve(), apply=args.apply)
    print(json.dumps(summary, indent=2))
    if not args.apply:
        print("Dry run only. Re-run with --apply to copy data; legacy files are never deleted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
