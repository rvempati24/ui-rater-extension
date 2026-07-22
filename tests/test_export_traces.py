import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_traces.py"
SPEC = importlib.util.spec_from_file_location("export_traces", SCRIPT)
assert SPEC and SPEC.loader
export_traces = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(export_traces)


def write_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def make_attempt(root: Path, status="accepted") -> tuple[Path, Path]:
    participants = root / "participants"
    participant = participants / "P001"
    run = participant / "runs" / "run_001"
    task = run / "tasks" / "001-asg_001"
    attempt = task / "attempts" / "001-att_001"
    write_json(participant / "participant.json", {
        "schema_version": 2, "participant_id": "P001", "status": "active",
    })
    write_json(run / "run.json", {
        "schema_version": 2, "participant_id": "P001", "run_id": "run_001",
        "status": "completed", "website": {"model": "model", "website": "site"},
    })
    write_json(task / "task.json", {
        "schema_version": 2, "participant_id": "P001", "run_id": "run_001",
        "assignment_id": "asg_001", "position": 1, "source_position": 5,
        "task_prompt": "Do task",
        "accepted_attempt_id": "att_001" if status == "accepted" else None,
        "status": "completed" if status == "accepted" else "pending",
        "outcome": "succeeded" if status == "accepted" else "recording_problem",
    })
    write_json(attempt / "attempt.json", {
        "schema_version": 2, "participant_id": "P001", "run_id": "run_001",
        "assignment_id": "asg_001", "attempt_id": "att_001", "attempt_number": 1,
        "session_id": "session_001", "status": status,
        "outcome": "succeeded" if status == "accepted" else "recording_problem",
    })
    write_json(attempt / "manifest.json", {
        "session_id": "session_001", "status": "complete",
        "recording_timing": {
            "schema_version": 1, "clock": "unix-epoch-ms",
            "video_start_epoch_ms": 1_780_000_000_000,
            "trace_origin_epoch_ms": 1_780_000_000_100,
            "trace_to_video_offset_ms": 100,
            "start_source": "mediarecorder-start-event",
            "video_stop_epoch_ms": 1_780_000_001_000,
            "capture_profile": {"profile_id": "tab-vp8-30fps-v1", "frame_rate": 30}
        }
    })
    write_json(attempt / "trace.json", {"interactions": [{"seq": 1}]})
    (attempt / "recording.webm").write_bytes(b"video")
    write_json(attempt / "snapshots" / "s0001.json", {"snapshot_id": "s0001"})
    (attempt / "snapshots" / "s0001.jpg").write_bytes(b"jpeg")
    return participants, attempt


class ExportTraceTests(unittest.TestCase):
    def test_rejects_broken_accepted_pointer_and_multiple_accepted_attempts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root)
            task_file = attempt.parent.parent / "task.json"
            task = json.loads(task_file.read_text())
            task["accepted_attempt_id"] = "att_missing"
            write_json(task_file, task)
            with self.assertRaisesRegex(ValueError, "accepted_attempt_id"):
                export_traces.copy_participant_export(participants, root / "bad-pointer")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root)
            duplicate = attempt.parent / "002-att_002"
            __import__("shutil").copytree(attempt, duplicate)
            metadata = json.loads((duplicate / "attempt.json").read_text())
            metadata["attempt_id"] = "att_002"
            metadata["attempt_number"] = 2
            write_json(duplicate / "attempt.json", metadata)
            with self.assertRaisesRegex(ValueError, "multiple accepted"):
                export_traces.copy_participant_export(participants, root / "duplicate")

    def test_exports_participant_first_accepted_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, _ = make_attempt(root)
            destination = root / "export"
            rows = export_traces.copy_participant_export(participants, destination)
            target = destination / "participants/P001/runs/run_001/tasks/001-asg_001/attempts/001-att_001"
            self.assertTrue((target / "trace.json").exists())
            self.assertEqual(rows[0]["artifact_path"], target.relative_to(destination).as_posix())
            self.assertIn("recording.webm", rows[0]["artifact_checksums"])
            self.assertTrue(rows[0]["artifact_root_sha256"])
            artifact_manifest = json.loads((target / "artifact-manifest.json").read_text())
            self.assertEqual(artifact_manifest["root_sha256"], rows[0]["artifact_root_sha256"])
            self.assertFalse(any(
                record["path"] == "artifact-manifest.json"
                for record in artifact_manifest["files"]
            ))
            self.assertEqual(rows[0]["task_source_position"], 5)
            self.assertEqual(len((destination / "index/attempts.jsonl").read_text().splitlines()), 1)

    def test_accepted_mode_excludes_invalidated_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, _ = make_attempt(root, status="invalidated")
            rows = export_traces.copy_participant_export(participants, root / "accepted")
            self.assertEqual(rows, [])
            audit = export_traces.copy_participant_export(participants, root / "audit", mode="audit")
            self.assertEqual(len(audit), 1)
            self.assertEqual(audit[0]["task_status"], "pending")

    def test_audit_mode_includes_failed_skipped_and_invalidated_terminal_attempts(self):
        for status, outcome in (("failed", "failed_retry"), ("failed", "skipped"), ("invalidated", "recording_problem")):
            with self.subTest(status=status, outcome=outcome), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                participants, attempt = make_attempt(root, status=status)
                metadata = json.loads((attempt / "attempt.json").read_text())
                metadata["outcome"] = outcome
                write_json(attempt / "attempt.json", metadata)
                self.assertEqual(export_traces.copy_participant_export(
                    participants, root / "accepted"
                ), [])
                rows = export_traces.copy_participant_export(participants, root / "audit", mode="audit")
                self.assertEqual(rows[0]["outcome"], outcome)

    def test_audit_mode_keeps_incomplete_invalidated_attempt_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root, status="invalidated")
            (attempt / "manifest.json").unlink()
            (attempt / "trace.json").unlink()
            (attempt / "recording.webm").unlink()
            rows = export_traces.copy_participant_export(participants, root / "audit", mode="audit")
            self.assertFalse(rows[0]["artifact_complete"])

    def test_missing_video_fails_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root)
            (attempt / "recording.webm").unlink()
            with self.assertRaisesRegex(ValueError, "recording.webm"):
                export_traces.copy_participant_export(participants, root / "export")

    def test_orphan_snapshot_and_mismatched_directory_identity_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root)
            (attempt / "snapshots/s0002.jpg").write_bytes(b"orphan")
            with self.assertRaisesRegex(ValueError, "incomplete snapshot pair"):
                export_traces.copy_participant_export(participants, root / "orphan")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root)
            wrong = attempt.with_name("999-att_001")
            attempt.rename(wrong)
            with self.assertRaisesRegex(ValueError, "directory does not match attempt"):
                export_traces.copy_participant_export(participants, root / "wrong-name")

    def test_refuses_overlapping_or_unmarked_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, _ = make_attempt(root)
            with self.assertRaisesRegex(ValueError, "overlap"):
                export_traces.copy_participant_export(participants, participants)
            destination = root / "existing"
            destination.mkdir()
            (destination / "important.txt").write_text("keep")
            with self.assertRaisesRegex(ValueError, "Refusing"):
                export_traces.copy_participant_export(participants, destination)
            self.assertTrue((destination / "important.txt").exists())

    def test_participant_and_run_filters_limit_incremental_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, _ = make_attempt(root)
            rows = export_traces.copy_participant_export(
                participants, root / "selected", participant_id="P001", run_id="run_001"
            )
            self.assertEqual(len(rows), 1)
            empty = export_traces.copy_participant_export(
                participants, root / "other", participant_id="P999", run_id="run_001"
            )
            self.assertEqual(empty, [])

    def test_incremental_index_merge_replaces_same_ids_and_retains_others(self):
        remote = [{"attempt_id": "att_001", "value": "old"}, {"attempt_id": "att_002"}]
        local = [{"attempt_id": "att_001", "value": "new"}, {"attempt_id": "att_003"}]
        self.assertEqual(export_traces.merge_rows(remote, local, "attempt_id"), [
            {"attempt_id": "att_001", "value": "new"},
            {"attempt_id": "att_002"},
            {"attempt_id": "att_003"},
        ])

    def test_incremental_merge_rejects_changed_immutable_attempt_evidence(self):
        remote = [{"attempt_id": "att_001", "artifact_root_sha256": "old"}]
        local = [{"attempt_id": "att_001", "artifact_root_sha256": "new"}]
        with self.assertRaisesRegex(ValueError, "different evidence"):
            export_traces.merge_rows(
                remote, local, "attempt_id", "artifact_root_sha256"
            )


if __name__ == "__main__":
    unittest.main()
