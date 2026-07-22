import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

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

DIRECT_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_direct_analysis.py"
DIRECT_SPEC = importlib.util.spec_from_file_location("run_direct_analysis", DIRECT_SCRIPT)
assert DIRECT_SPEC and DIRECT_SPEC.loader
run_direct_analysis = importlib.util.module_from_spec(DIRECT_SPEC)
DIRECT_SPEC.loader.exec_module(run_direct_analysis)

EXPERIMENT_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_ux_experiment.py"
EXPERIMENT_SPEC = importlib.util.spec_from_file_location("run_ux_experiment", EXPERIMENT_SCRIPT)
assert EXPERIMENT_SPEC and EXPERIMENT_SPEC.loader
run_ux_experiment = importlib.util.module_from_spec(EXPERIMENT_SPEC)
EXPERIMENT_SPEC.loader.exec_module(run_ux_experiment)


def valid_finding(event_seq=None, snapshot_ids=None):
    return {
        "title": "Task friction",
        "ux_problem": "The control state was unclear during the task.",
        "observation": "The participant repeated an action.",
        "task_impact": "This slowed completion of the assigned task.",
        "severity": "medium",
        "confidence": "high",
        "evidence": {
            "event_seq": [1] if event_seq is None else event_seq,
            "snapshot_ids": [] if snapshot_ids is None else snapshot_ids,
        },
    }


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
            snapshot_file = attempt / "snapshots/s0001.json"
            snapshot = json.loads(snapshot_file.read_text())
            snapshot.update({
                "action_id": "session:activate:uuid", "phase": "before",
                "requested_ts": 90, "capture_started_ts": 95, "ts": 110,
                "capture_latency_ms": 15, "timing_guarantee": "best-effort-before",
            })
            snapshot_file.write_text(json.dumps(snapshot), encoding="utf-8")
            source = root / "source"
            source.mkdir()
            (source / "package.json").write_text("{}", encoding="utf-8")
            (source / "AGENTS.md").write_text("malicious instructions", encoding="utf-8")
            (source / "prompt.txt").write_text("generator prompt", encoding="utf-8")
            (source / "opencode-session.json").write_text("{}", encoding="utf-8")
            (source / "trials-config.json").write_text(
                json.dumps({"expected_user_flow": ["secret"]}), encoding="utf-8"
            )
            (source / "tests").mkdir()
            (source / "tests" / "expected-flow.js").write_text("secret", encoding="utf-8")
            (source / ".codex").mkdir()
            (source / ".codex/config.toml").write_text("web_search = 'live'", encoding="utf-8")
            (attempt / "analysis").mkdir()
            (attempt / "analysis/findings.json").write_text('{"prior": true}', encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            self.assertEqual(case["attempt_id"], "att_001")
            self.assertEqual(case["task"]["source_position"], 5)
            self.assertTrue((destination / "website/package.json").exists())
            self.assertFalse((destination / "website/AGENTS.md").exists())
            self.assertFalse((destination / "website/prompt.txt").exists())
            self.assertFalse((destination / "website/opencode-session.json").exists())
            self.assertFalse((destination / "website/trials-config.json").exists())
            self.assertFalse((destination / "website/tests").exists())
            self.assertFalse((destination / "website/.codex").exists())
            self.assertFalse((destination / "evidence/analysis").exists())
            self.assertTrue((destination / "evidence/trace.json").exists())
            self.assertTrue((destination / "contract/finding.schema.json").exists())
            self.assertTrue((destination / "evidence-manifest.json").exists())
            self.assertTrue((destination / "analysis-case.json").exists())
            self.assertEqual(case["evidence_manifest"], "evidence-manifest.json")
            evidence_manifest = json.loads(
                (destination / "evidence-manifest.json").read_text(encoding="utf-8")
            )
            manifest_snapshot = evidence_manifest["snapshots"][0]
            self.assertEqual(manifest_snapshot["action_id"], "session:activate:uuid")
            self.assertEqual(manifest_snapshot["captured_ts"], 110)
            self.assertEqual(manifest_snapshot["timing_guarantee"], "best-effort-before")
            self.assertTrue((destination / "output").is_dir())
            findings = {
                "schema_version": 2, "attempt_id": "att_001", "findings": [{
                    "title": "Issue", "ux_problem": "The control was unclear",
                    "observation": "Observed", "task_impact": "Slowed the task",
                    "severity": "medium", "confidence": "high",
                    "evidence": {"event_seq": [1], "snapshot_ids": ["s0001"]},
                }],
            }
            run_agent_analysis.validate_findings(destination, case, findings)
            schema = json.loads((destination / "contract/finding.schema.json").read_text())
            self.assertNotIn("recommendation", schema["properties"]["findings"]["items"]["properties"])
            self.assertEqual(
                case["source_verification"]["tree_sha256"],
                materialize_case.tree_digest(destination / "website"),
            )

    def test_versioned_materialization_preserves_revisions_and_latest_pointer_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "app.js").write_text("version one", encoding="utf-8")
            case_root = root / "case"
            first, first_dir = materialize_case.materialize_versioned(
                attempt, case_root, source, {"source": "local", "source_verified": True}
            )
            # A legacy flat case must not shadow the explicit revision pointer.
            (case_root / "case.json").write_text('{"legacy": true}', encoding="utf-8")
            (source / "app.js").write_text("version two", encoding="utf-8")
            second, second_dir = materialize_case.materialize_versioned(
                attempt, case_root, source, {"source": "local", "source_verified": True}
            )
            self.assertNotEqual(first["case_revision_id"], second["case_revision_id"])
            self.assertTrue((first_dir / "case.json").is_file())
            self.assertTrue((second_dir / "case.json").is_file())
            self.assertEqual(run_agent_analysis.resolve_case_dir(case_root), second_dir)

    def test_case_integrity_detects_tampering_and_build_refuses_nonempty_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            trace = destination / "evidence/trace.json"
            trace.chmod(0o600)
            trace.write_text('{"interactions": []}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "integrity mismatch"):
                materialize_case.validate_case_integrity(destination, case)
            occupied = root / "occupied"
            occupied.mkdir()
            (occupied / "keep.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "must be empty"):
                materialize_case.materialize(attempt, occupied, source, {"source": "local"})
            self.assertEqual((occupied / "keep.txt").read_text(), "keep")

    @unittest.skipIf(os.name == "nt", "symlink semantics differ on Windows")
    def test_case_integrity_manifest_cannot_be_replaced_by_an_internal_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            integrity = destination / "case-integrity.json"
            copy = destination / "output/integrity-copy.json"
            copy.write_bytes(integrity.read_bytes())
            integrity.unlink()
            integrity.symlink_to(copy)
            with self.assertRaisesRegex(ValueError, "may not use a symlink"):
                materialize_case.validate_case_integrity(destination, case)

    @unittest.skipIf(os.name == "nt", "symlink semantics differ on Windows")
    def test_materialization_rejects_symlinked_source_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            outside = root / "outside.txt"
            outside.write_text("secret", encoding="utf-8")
            (source / "link.txt").symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "contains a symlink"):
                materialize_case.materialize(attempt, root / "case", source, {"source": "local"})

    def test_remote_website_provenance_rejects_path_traversal_before_download(self):
        with tempfile.TemporaryDirectory() as temp:
            run = {"website": {
                "repo_id": "owner/repo", "revision": "main",
                "path_in_repo": "../../outside",
            }}
            with self.assertRaisesRegex(ValueError, "unsafe path_in_repo"):
                materialize_case.resolve_source(run, None, None, Path(temp))

    def test_rejects_unknown_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "index.html").write_text("", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            findings = {"schema_version": 2, "attempt_id": "att_001", "findings": [
                valid_finding(event_seq=[99])
            ]}
            with self.assertRaisesRegex(ValueError, "unknown evidence"):
                run_agent_analysis.validate_findings(destination, case, findings)

    def test_selected_snapshot_validation_does_not_fall_back_when_set_is_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            findings = {"schema_version": 2, "attempt_id": "att_001", "findings": [
                valid_finding(event_seq=[], snapshot_ids=["s0001"])
            ]}
            with self.assertRaisesRegex(ValueError, "unknown evidence"):
                run_agent_analysis.validate_findings(
                    destination, case, findings, allowed_snapshot_ids=set()
                )

    def test_evidence_only_workspace_excludes_website_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "secret-source.js").write_text("source", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            comparison_root = root / "comparison"
            workspace = run_agent_analysis.evidence_workspace(
                destination, case, comparison_root, [destination / "evidence/snapshots/s0001.jpg"]
            )
            self.assertTrue((workspace / "trace.json").is_file())
            self.assertTrue((workspace / "screenshots/s0001.jpg").is_file())
            self.assertTrue((workspace / "finding.schema.json").is_file())
            self.assertFalse((workspace / "website").exists())
            self.assertNotIn("source_root", json.loads((workspace / "case.json").read_text()))

    def test_source_workspace_excludes_prior_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "app.js").write_text("source", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            prior = destination / "output/evidence-only/findings.json"
            prior.parent.mkdir(parents=True)
            prior.write_text('{"leaked": true}', encoding="utf-8")
            workspace = run_agent_analysis.source_workspace(
                destination, case, root / "comparison",
                [destination / "evidence/snapshots/s0001.jpg"],
            )
            self.assertEqual(workspace.name, "source-explore")
            self.assertTrue((workspace / "website/app.js").is_file())
            self.assertTrue((workspace / "trace.json").is_file())
            self.assertTrue((workspace / "screenshots/s0001.jpg").is_file())
            self.assertFalse((workspace / "output").exists())
            self.assertFalse((workspace / "evidence").exists())

    def test_screenshot_selection_defaults_to_all_and_cap_spans_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            snapshots = root / "evidence/snapshots"
            snapshots.mkdir(parents=True)
            (root / "evidence/trace.json").write_text('{"interactions": []}', encoding="utf-8")
            paths = []
            for number in range(1, 21):
                relative = f"evidence/snapshots/s{number:04}.jpg"
                (root / relative).write_bytes(b"image")
                (root / relative).with_suffix(".json").write_text(json.dumps({
                    "snapshot_id": f"s{number:04}", "ts": number, "reason": "test",
                }), encoding="utf-8")
                paths.append(relative)
            case = {
                "attempt_id": "att_test",
                "analysis_case": "analysis-case.json",
                "evidence": {"trace": "evidence/trace.json", "snapshots": paths},
                "evidence_manifest": "evidence-manifest.json",
            }
            (root / "analysis-case.json").write_text(json.dumps({
                "schema_version": 1, "attempt_id": "att_test",
            }), encoding="utf-8")
            materialize_case.write_evidence_manifest(root, case)
            selected_all = run_agent_analysis.select_snapshot_paths(root, case)
            selected_capped = run_agent_analysis.select_snapshot_paths(root, case, 4)
            self.assertEqual(len(selected_all), 20)
            self.assertEqual(
                [path.name for path in selected_capped],
                ["s0001.jpg", "s0007.jpg", "s0014.jpg", "s0020.jpg"],
            )

    def test_evidence_and_source_workspaces_can_share_one_temporary_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "app.js").write_text("source", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            screenshot = [destination / "evidence/snapshots/s0001.jpg"]
            evidence = run_agent_analysis.evidence_workspace(
                destination, case, root / "comparison", screenshot
            )
            source_copy = run_agent_analysis.source_workspace(
                destination, case, root / "comparison", screenshot
            )
            self.assertEqual(evidence.name, "evidence-only")
            self.assertEqual(source_copy.name, "source-explore")

    def test_both_conditions_publish_validated_outputs_without_exposing_case_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            (source / "app.js").write_text("source", encoding="utf-8")
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            temp_root = root / "comparison"
            analysis_run_id = "analysis_test"
            run_root = destination / "output/runs" / analysis_run_id
            commands = []

            def fake_codex(command, **_kwargs):
                commands.append(command)
                candidate = Path(command[command.index("-o") + 1])
                candidate.write_text(json.dumps({
                    "schema_version": 2,
                    "attempt_id": "att_001",
                    "findings": [valid_finding()],
                }), encoding="utf-8")
                return run_agent_analysis.subprocess.CompletedProcess(command, 0, "", "")

            with mock.patch.object(
                run_agent_analysis.subprocess, "run", side_effect=fake_codex
            ):
                results = [
                    run_agent_analysis.run_condition(
                        destination, case, condition, "codex", "test", "gpt-test", "medium",
                        None, 60, temp_root, run_root, analysis_run_id,
                    )
                    for condition in ("evidence-only", "source-explore")
                ]
            self.assertTrue(all(result["ok"] for result in results))
            self.assertTrue((run_root / "evidence-only/findings.json").is_file())
            self.assertTrue((run_root / "source-explore/findings.json").is_file())
            for command in commands:
                self.assertNotIn(str(destination), "\n".join(command))

    def test_codex_command_is_ephemeral_read_only_and_schema_bound(self):
        command = run_agent_analysis.codex_command(
            "codex", Path("/case"), "gpt-test", "medium",
            Path("/case/schema.json"), Path("/case/output.json"),
            [Path("/case/s0001.jpg")],
        )
        self.assertIn("--ephemeral", command)
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ignore-rules", command)
        self.assertEqual(command[command.index("--sandbox") + 1], "read-only")
        self.assertIn('web_search="disabled"', command)
        self.assertIn('shell_environment_policy.inherit="none"', command)
        self.assertIn('model_reasoning_effort="medium"', command)
        self.assertIn("--json", command)
        self.assertNotIn("/case/s0001.jpg", command)
        self.assertEqual(command[-1], "-")

    def test_safe_environment_does_not_pass_home_or_hf_token(self):
        old_home = os.environ.get("HOME")
        old_hf = os.environ.get("HF_TOKEN")
        try:
            os.environ["HOME"] = "/sensitive-home"
            os.environ["HF_TOKEN"] = "hf-secret"
            environment = run_agent_analysis.safe_environment()
            self.assertEqual(environment["HOME"], "/sensitive-home")
            self.assertNotIn("HF_TOKEN", environment)
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
            if old_hf is None:
                os.environ.pop("HF_TOKEN", None)
            else:
                os.environ["HF_TOKEN"] = old_hf

    def test_codex_image_inspection_requires_an_image_tool_event(self):
        stdout = "\n".join([
            json.dumps({
                "type": "item.completed",
                "item": {"type": "reasoning", "text": "Maybe inspect s0001.jpg"},
            }),
            json.dumps({
                "type": "item.started",
                "item": {
                    "type": "tool_call", "name": "view_image",
                    "arguments": {"path": "screenshots/s0002.jpg"},
                },
            }),
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10}}),
        ])
        inspected, usage, model = run_agent_analysis.parse_codex_events(stdout)
        self.assertEqual(inspected, ["s0002"])
        self.assertEqual(usage, {"input_tokens": 10})
        self.assertIsNone(model)

    def test_experiment_normalizes_the_codex_result_envelope(self):
        summary = {
            "analysis_run_id": "analysis-1",
            "experiment_id": "experiment-1",
            "results": [{
                "condition": "evidence-only", "ok": True,
                "output": "/case/findings.json", "error": None,
            }],
        }
        normalized = run_ux_experiment.normalize_method_summary(summary, "1")
        self.assertTrue(normalized["ok"])
        self.assertEqual(normalized["analysis_run_id"], "analysis-1")
        self.assertEqual(normalized["output"], "/case/findings.json")

    def test_direct_payload_includes_all_json_and_images_without_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            payload, manifest = run_direct_analysis.response_payload(
                destination, case, "gpt-test", "medium"
            )
            expected_json = 2 + len(list((destination / "evidence").rglob("*.json")))
            self.assertEqual(sum(item["kind"] == "json" for item in manifest), expected_json)
            self.assertEqual(
                sum(item["kind"] == "image" for item in manifest),
                len(case["evidence"]["snapshots"]),
            )
            self.assertEqual(payload["model"], "gpt-test")
            self.assertEqual(payload["reasoning"], {"effort": "medium"})
            self.assertFalse(payload["store"])
            self.assertEqual(payload["tools"], [])
            self.assertEqual(payload["text"]["format"]["type"], "json_schema")
            content_types = [item["type"] for item in payload["input"][0]["content"]]
            self.assertIn("input_text", content_types)
            self.assertIn("input_image", content_types)
            with self.assertRaisesRegex(run_direct_analysis.InputBudgetExceeded, "encoded request"):
                run_direct_analysis.response_payload(
                    destination, case, "gpt-test", "medium", max_input_bytes=10,
                )

    def test_direct_endpoint_must_be_loopback_http(self):
        run_direct_analysis.ensure_loopback("http://127.0.0.1:8317/v1")
        run_direct_analysis.ensure_loopback("http://localhost:8317/v1")
        with self.assertRaisesRegex(ValueError, "loopback"):
            run_direct_analysis.ensure_loopback("https://example.com/v1")

    def test_analysis_run_ids_are_unique_and_latest_tracks_each_harness(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            first = run_agent_analysis.new_analysis_run_id()
            second = run_agent_analysis.new_analysis_run_id()
            self.assertNotEqual(first, second)
            run_agent_analysis.update_latest(output, "codex", first)
            run_agent_analysis.update_latest(output, "direct-one-shot", second)
            latest = json.loads((output / "latest-success.json").read_text(encoding="utf-8"))
            self.assertEqual(latest["runs"]["codex"], first)
            self.assertEqual(latest["runs"]["direct-one-shot"], second)

    def test_direct_trace_only_payload_has_task_and_trace_but_no_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            payload, manifest = run_direct_analysis.response_payload(
                destination, case, "gpt-test", "medium", "trace-only"
            )
            self.assertEqual(
                [item["path"] for item in manifest], ["analysis-case.json", "evidence/trace.json"]
            )
            self.assertTrue(all(item["kind"] == "json" for item in manifest))
            content = payload["input"][0]["content"]
            self.assertNotIn("input_image", [item["type"] for item in content])
            self.assertIn("no screenshots are provided", content[0]["text"])

    def test_direct_trace_only_rejects_snapshot_citations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, attempt = make_attempt(root)
            source = root / "source"
            source.mkdir()
            destination = root / "case"
            case = materialize_case.materialize(attempt, destination, source, {"source": "local"})
            findings = {"schema_version": 2, "attempt_id": "att_001", "findings": [
                valid_finding(snapshot_ids=["s0001"])
            ]}
            with self.assertRaisesRegex(ValueError, "Trace-only"):
                run_direct_analysis.validate_findings(
                    destination, case, findings, allow_snapshot_citations=False
                )


if __name__ == "__main__":
    unittest.main()
