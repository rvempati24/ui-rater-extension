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
                json.dumps({"session_id": complete.name, "status": "complete"}), encoding="utf-8"
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
            self.assertTrue((destination / complete.name / "trace.json").exists())
            self.assertFalse((destination / partial.name).exists())
            self.assertEqual(len((destination / "sessions.jsonl").read_text().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
