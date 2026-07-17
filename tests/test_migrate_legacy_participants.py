import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "migrate_legacy_participants.py"
SPEC = importlib.util.spec_from_file_location("migrate_legacy", SCRIPT)
assert SPEC and SPEC.loader
migrate_legacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migrate_legacy)


class MigrationTests(unittest.TestCase):
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
            self.assertTrue((data / "results.json").exists())
            self.assertTrue((data / "sessions" / session_id).exists())


if __name__ == "__main__":
    unittest.main()
