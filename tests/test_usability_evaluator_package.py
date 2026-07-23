import json
from importlib.resources import files
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from tests.test_export_evidence_bundle import exporter, fixture, write_json


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_SRC = ROOT / "packages/usability-evaluator/src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from ui_usability_evaluator import assessment, bundle, materialize, remediation


def fake_derive(recording, trace, manifest, output, policy, calibration):
    output.mkdir(parents=True)
    snapshots = output / "snapshots"
    snapshots.mkdir()
    (snapshots / "v0001.jpg").write_bytes(b"jpeg")
    write_json(snapshots / "v0001.json", {
        "schema_version": 1,
        "snapshot_id": "v0001",
        "source": "video-derived",
        "image_file": "v0001.jpg",
        "frame_index": 1,
        "actual_video_ts_ms": 100,
        "policy_id": policy["policy_id"],
        "associations": [],
    })
    write_json(output / "frame-selection.json", {
        "schema_version": 1,
        "policy": {"policy_id": policy["policy_id"], "policy_sha256": "test"},
        "calibration": {"method_id": "test", "artifact_sha256": "test"},
        "recording": {},
        "timing": manifest["recording_timing"],
        "bursts": [],
        "frames": [{"snapshot_id": "v0001"}],
        "uncovered_semantic_events": [],
        "deduplicated_request_count": 0,
        "warnings": [],
    })
    write_json(output / "model-input-sequence.json", {
        "schema_version": 1,
        "policy_id": policy["policy_id"],
        "segment_frames": 60,
        "segments": [{"segment_index": 1, "items": [{
            "snapshot_id": "v0001",
            "actual_video_ts_ms": 100,
            "associations": [],
            "event_seq": [1],
            "io_events": [],
        }]}],
    })
    return {"frames": [{"snapshot_id": "v0001"}]}


class EvaluatorPackageTests(unittest.TestCase):
    def test_bundle_to_assessment_and_bounded_request(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            bundle_path, manifest = exporter.export_bundle(
                participants, "att_001", root / "exchange", registry
            )
            self.assertEqual(
                bundle.validate_bundle(bundle_path)["manifest"]["bundleId"],
                manifest["bundleId"],
            )
            with mock.patch.object(
                materialize, "derive_video_keyframes", side_effect=fake_derive
            ):
                resources = files("ui_usability_evaluator.resources")
                case, case_path = materialize.materialize_versioned(
                    bundle_path,
                    root / "cases",
                    Path(str(resources.joinpath(
                        "policies/frame-policy.method3-v1.json"
                    ))),
                    Path(str(resources.joinpath(
                        "calibration/method3-recording-alignment-v1.json"
                    ))),
                )
            findings_file = root / "findings.json"
            write_json(findings_file, {
                "schema_version": 2,
                "attempt_id": "att_001",
                "findings": [{
                    "title": "Cart feedback is unclear",
                    "ux_problem": "The action did not expose a clear state change.",
                    "observation": "The participant repeated the action.",
                    "task_impact": "Completion confidence was reduced.",
                    "severity": "medium",
                    "confidence": "high",
                    "evidence": {"event_seq": [1], "snapshot_ids": ["v0001"]},
                }],
            })
            assessment_file = root / "assessment.json"
            first = assessment.normalize(
                case_path, findings_file, assessment_file
            )
            second = assessment.normalize(
                case_path, findings_file, root / "assessment-copy.json"
            )
            self.assertEqual(first["assessmentId"], second["assessmentId"])
            self.assertEqual(first["bundleId"], manifest["bundleId"])
            problem_id = first["problems"][0]["problemId"]
            request = remediation.create_request(
                assessment_file, [problem_id], "src_0123456789abcdef",
                root / "request.json",
            )
            self.assertEqual(
                request["selectedProblems"][0]["problemId"], problem_id
            )
            self.assertNotIn("patch", request)
            self.assertNotIn("commands", request)
            self.assertEqual(case["source_root"], None)

    def test_bundle_reader_rejects_unlisted_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            bundle_path, _ = exporter.export_bundle(
                participants, "att_001", root / "exchange", registry
            )
            (bundle_path / "extra.txt").write_text("unexpected", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "closed file set"):
                bundle.validate_bundle(bundle_path)

    def test_remediation_rejects_unknown_problem(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            assessment_file = root / "assessment.json"
            write_json(assessment_file, {
                "schemaVersion": "ux-assessment/v1",
                "assessmentId": "uxa_test",
                "problems": [],
            })
            with self.assertRaisesRegex(ValueError, "unknown"):
                remediation.create_request(
                    assessment_file, ["uxp_missing"], "src_test",
                    root / "request.json",
                )


if __name__ == "__main__":
    unittest.main()
