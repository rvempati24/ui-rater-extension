import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "export_evidence_bundle", ROOT / "scripts/export_evidence_bundle.py"
)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def write_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def fixture(root: Path) -> tuple[Path, Path]:
    participants = root / "collection/participants"
    run = participants / "P001/runs/run_001"
    task = run / "tasks/001-asg_001"
    attempt = task / "attempts/001-att_001"
    revision = {
        "schemaVersion": 1,
        "studyRevisionId": "str_001",
        "website": {
            "websiteArtifactId": "wsa_001",
            "websiteAcquisitionId": "wac_001",
            "artifactDigest": "sha256:artifact",
        },
    }
    write_json(run / "run.json", {
        "run_id": "run_001",
        "participant_id": "P001",
        "study_revision_id": "str_001",
        "study_revision_digest": "sha256:revision",
        "study_revision": revision,
        "website_snapshot": revision["website"],
    })
    write_json(task / "task.json", {
        "run_id": "run_001",
        "participant_id": "P001",
        "assignment_id": "asg_001",
        "position": 1,
        "source_position": 2,
        "website_task_id": "wst_001",
        "task_prompt": "Add the requested item to the cart.",
        "target_url": "http://candidate.localhost:4173/shop?seed=1",
    })
    write_json(attempt / "attempt.json", {
        "run_id": "run_001",
        "participant_id": "P001",
        "assignment_id": "asg_001",
        "attempt_id": "att_001",
        "attempt_number": 1,
        "session_id": "session_secret",
        "status": "accepted",
        "outcome": "succeeded",
        "outcome_at": "2026-07-23T00:00:00Z",
    })
    write_json(attempt / "manifest.json", {
        "session_id": "session_secret",
        "recording_timing": {
            "clock": "unix-epoch-ms",
            "video_start_epoch_ms": 1000,
            "video_stop_epoch_ms": 3000,
            "trace_origin_epoch_ms": 1100,
            "trace_to_video_offset_ms": 100,
            "start_source": "mediarecorder-start-event",
            "capture_profile": {"profile_id": "tab-vp8-30fps-v1"},
        },
    })
    write_json(attempt / "trace.json", {
        "participant_id": "P001",
        "interactions": [{
            "seq": 1,
            "ts": 10,
            "kind": "click",
            "participant_id": "P001",
            "session_id": "session_secret",
            "url": "http://candidate.localhost:4173/shop?seed=1",
        }],
    })
    (attempt / "recording.webm").write_bytes(b"webm-fixture")

    protocol = {
        "schemaVersion": "task-protocol/v1",
        "prompt": "Add the requested item to the cart.",
        "startPath": "/shop",
        "timeoutMs": 120000,
        "successOracle": {
            "kind": "browser-state",
            "description": "The cart contains the requested item.",
        },
    }
    protocol_id, digest = exporter.protocol_identity(protocol)
    protocol.update({
        "taskProtocolId": protocol_id,
        "taskSemanticDigest": digest,
    })
    registry = root / "bindings.json"
    write_json(registry, {
        "schemaVersion": "legacy-task-protocol-bindings/v1",
        "bindings": [{
            "studyRevisionId": "str_001",
            "websiteArtifactId": "wsa_001",
            "websiteTaskId": "wst_001",
            "taskProtocol": protocol,
            "approvedBy": "test-reviewer",
            "approvedAt": "2026-07-23T00:00:00Z",
        }],
    })
    return participants, registry


class EvidenceBundleExportTests(unittest.TestCase):
    def test_exports_closed_private_free_bundle_idempotently(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            output = root / "exchange"
            path, manifest = exporter.export_bundle(
                participants, "att_001", output, registry
            )
            replay, replay_manifest = exporter.export_bundle(
                participants, "att_001", output, registry
            )
            self.assertEqual(path, replay)
            self.assertEqual(manifest["bundleId"], replay_manifest["bundleId"])
            actual = {
                item.relative_to(path).as_posix()
                for item in path.rglob("*") if item.is_file()
            }
            expected = {item["path"] for item in manifest["files"]}
            self.assertEqual(actual, expected | {"bundle-manifest.json"})
            trace = json.loads((path / "evidence/trace.json").read_text())
            serialized = json.dumps(trace)
            self.assertNotIn("P001", serialized)
            self.assertNotIn("session_secret", serialized)
            self.assertEqual(trace["interactions"][0]["url"], "/shop")

    def test_redacts_input_values_and_url_secrets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            trace_file = next(participants.glob(
                "*/runs/*/tasks/*/attempts/*/trace.json"
            ))
            trace = json.loads(trace_file.read_text())
            trace["interactions"] = [{
                "seq": 1,
                "ts": 10,
                "kind": "input",
                "inputType": "password",
                "value": "secret-token",
                "key": "s",
                "url": "https://example.test/form?token=secret#private",
            }]
            write_json(trace_file, trace)
            path, _ = exporter.export_bundle(
                participants, "att_001", root / "exchange", registry
            )
            public = json.loads((path / "evidence/trace.json").read_text())
            event = public["interactions"][0]
            self.assertNotIn("secret", json.dumps(event))
            self.assertNotIn("value", event)
            self.assertEqual(event["url"], "/form")
            self.assertEqual(event["key"], "Printable")
            self.assertTrue(event["valueRedacted"])

    def test_requires_explicit_legacy_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, _registry = fixture(root)
            with self.assertRaisesRegex(ValueError, "require"):
                exporter.export_bundle(
                    participants, "att_001", root / "exchange", None
                )

    def test_rejects_inconsistent_recording_clock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            manifest_file = next(participants.glob(
                "*/runs/*/tasks/*/attempts/*/manifest.json"
            ))
            manifest = json.loads(manifest_file.read_text())
            manifest["recording_timing"]["trace_to_video_offset_ms"] = 999
            write_json(manifest_file, manifest)
            with self.assertRaisesRegex(ValueError, "timing is inconsistent"):
                exporter.export_bundle(
                    participants, "att_001", root / "exchange", registry
                )

    def test_rejects_changed_protocol_identity_and_nonterminal_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            bindings = json.loads(registry.read_text())
            bindings["bindings"][0]["taskProtocol"]["prompt"] = "Changed"
            write_json(registry, bindings)
            with self.assertRaisesRegex(ValueError, "does not match"):
                exporter.export_bundle(
                    participants, "att_001", root / "exchange", registry
                )

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            participants, registry = fixture(root)
            attempt = next(participants.glob(
                "*/runs/*/tasks/*/attempts/*/attempt.json"
            ))
            value = json.loads(attempt.read_text())
            value["status"] = "recording"
            write_json(attempt, value)
            with self.assertRaisesRegex(ValueError, "terminal"):
                exporter.export_bundle(
                    participants, "att_001", root / "exchange", registry
                )


if __name__ == "__main__":
    unittest.main()
