#!/usr/bin/env python3
"""Read-only integrity audit for canonical participant evidence."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TERMINAL_TASKS = {"completed", "skipped", "failed_no_retry"}


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def audit(participants_dir: Path) -> dict[str, Any]:
    participants_dir = participants_dir.resolve()
    issues: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    counts = {"participants": 0, "runs": 0, "tasks": 0, "attempts": 0, "snapshots": 0}

    def report(code: str, path: Path, message: str, warning: bool = False) -> None:
        target = warnings if warning else issues
        try:
            relative = path.relative_to(participants_dir).as_posix()
        except ValueError:
            relative = str(path)
        target.append({"code": code, "path": relative, "message": message})

    if not participants_dir.is_dir():
        report("participants_missing", participants_dir, "participants directory does not exist")
    else:
        for participant_dir in sorted(participants_dir.iterdir()):
            if participant_dir.name.startswith("."):
                continue
            if participant_dir.is_symlink() or not participant_dir.is_dir():
                report("unsafe_participant_path", participant_dir, "participant entry is not a real directory")
                continue
            participant_file = participant_dir / "participant.json"
            try:
                participant = load_json(participant_file)
                participant_id = str(participant.get("participant_id") or "")
                if not SAFE_ID.fullmatch(participant_id) or participant_id != participant_dir.name:
                    raise ValueError("participant_id is unsafe or differs from its directory")
            except (OSError, ValueError, json.JSONDecodeError) as error:
                report("participant_invalid", participant_file, str(error))
                continue
            counts["participants"] += 1
            for candidate in participant_dir.rglob("*"):
                if candidate.is_symlink():
                    report("evidence_symlink", candidate, "canonical evidence contains a symlink")
            runs_root = participant_dir / "runs"
            if not runs_root.is_dir():
                continue
            for run_dir in sorted(runs_root.iterdir()):
                if run_dir.name.startswith("."):
                    continue
                if run_dir.is_symlink() or not run_dir.is_dir():
                    report("unsafe_run_path", run_dir, "run entry is not a real directory")
                    continue
                run_file = run_dir / "run.json"
                try:
                    run = load_json(run_file)
                    run_id = str(run.get("run_id") or "")
                    if (not SAFE_ID.fullmatch(run_id) or run_id != run_dir.name
                            or run.get("participant_id") != participant_id):
                        raise ValueError("run ownership or directory identity is inconsistent")
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    report("run_invalid", run_file, str(error))
                    continue
                counts["runs"] += 1
                tasks_root = run_dir / "tasks"
                task_states: list[str] = []
                positions: set[int] = set()
                task_count = 0
                if not tasks_root.is_dir():
                    report("tasks_missing", tasks_root, "run has no tasks directory")
                    continue
                for task_dir in sorted(tasks_root.iterdir()):
                    if task_dir.name.startswith("."):
                        continue
                    if task_dir.is_symlink() or not task_dir.is_dir():
                        report("unsafe_task_path", task_dir, "task entry is not a real directory")
                        continue
                    task_file = task_dir / "task.json"
                    try:
                        task = load_json(task_file)
                        assignment_id = str(task.get("assignment_id") or "")
                        position = task.get("position")
                        if (not SAFE_ID.fullmatch(assignment_id)
                                or task.get("participant_id") != participant_id
                                or task.get("run_id") != run_id
                                or not isinstance(position, int) or position < 1):
                            raise ValueError("task ownership, ID, or position is invalid")
                        if position in positions:
                            raise ValueError("task position is duplicated")
                        positions.add(position)
                        expected_name = f"{position:03d}-{assignment_id}"
                        if task_dir.name != expected_name:
                            raise ValueError(f"task directory must be {expected_name}")
                    except (OSError, ValueError, json.JSONDecodeError) as error:
                        report("task_invalid", task_file, str(error))
                        continue
                    counts["tasks"] += 1
                    task_count += 1
                    task_status = str(task.get("status") or "pending")
                    task_states.append(task_status)
                    attempts_root = task_dir / "attempts"
                    accepted: list[str] = []
                    if attempts_root.is_dir():
                        for attempt_dir in sorted(attempts_root.iterdir()):
                            if attempt_dir.name.startswith("."):
                                continue
                            if attempt_dir.is_symlink() or not attempt_dir.is_dir():
                                report("unsafe_attempt_path", attempt_dir, "attempt entry is not a real directory")
                                continue
                            attempt_file = attempt_dir / "attempt.json"
                            try:
                                attempt = load_json(attempt_file)
                                attempt_id = str(attempt.get("attempt_id") or "")
                                if (not SAFE_ID.fullmatch(attempt_id)
                                        or attempt.get("participant_id") != participant_id
                                        or attempt.get("run_id") != run_id
                                        or attempt.get("assignment_id") != assignment_id):
                                    raise ValueError("attempt ownership or ID is invalid")
                                attempt_number = attempt.get("attempt_number")
                                expected_name = (f"{attempt_number:03d}-{attempt_id}"
                                                 if isinstance(attempt_number, int) else "")
                                if attempt_number is None or attempt_dir.name != expected_name:
                                    raise ValueError(f"attempt directory must be {expected_name or 'number-ID'}")
                            except (OSError, ValueError, json.JSONDecodeError) as error:
                                report("attempt_invalid", attempt_file, str(error))
                                continue
                            counts["attempts"] += 1
                            if attempt.get("status") == "accepted":
                                accepted.append(attempt_id)
                            manifest_file = attempt_dir / "manifest.json"
                            trace_file = attempt_dir / "trace.json"
                            if not manifest_file.is_file() or not trace_file.is_file():
                                if attempt.get("status") == "accepted":
                                    report("accepted_evidence_missing", attempt_dir, "accepted attempt lacks manifest or trace")
                                continue
                            try:
                                manifest = load_json(manifest_file)
                                trace = load_json(trace_file)
                            except (OSError, ValueError, json.JSONDecodeError) as error:
                                report("evidence_json_invalid", attempt_dir, str(error))
                                continue
                            if manifest.get("session_id") != attempt.get("session_id"):
                                report("session_mismatch", manifest_file, "manifest and attempt session IDs differ")
                            events = trace.get("interactions")
                            if not isinstance(events, list):
                                report("trace_invalid", trace_file, "interactions must be an array")
                                events = []
                            seen_event_ids: set[str] = set()
                            previous_seq = 0
                            for index, event in enumerate(events):
                                if not isinstance(event, dict):
                                    report("trace_event_invalid", trace_file, f"event {index} is not an object")
                                    continue
                                seq = event.get("seq")
                                if not isinstance(seq, int) or seq <= previous_seq:
                                    report("trace_sequence_invalid", trace_file, f"event {index} has non-increasing seq")
                                else:
                                    previous_seq = seq
                                event_id = event.get("event_id")
                                if isinstance(event_id, str):
                                    if event_id in seen_event_ids:
                                        report("trace_event_duplicate", trace_file, f"duplicate event_id {event_id}")
                                    seen_event_ids.add(event_id)
                                elif manifest.get("schema_version") == 2:
                                    report("trace_event_id_missing", trace_file, f"event {index} has no event_id")
                            if (manifest.get("interaction_count") is not None
                                    and manifest.get("interaction_count") != len(events)):
                                report("interaction_count_mismatch", manifest_file, "manifest count differs from trace")
                            snapshot_root = attempt_dir / "snapshots"
                            snapshot_bytes = 0
                            snapshot_count = 0
                            reasons: set[str] = set()
                            if snapshot_root.is_dir():
                                metadata_files = sorted(snapshot_root.glob("*.json"))
                                image_files = sorted(snapshot_root.glob("*.jpg"))
                                metadata_stems = {path.stem for path in metadata_files}
                                image_stems = {path.stem for path in image_files}
                                for orphan in sorted(image_stems - metadata_stems):
                                    report(
                                        "snapshot_metadata_missing", snapshot_root / f"{orphan}.json",
                                        "snapshot JPEG has no metadata pair",
                                    )
                                for metadata_file in metadata_files:
                                    if metadata_file.is_symlink():
                                        report("snapshot_symlink", metadata_file, "snapshot metadata is a symlink")
                                        continue
                                    image = metadata_file.with_suffix(".jpg")
                                    try:
                                        metadata = load_json(metadata_file)
                                    except (OSError, ValueError, json.JSONDecodeError) as error:
                                        report("snapshot_metadata_invalid", metadata_file, str(error))
                                        continue
                                    if metadata.get("snapshot_id") != metadata_file.stem:
                                        report("snapshot_id_mismatch", metadata_file, "snapshot_id differs from filename")
                                    if metadata.get("image_file") not in (None, f"snapshots/{metadata_file.stem}.jpg"):
                                        report("snapshot_path_mismatch", metadata_file, "image_file differs from its JPEG pair")
                                    if image.is_symlink() or not image.is_file():
                                        report("snapshot_image_missing", image, "snapshot JPEG is absent or unsafe")
                                        continue
                                    snapshot_count += 1
                                    snapshot_bytes += image.stat().st_size
                                    reasons.add(str(metadata.get("reason") or ""))
                            counts["snapshots"] += snapshot_count
                            if (manifest.get("snapshot_count") is not None
                                    and manifest.get("snapshot_count") != snapshot_count):
                                report("snapshot_count_mismatch", manifest_file, "manifest count differs from snapshot pairs")
                            if (manifest.get("snapshot_bytes") is not None
                                    and manifest.get("snapshot_bytes") != snapshot_bytes):
                                report("snapshot_bytes_mismatch", manifest_file, "manifest bytes differ from JPEG total")
                            if attempt.get("status") == "accepted" and manifest.get("schema_version") == 2:
                                timing = manifest.get("recording_timing")
                                timing_values = [
                                    timing.get(key) if isinstance(timing, dict) else None
                                    for key in ("video_start_epoch_ms", "trace_origin_epoch_ms",
                                                "trace_to_video_offset_ms", "video_stop_epoch_ms")
                                ]
                                if (not all(isinstance(value, int) for value in timing_values)
                                        or timing_values[2] != timing_values[1] - timing_values[0]
                                        or timing_values[3] <= timing_values[0]):
                                    report("recording_timing_invalid", manifest_file,
                                           "accepted v2 attempt lacks consistent start/trace/stop timing")
                                finalization = manifest.get("finalization_report")
                                if not isinstance(finalization, dict):
                                    finalization = {}
                                if finalization.get("interaction_flush") != "acknowledged":
                                    report("final_trace_unacknowledged", manifest_file, "accepted v2 attempt lacks final trace acknowledgement")
                                if finalization.get("task_end_snapshot") != "acknowledged":
                                    report("final_snapshot_unacknowledged", manifest_file, "accepted v2 attempt lacks final screenshot acknowledgement")
                                if "task-end" not in reasons:
                                    report("task_end_snapshot_missing", snapshot_root, "accepted v2 attempt lacks task-end screenshot")
                                if manifest.get("final_flush_status") != "complete":
                                    report("final_flush_incomplete", manifest_file, "accepted v2 attempt has incomplete final flush")
                                if (manifest.get("attempt_status") != "accepted"
                                        or manifest.get("task_status") != "completed"):
                                    report("manifest_state_mismatch", manifest_file, "accepted attempt projection is inconsistent")
                            elif attempt.get("status") == "accepted":
                                report("legacy_evidence", manifest_file, "accepted attempt predates the v2 integrity contract", warning=True)
                            recording = attempt_dir / "recording.webm"
                            if attempt.get("status") == "accepted" and (
                                recording.is_symlink() or not recording.is_file()
                                or recording.stat().st_size == 0
                            ):
                                report("recording_missing", attempt_dir, "accepted attempt lacks a non-empty recording.webm")
                    pointer = task.get("accepted_attempt_id")
                    if task_status == "completed":
                        if len(accepted) != 1 or pointer != accepted[0]:
                            report("accepted_pointer_invalid", task_file, "completed task must point to exactly one accepted attempt")
                    elif pointer or accepted:
                        report("accepted_on_noncompleted_task", task_file, "non-completed task contains accepted evidence")
                declared_task_count = run.get("task_count")
                if isinstance(declared_task_count, int) and declared_task_count != task_count:
                    report("run_task_count_mismatch", run_file, "run task_count differs from task directories")
                all_terminal = bool(task_states) and all(state in TERMINAL_TASKS for state in task_states)
                if run.get("status") == "completed" and not all_terminal:
                    report("completed_run_invalid", run_file, "completed run contains a non-terminal task")
                if run.get("status") == "active" and all_terminal:
                    report("active_run_terminal", run_file, "active run contains only terminal tasks")

    return {
        "schema_version": 1,
        "ok": not issues,
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "participants_dir": str(participants_dir),
        "counts": counts,
        "issues": issues,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--participants-dir", default=str(REPO_ROOT / "data" / "participants"))
    args = parser.parse_args()
    report = audit(Path(args.participants_dir))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
