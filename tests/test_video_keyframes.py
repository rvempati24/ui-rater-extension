import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "video_keyframes.py"
SPEC = importlib.util.spec_from_file_location("video_keyframes", SCRIPT)
video_keyframes = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(video_keyframes)


POLICY = json.loads((Path(__file__).resolve().parents[1] / "scripts" / "frame-policy.method3-v1.json").read_text())


class VideoKeyframePolicyTests(unittest.TestCase):
    def test_same_type_events_group_without_cross_family_merging(self):
        events = video_keyframes.validate_events({"interactions": [
            {"seq": 1, "kind": "click", "ts": 100, "action_id": "a"},
            {"seq": 2, "kind": "keydown", "ts": 110, "key": "x"},
            {"seq": 3, "kind": "click", "ts": 250, "action_id": "b"},
            {"seq": 4, "kind": "formsubmit", "ts": 260, "action_id": "b"},
        ]})
        bursts, uncovered = video_keyframes.build_bursts(events, POLICY)
        self.assertEqual([row["event_family"] for row in bursts], ["click", "key"])
        click = next(row for row in bursts if row["event_family"] == "click")
        self.assertEqual(click["event_seq"], [1, 3])
        self.assertEqual([row["seq"] for row in click["semantic_events"]], [4])
        self.assertEqual(uncovered, [])

    def test_document_boundary_restarts_bursts(self):
        events = video_keyframes.validate_events({"interactions": [
            {"seq": 1, "kind": "scroll", "ts": 0},
            {"seq": 2, "kind": "pagehide", "ts": 100},
            {"seq": 3, "kind": "pageload", "ts": 150},
            {"seq": 4, "kind": "scroll", "ts": 200},
        ]})
        bursts, _ = video_keyframes.build_bursts(events, POLICY)
        self.assertEqual([row["event_seq"] for row in bursts], [[1], [4]])

    def test_max_duration_finalizes_first_half_and_carries_second(self):
        policy = json.loads(json.dumps(POLICY))
        policy["burst_thresholds_ms"]["key"] = {"gap": 1000, "max_duration": 20}
        events = video_keyframes.validate_events({"interactions": [
            {"seq": index + 1, "kind": "keydown", "ts": index * 10}
            for index in range(5)
        ]})
        bursts, _ = video_keyframes.build_bursts(events, policy)
        self.assertEqual([row["event_seq"] for row in bursts], [[1, 2], [3, 4, 5]])

    def test_requests_use_measured_offset_and_paper_offsets(self):
        bursts = [{
            "burst_id": "b0001", "event_family": "click", "event_seq": [1],
            "action_ids": ["a"], "start_trace_ms": 100, "end_trace_ms": 120,
        }]
        requests = video_keyframes.build_frame_requests(
            bursts, {"trace_to_video_offset_ms": 200}, POLICY
        )
        self.assertEqual([row["requested_video_ts_ms"] for row in requests], [225, 395])
        self.assertEqual([row["frame_role"] for row in requests], ["before", "after"])

    def test_clamping_and_tie_break_choose_earlier_frame(self):
        points = [
            video_keyframes.FramePoint(0, 0.0),
            video_keyframes.FramePoint(1, 100.0),
        ]
        self.assertEqual(video_keyframes.choose_frame(points, 50)[0].index, 0)
        self.assertTrue(video_keyframes.choose_frame(points, -10)[1])
        self.assertTrue(video_keyframes.choose_frame(points, 110)[1])

    def test_rejects_duplicate_or_non_monotonic_server_seq(self):
        with self.assertRaisesRegex(ValueError, "strictly increasing"):
            video_keyframes.validate_events({"interactions": [
                {"seq": 2, "kind": "click", "ts": 0},
                {"seq": 2, "kind": "click", "ts": 1},
            ]})

    def test_pending_calibration_is_ineligible(self):
        with self.assertRaisesRegex(video_keyframes.VideoEvidenceIneligible, "has not passed"):
            video_keyframes.validate_calibration({
                "status": "pending", "method_id": POLICY["calibration"]["method_id"],
            }, POLICY, {"recording_timing": {}})

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg unavailable")
    def test_synthetic_webm_derives_distinct_boundary_frames(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            recording = root / "recording.webm"
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                "testsrc2=size=320x240:rate=30:duration=2", "-c:v", "ffv1", "-f", "matroska",
                str(recording),
            ], check=True)
            calibration = {
                "schema_version": 1,
                "method_id": POLICY["calibration"]["method_id"], "status": "passed",
                "capture_profile": "tab-vp8-30fps-v1", "sample_count": 30,
                "error_statistic": {"name": "p95_absolute_ms", "value_ms": 20, "max_allowed_ms": 50},
            }
            manifest = {"recording_timing": {
                "trace_to_video_offset_ms": 100,
                "capture_profile": {"profile_id": "tab-vp8-30fps-v1", "frame_rate": 30},
            }}
            trace = {"interactions": [{"seq": 1, "kind": "click", "ts": 500}]}
            result = video_keyframes.derive_video_keyframes(
                recording, trace, manifest, root / "derived", POLICY, calibration
            )
            self.assertEqual(len(result["frames"]), 2)
            self.assertEqual(
                {association["frame_role"] for frame in result["frames"] for association in frame["associations"]},
                {"before", "after"},
            )


if __name__ == "__main__":
    unittest.main()
