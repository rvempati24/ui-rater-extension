import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from test_export_traces import make_attempt


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "materialize_case.py"
SPEC = importlib.util.spec_from_file_location("materialize_case", SCRIPT)
assert SPEC and SPEC.loader
materialize_case = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materialize_case)

RUNNER_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_agent_analysis.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("run_agent_analysis", RUNNER_SCRIPT)
assert RUNNER_SPEC and RUNNER_SPEC.loader
run_agent_analysis = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(run_agent_analysis)


class MaterializeCaseTests(unittest.TestCase):
    def test_audit_rejects_unknown_status_and_missing_trace_but_allows_missing_video(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root, status="invalidated")
            source = root / "source"
            source.mkdir()
            metadata = json.loads((attempt / "attempt.json").read_text())
            metadata["status"] = "garbage"
            (attempt / "attempt.json").write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "not materializable"):
                materialize_case.materialize(attempt, root / "bad", source, {}, audit=True)
            metadata["status"] = "invalidated"
            (attempt / "attempt.json").write_text(json.dumps(metadata))
            (attempt / "trace.json").unlink()
            with self.assertRaisesRegex(ValueError, "trace.json"):
                materialize_case.materialize(attempt, root / "no-trace", source, {}, audit=True)
            (attempt / "trace.json").write_text(json.dumps({"interactions": []}))
            (attempt / "recording.webm").unlink()
            case = materialize_case.materialize(attempt, root / "no-video", source, {}, audit=True)
            self.assertIsNone(case["evidence"]["recording"])

    def test_default_rejects_failed_attempt_but_audit_allows_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root, status="failed")
            source = root / "source"
            source.mkdir()
            with self.assertRaisesRegex(ValueError, "accepted attempts"):
                materialize_case.materialize(attempt, root / "default-case", source, {"source": "local"})
            case = materialize_case.materialize(
                attempt, root / "audit-case", source, {"source": "local"}, audit=True
            )
            self.assertEqual(case["attempt_status"], "failed")

    def test_materializes_evidence_source_and_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, attempt = make_attempt(root)
            run_file = participants / "P001/runs/run_001/run.json"
            run = json.loads(run_file.read_text())
            run["website"] = {"repo_id": "uxBench/website-generation", "revision": "rev", "path_in_repo": "m/s/r"}
            run_file.write_text(json.dumps(run), encoding="utf-8")
            source = root / "source"
            source.mkdir()
            (source / "package.json").write_text("{}", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            self.assertEqual(case["attempt_id"], "att_001")
            self.assertEqual(case["task"]["source_position"], 5)
            self.assertTrue((destination / "website/package.json").exists())
            self.assertTrue((destination / "evidence/trace.json").exists())
            self.assertTrue((destination / "contract/finding.schema.json").exists())
            self.assertTrue((destination / "output").is_dir())
            findings = {
                "schema_version": 2, "attempt_id": "att_001", "findings": [{
                    "title": "Issue", "observation": "Observed", "inference": "Likely",
                    "recommendation": "Change", "evidence": {"event_seq": [1], "snapshot_ids": ["s0001"]},
                    "source_paths": ["package.json"],
                }],
            }
            run_agent_analysis.validate_findings(destination, case, findings)

    def test_rejects_unknown_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "index.html").write_text("", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            findings = {"schema_version": 2, "attempt_id": "att_001", "findings": [{
                "evidence": {"event_seq": [99], "snapshot_ids": []}, "source_paths": [],
            }]}
            with self.assertRaisesRegex(ValueError, "unknown evidence"):
                run_agent_analysis.validate_findings(destination, case, findings)


if __name__ == "__main__":
    unittest.main()
