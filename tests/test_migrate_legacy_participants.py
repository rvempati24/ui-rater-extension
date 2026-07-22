import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "migrate_legacy_participants.py"
SPEC = importlib.util.spec_from_file_location("migrate_legacy", SCRIPT)
assert SPEC and SPEC.loader
migrate_legacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migrate_legacy)


class MigrationTests(unittest.TestCase):
    def test_unsafe_legacy_identifiers_are_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            (data / "results.json").write_text(json.dumps({"../escape": {"trials": [{
                "completed": False,
            }]}}))
            with self.assertRaisesRegex(ValueError, "participant_id"):
                migrate_legacy.migrate(data, apply=True)
            self.assertFalse((data / "participants").exists())

    @unittest.skipIf(os.name == "nt", "symlink semantics differ on Windows")
    def test_symlinked_legacy_session_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            outside = data / "outside"
            outside.mkdir()
            sessions = data / "sessions"
            sessions.mkdir()
            session_id = "11111111-1111-4111-8111-111111111111"
            (sessions / session_id).symlink_to(outside, target_is_directory=True)
            (data / "results.json").write_text(json.dumps({"P005": {"trials": [{
                "completed": True, "session_id": session_id,
            }]}}))
            with self.assertRaisesRegex(ValueError, "may not be a symlink"):
                migrate_legacy.migrate(data, apply=True)
            self.assertFalse((data / "participants").exists())

    def test_completed_task_without_session_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            (data / "results.json").write_text(json.dumps({"P003": {"trials": [{
                "completed": True,
                "session_id": "11111111-1111-4111-8111-111111111111",
                "task_status": "completed", "attempt_status": "accepted",
                "outcome": "succeeded",
            }]}}))
            with self.assertRaisesRegex(ValueError, "existing session directory"):
                migrate_legacy.migrate(data, apply=True)
            self.assertFalse((data / "participants").exists())

    def test_accepted_attempt_on_pending_task_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            session_id = "11111111-1111-4111-8111-111111111111"
            (data / "sessions" / session_id).mkdir(parents=True)
            (data / "results.json").write_text(json.dumps({"P004": {"trials": [{
                "completed": False, "session_id": session_id,
                "task_status": "pending", "attempt_status": "accepted",
                "outcome": "succeeded",
            }]}}))
            with self.assertRaisesRegex(ValueError, "accepted attempt requires completed task"):
                migrate_legacy.migrate(data, apply=True)
            self.assertFalse((data / "participants").exists())

    def test_migration_preserves_new_failed_skipped_and_invalidated_outcomes(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            trials = []
            cases = [
                ("skipped", "failed", "skipped"),
                ("failed_no_retry", "failed", "failed_no_retry"),
                ("pending", "invalidated", "recording_problem"),
            ]
            for index, (task_status, attempt_status, outcome) in enumerate(cases, start=1):
                session_id = f"{index}{index}{index}{index}{index}{index}{index}{index}-1111-4111-8111-111111111111"
                session = data / "sessions" / session_id
                session.mkdir(parents=True)
                (session / "manifest.json").write_text("{}")
                (session / "trace.json").write_text("{}")
                trials.append({
                    "completed": task_status != "pending", "session_id": session_id,
                    "task_prompt": f"Task {index}", "task_status": task_status,
                    "attempt_status": attempt_status, "outcome": outcome,
                    "outcome_reason": f"reason-{index}",
                })
            (data / "results.json").write_text(json.dumps({"P002": {"trials": trials}}))
            migrate_legacy.migrate(data, apply=True)
            run = data / "participants/P002/runs/legacy-P002"
            loaded_tasks = [
                json.loads(path.read_text()) for path in sorted((run / "tasks").glob("*/task.json"))
            ]
            self.assertEqual([task["status"] for task in loaded_tasks], [
                "skipped", "failed_no_retry", "pending",
            ])
            self.assertTrue(all(not task.get("accepted_attempt_id") for task in loaded_tasks))
            self.assertEqual(json.loads((run / "run.json").read_text())["status"], "active")

    def test_migration_copies_and_never_deletes_legacy_data(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)
            session_id = "11111111-1111-4111-8111-111111111111"
            (data / "sessions" / session_id).mkdir(parents=True)
            (data / "sessions" / session_id / "manifest.json").write_text("{}")
            (data / "sessions" / session_id / "trace.json").write_text("{}")
            (data / "recordings").mkdir()
            (data / "recordings/P001_task1.webm").write_bytes(b"video")
            (data / "results.json").write_text(json.dumps({"P001": {"trials": [{
                "completed": True, "session_id": session_id, "task_prompt": "Task",
                "task_app": "app", "group": "site", "slug": "slug",
            }]}}), encoding="utf-8")
            preview = migrate_legacy.migrate(data, apply=False)
            self.assertEqual(preview["attempts"], 1)
            self.assertFalse((data / "participants").exists())
            migrate_legacy.migrate(data, apply=True)
            attempt = data / "participants/P001/runs/legacy-P001/tasks/001-legacy-asg-001/attempts/001-legacy-att-001"
            self.assertTrue((attempt / "recording.webm").exists())
            attempt_metadata = json.loads((attempt / "attempt.json").read_text())
            task_metadata = json.loads((attempt.parent.parent / "task.json").read_text())
            self.assertEqual(attempt_metadata["outcome"], "succeeded")
            self.assertEqual(task_metadata["status"], "completed")
            self.assertTrue((data / "results.json").exists())
            self.assertTrue((data / "sessions" / session_id).exists())


if __name__ == "__main__":
    unittest.main()
