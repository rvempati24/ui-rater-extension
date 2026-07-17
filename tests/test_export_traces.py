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


class ExportTraceTests(unittest.TestCase):
    def test_only_complete_sessions_are_exported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sessions = root / "sessions"
            complete = sessions / "11111111-1111-4111-8111-111111111111"
            partial = sessions / "22222222-2222-4222-8222-222222222222"
            complete.mkdir(parents=True)
            partial.mkdir(parents=True)
            (complete / "manifest.json").write_text(
                json.dumps({
                    "session_id": complete.name,
                    "status": "complete",
                    "participant_id": "P001",
                    "attempt_id": "attempt-002",
                    "website": {
                        "model": "deepseek-v4-flash-free",
                        "website": "allrecipes",
                        "run_id": "20260625-090547-allrecipes",
                    },
                }), encoding="utf-8"
            )
            (complete / "trace.json").write_text("{}", encoding="utf-8")
            (partial / "manifest.json").write_text(
                json.dumps({"session_id": partial.name, "status": "recording"}), encoding="utf-8"
            )
            (partial / "trace.json").write_text("{}", encoding="utf-8")

            selected = export_traces.completed_sessions(sessions)
            self.assertEqual(selected, [complete])

            destination = root / "export"
            export_traces.copy_sessions(selected, destination)
            relative = Path(
                "deepseek-v4-flash-free", "allrecipes", "20260625-090547-allrecipes",
                "attempts", "attempt-002", "users", "P001", "sessions", complete.name,
            )
            self.assertTrue((destination / relative / "trace.json").exists())
            self.assertFalse(any(destination.rglob(partial.name)))
            self.assertEqual(len((destination / "sessions.jsonl").read_text().splitlines()), 1)

    def test_export_path_sanitizes_manifest_segments(self):
        relative = export_traces.session_export_path({
            "session_id": "abc",
            "participant_id": "../user one",
            "attempt_id": "pilot/1",
            "app_id": "run",
        })
        self.assertEqual(
            relative.as_posix(),
            "unknown-model/unknown-site/run/attempts/pilot-1/users/user-one/sessions/abc",
        )


if __name__ == "__main__":
    unittest.main()
