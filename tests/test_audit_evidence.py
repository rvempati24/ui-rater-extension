import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from test_export_traces import make_attempt


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "audit_evidence.py"
SPEC = importlib.util.spec_from_file_location("audit_evidence", SCRIPT)
assert SPEC and SPEC.loader
audit_evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_evidence)


class EvidenceAuditTests(unittest.TestCase):
    def test_legacy_complete_attempt_is_valid_with_an_explicit_warning(self):
        with tempfile.TemporaryDirectory() as temp:
            participants, _ = make_attempt(Path(temp))
            report = audit_evidence.audit(participants)
            self.assertTrue(report["ok"])
            self.assertEqual(report["counts"]["attempts"], 1)
            self.assertEqual(report["warnings"][0]["code"], "legacy_evidence")

    def test_missing_snapshot_image_and_bad_sequence_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            participants, attempt = make_attempt(Path(temp))
            (attempt / "snapshots/s0001.jpg").unlink()
            (attempt / "trace.json").write_text(json.dumps({
                "interactions": [{"seq": 2}, {"seq": 1}],
            }), encoding="utf-8")
            report = audit_evidence.audit(participants)
            self.assertFalse(report["ok"])
            codes = {issue["code"] for issue in report["issues"]}
            self.assertIn("snapshot_image_missing", codes)
            self.assertIn("trace_sequence_invalid", codes)

    def test_orphan_image_and_symlink_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            participants, attempt = make_attempt(Path(temp))
            (attempt / "snapshots/s0002.jpg").write_bytes(b"orphan")
            (attempt / "linked-trace.json").symlink_to(attempt / "trace.json")
            report = audit_evidence.audit(participants)
            self.assertFalse(report["ok"])
            codes = {issue["code"] for issue in report["issues"]}
            self.assertIn("snapshot_metadata_missing", codes)
            self.assertIn("evidence_symlink", codes)

    def test_v2_accepted_attempt_requires_acknowledged_finalization(self):
        with tempfile.TemporaryDirectory() as temp:
            participants, attempt = make_attempt(Path(temp))
            manifest_file = attempt / "manifest.json"
            manifest = json.loads(manifest_file.read_text())
            manifest.update({
                "schema_version": 2,
                "interaction_count": 1,
                "snapshot_count": 1,
                "snapshot_bytes": 4,
                "recording_status": "saved",
                "final_flush_status": "complete",
                "attempt_status": "accepted",
                "task_status": "completed",
                "finalization_report": {
                    "interaction_flush": "acknowledged",
                    "task_end_snapshot": "skipped",
                },
            })
            manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
            trace_file = attempt / "trace.json"
            trace_file.write_text(json.dumps({
                "interactions": [{"seq": 1, "event_id": "event-1"}],
            }), encoding="utf-8")
            metadata_file = attempt / "snapshots/s0001.json"
            metadata = json.loads(metadata_file.read_text())
            metadata["reason"] = "task-end"
            metadata["image_file"] = "snapshots/s0001.jpg"
            metadata_file.write_text(json.dumps(metadata), encoding="utf-8")
            report = audit_evidence.audit(participants)
            self.assertFalse(report["ok"])
            self.assertIn(
                "final_snapshot_unacknowledged",
                {issue["code"] for issue in report["issues"]},
            )


if __name__ == "__main__":
    unittest.main()
