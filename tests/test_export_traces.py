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
        "assignment_id": "asg_001", "position": 1, "task_prompt": "Do task",
        "accepted_attempt_id": "att_001" if status == "accepted" else None,
    })
    write_json(attempt / "attempt.json", {
        "schema_version": 2, "participant_id": "P001", "run_id": "run_001",
        "assignment_id": "asg_001", "attempt_id": "att_001", "attempt_number": 1,
        "session_id": "session_001", "status": status,
    })
    write_json(attempt / "manifest.json", {"session_id": "session_001", "status": "complete"})
    write_json(attempt / "trace.json", {"interactions": [{"seq": 1}]})
    (attempt / "recording.webm").write_bytes(b"video")
    write_json(attempt / "snapshots" / "s0001.json", {"snapshot_id": "s0001"})
    (attempt / "snapshots" / "s0001.jpg").write_bytes(b"jpeg")
    return participants, attempt


class ExportTraceTests(unittest.TestCase):
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
            self.assertEqual(len((destination / "index/attempts.jsonl").read_text().splitlines()), 1)

    def test_accepted_mode_excludes_invalidated_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, _ = make_attempt(root, status="invalidated")
            rows = export_traces.copy_participant_export(participants, root / "accepted")
            self.assertEqual(rows, [])
            audit = export_traces.copy_participant_export(participants, root / "audit", mode="audit")
            self.assertEqual(len(audit), 1)

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


if __name__ == "__main__":
    unittest.main()
