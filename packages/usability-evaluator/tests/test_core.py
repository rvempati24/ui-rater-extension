import hashlib
from importlib.resources import files
import json
import os
from pathlib import Path
import tempfile
import unittest

from ui_usability_evaluator.bundle import identity_digest, validate_bundle
from ui_usability_evaluator.evidence import javascript_canonical_json
from ui_usability_evaluator.remediation import create_request
from ui_usability_evaluator.source_snapshot import create_snapshot, validate_snapshot


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def sha256(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def make_bundle(root: Path) -> Path:
    payloads = {
        "context/study-revision.json": {
            "schemaVersion": "evidence-study-revision/v1",
            "studyRevisionId": "str_1",
            "studyRevisionDigest": "sha256:revision",
            "websiteArtifactId": "wsa_1",
            "websiteArtifactDigest": "sha256:artifact",
        },
        "context/task-assignment.json": {
            "schemaVersion": "evidence-task-assignment/v1",
            "assignmentId": "asg_1",
            "artifactTaskId": "wst_1",
            "taskProtocolId": "taskp_" + "1" * 32,
            "taskSemanticDigest": "sha256:" + "2" * 64,
            "prompt": "Complete the task.",
            "targetPath": "/",
        },
        "evidence/attempt.json": {
            "schemaVersion": "evidence-attempt/v1",
            "attemptId": "att_1",
            "attemptNumber": 1,
            "status": "accepted",
            "outcome": "succeeded",
            "method3Eligible": True,
        },
        "evidence/capture-manifest.json": {
            "schemaVersion": "evidence-capture/v1",
            "clock": "unix-epoch-ms",
            "videoStartEpochMs": 1,
            "videoStopEpochMs": 2,
            "traceOriginEpochMs": 1,
            "traceToVideoOffsetMs": 0,
            "captureProfile": {"profileId": "test"},
        },
        "evidence/trace.json": {
            "schemaVersion": "evidence-trace/v1",
            "clock": "trace-relative-ms",
            "interactions": [{"seq": 1, "ts": 0, "kind": "click"}],
        },
    }
    for relative, value in payloads.items():
        write_json(root / relative, value)
    recording = root / "evidence/recording.webm"
    recording.parent.mkdir(parents=True, exist_ok=True)
    recording.write_bytes(b"webm")
    records = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        records.append({
            "path": path.relative_to(root).as_posix(),
            "mediaType": (
                "video/webm" if path.suffix == ".webm" else "application/json"
            ),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    identity = {
        "schemaVersion": "evidence-bundle/v1",
        "studyRevisionId": "str_1",
        "assignmentId": "asg_1",
        "attemptId": "att_1",
        "taskProtocolId": "taskp_" + "1" * 32,
        "taskSemanticDigest": "sha256:" + "2" * 64,
        "files": records,
    }
    manifest = {
        **identity,
        "bundleId": (
            f"evb_{identity_digest(identity).removeprefix('sha256:')[:32]}"
        ),
    }
    write_json(root / "bundle-manifest.json", manifest)
    return root


class CoreTests(unittest.TestCase):
    def test_vendored_contract_matches_lock(self):
        resources = files("ui_usability_evaluator.resources")
        lock = json.loads(resources.joinpath(
            "contracts/contract-lock.json"
        ).read_text(encoding="utf-8"))
        names = {
            "evidence-bundle/v1": "evidence-bundle-v1.schema.json",
            "evidence-payloads/v1": "evidence-payloads-v1.schema.json",
            "task-protocol/v1": "task-protocol-v1.schema.json",
        }
        for contract, name in names.items():
            schema = resources.joinpath(f"schemas/{name}")
            digest = hashlib.sha256(schema.read_bytes()).hexdigest()
            self.assertEqual(
                lock["contracts"][contract], f"sha256:{digest}"
            )

    def test_canonical_numbers(self):
        self.assertEqual(
            javascript_canonical_json({"b": -0.0, "a": 1.0}),
            '{"a":1,"b":0}',
        )

    def test_strict_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_bundle(Path(temp))
            self.assertEqual(
                validate_bundle(root)["attempt"]["attemptId"], "att_1"
            )
            (root / "extra").write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "closed file set"):
                validate_bundle(root)

    def test_request_is_input_only_and_deterministic(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            assessment = root / "assessment.json"
            write_json(assessment, {
                "schemaVersion": "ux-assessment/v1",
                "assessmentId": "uxa_1",
                "problems": [{"problemId": "uxp_1", "title": "Unclear state"}],
            })
            first = create_request(
                assessment, ["uxp_1"], "src_1", root / "first.json"
            )
            second = create_request(
                assessment, ["uxp_1"], "src_1", root / "second.json"
            )
            self.assertEqual(first, second)
            self.assertNotIn("patch", first)

    def test_source_snapshot_is_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            write_json(source / "package.json", {"scripts": {"test": "true"}})
            snapshot_path, snapshot = create_snapshot(
                source, root / "snapshots"
            )
            self.assertEqual(
                validate_snapshot(snapshot_path)["sourceSnapshotId"],
                snapshot["sourceSnapshotId"],
            )
            (snapshot_path / "files/unlisted").write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "closed file set"):
                validate_snapshot(snapshot_path)

    @unittest.skipIf(os.name == "nt", "symlink fixture is POSIX-only")
    def test_source_snapshot_rejects_directory_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "index.html").write_text("ok", encoding="utf-8")
            (source / "escape").symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                create_snapshot(source, root / "snapshots")


if __name__ == "__main__":
    unittest.main()
