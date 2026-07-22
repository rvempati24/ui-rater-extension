import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

try:
    from test_export_traces import make_attempt, write_json
except ModuleNotFoundError:
    from tests.test_export_traces import make_attempt, write_json


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "materialize_method3_case.py"
SPEC = importlib.util.spec_from_file_location("materialize_method3_case", SCRIPT)
materialize = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(materialize)

RUNNER_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_direct_analysis.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("run_direct_analysis_method3", RUNNER_SCRIPT)
runner = importlib.util.module_from_spec(RUNNER_SPEC)
assert RUNNER_SPEC.loader
RUNNER_SPEC.loader.exec_module(runner)


def prepare_primary(root: Path):
    participants, attempt = make_attempt(root)
    run_file = participants / "P001/runs/run_001/run.json"
    task_file = participants / "P001/runs/run_001/tasks/001-asg_001/task.json"
    revision = {
        "schemaVersion": 1, "studyId": "study_1", "studyRevisionId": "str_1",
        "website": {
            "websiteDeploymentId": "wsd_1", "websiteArtifactId": "wsa_1",
            "websiteAcquisitionId": "wac_1", "artifactDigest": "sha256:artifact",
            "baseUrl": "http://example.test/", "provenance": {"score": 1.0},
        },
        "tasks": [{
            "websiteTaskId": "wst_1", "sourcePosition": 5, "position": 1,
            "prompt": "Do task", "slug": "task", "group": "site",
            "targetUrl": "http://example.test/", "suggestedFlows": [],
        }],
        "publishedAt": "2026-07-22T00:00:00.000Z",
    }
    digest, _ = materialize.contract_digest(revision)
    run = json.loads(run_file.read_text())
    run.update({
        "study_revision_id": "str_1", "study_revision_digest": digest,
        "study_revision": revision, "website_snapshot": revision["website"],
    })
    write_json(run_file, run)
    task = json.loads(task_file.read_text())
    task.update({"website_task_id": "wst_1", "target_url": "http://example.test/"})
    write_json(task_file, task)
    return attempt


def fake_derive(recording, trace, manifest, output, policy, calibration):
    output.mkdir(parents=True)
    snapshots = output / "snapshots"
    snapshots.mkdir()
    (snapshots / "v0001.jpg").write_bytes(b"jpeg")
    write_json(snapshots / "v0001.json", {
        "schema_version": 1, "snapshot_id": "v0001", "source": "video-derived",
        "image_file": "v0001.jpg", "frame_index": 1, "actual_video_ts_ms": 100,
        "policy_id": policy["policy_id"], "associations": [{
            "burst_id": "b0001", "frame_role": "before", "event_family": "click",
            "event_seq": [1], "action_ids": [], "anchor_trace_ts_ms": 75,
            "anchor_video_ts_ms": 175, "requested_video_ts_ms": 100,
            "actual_video_ts_ms": 100, "offset_from_anchor_ms": -75, "clamped": False,
        }],
    })
    write_json(output / "frame-selection.json", {
        "schema_version": 1, "policy": {"policy_id": policy["policy_id"], "policy_sha256": "x"},
        "calibration": {"method_id": "test", "artifact_sha256": "x"},
        "recording": {}, "timing": manifest["recording_timing"], "bursts": [],
        "frames": [{"snapshot_id": "v0001"}], "uncovered_semantic_events": [],
        "deduplicated_request_count": 0, "warnings": [],
    })
    write_json(output / "model-input-sequence.json", {
        "schema_version": 1, "policy_id": policy["policy_id"], "segment_frames": 60,
        "segments": [{"segment_index": 1, "items": [{
            "snapshot_id": "v0001", "actual_video_ts_ms": 100,
            "associations": [], "event_seq": [1], "io_events": [],
        }]}],
    })
    return {"frames": [{"snapshot_id": "v0001"}]}


class PrimaryMaterializerTests(unittest.TestCase):
    def test_contract_digest_uses_javascript_number_semantics(self):
        digest_a, canonical = materialize.contract_digest({"z": -0.0, "a": 1.0, "u": "é"})
        digest_b, _ = materialize.contract_digest({"u": "é", "a": 1, "z": 0})
        self.assertEqual(canonical, '{"a":1,"u":"é","z":0}')
        self.assertEqual(digest_a, digest_b)

    def test_contract_digest_matches_shared_golden_vectors(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/canonical-json-vectors.json").read_text())
        for vector in vectors:
            with self.subTest(canonical=vector["canonical"]):
                digest, canonical = materialize.contract_digest(vector["input"])
                self.assertEqual(canonical, vector["canonical"])
                self.assertEqual(digest, vector["digest"])

    def test_materializes_collection_only_manifest_v2(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempt = prepare_primary(root)
            policy = Path(__file__).resolve().parents[1] / "scripts/frame-policy.method3-v1.json"
            calibration = Path(__file__).resolve().parents[1] / "calibration/method3-recording-alignment-v1.json"
            destination = root / "case"
            with mock.patch.object(materialize, "derive_video_keyframes", side_effect=fake_derive):
                case = materialize.materialize_primary(
                    attempt, destination, {"source": "local"}, policy, calibration
                )
            self.assertIsNone(case["source_root"])
            self.assertFalse((destination / "website").exists())
            manifest = materialize.validate_manifest_v2(
                destination, json.loads((destination / "evidence-manifest.json").read_text())
            )
            self.assertEqual(manifest["schema_version"], 2)
            self.assertFalse(manifest["recording"]["send_to_model"])
            self.assertEqual([item["snapshot_id"] for item in manifest["snapshots"]], ["v0001"])
            payload, sent = runner.response_payload(destination, case, "model", "medium")
            content = payload["input"][0]["content"]
            self.assertEqual(sum(item["type"] == "input_image" for item in content), 1)
            self.assertFalse(any(item["path"].endswith("recording.webm") for item in sent))
            self.assertTrue(any("Frame segment 1 begins" in item.get("text", "") for item in content))

    def test_rejects_changed_frozen_task(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempt = prepare_primary(root)
            task_file = attempt.parent.parent / "task.json"
            task = json.loads(task_file.read_text())
            task["task_prompt"] = "Changed"
            write_json(task_file, task)
            with self.assertRaisesRegex(ValueError, "differ from"):
                materialize.validate_context(
                    json.loads((attempt.parents[5] / "participant.json").read_text()),
                    json.loads((attempt.parents[3] / "run.json").read_text()),
                    task, json.loads((attempt / "attempt.json").read_text()),
                )


if __name__ == "__main__":
    unittest.main()
