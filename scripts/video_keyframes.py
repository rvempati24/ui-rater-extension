#!/usr/bin/env python3
"""Deterministically derive NAPsack-style action-burst frames from a WebM trace."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import shutil
import statistics
import subprocess
from typing import NamedTuple

try:
    from scripts.ux_evidence import atomic_write_json, canonical_sha256, sha256_file
except ModuleNotFoundError:
    from ux_evidence import atomic_write_json, canonical_sha256, sha256_file


FAMILY_BY_KIND = {
    "click": "click", "rightclick": "click",
    "mousemove": "move", "scroll": "scroll", "keydown": "key",
}
SEMANTIC_KINDS = {
    "input", "change", "focus", "formsubmit", "navigate", "pagehide", "pageload",
}
DOCUMENT_BOUNDARIES = {"pagehide", "pageload"}
FAMILY_ORDER = {"click": 0, "move": 1, "scroll": 2, "key": 3}
ROLE_ORDER = {"before": 0, "after": 1}


class FramePoint(NamedTuple):
    index: int
    pts_ms: float


class VideoEvidenceIneligible(ValueError):
    """The attempt cannot enter the primary video-derived condition."""


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_policy(policy: dict) -> None:
    if policy.get("schema_version") != 1 or not policy.get("policy_id"):
        raise ValueError("Unsupported frame policy")
    for family in FAMILY_ORDER:
        threshold = policy.get("burst_thresholds_ms", {}).get(family)
        if not isinstance(threshold, dict) or threshold.get("gap", 0) <= 0 or threshold.get("max_duration", 0) <= 0:
            raise ValueError(f"Missing burst policy for {family}")


def validate_events(trace: dict | list) -> list[dict]:
    raw = trace.get("interactions") if isinstance(trace, dict) else trace
    if not isinstance(raw, list):
        raise ValueError("trace interactions must be an array")
    events: list[dict] = []
    prior_seq = 0
    for position, item in enumerate(raw):
        if not isinstance(item, dict) or not isinstance(item.get("kind"), str):
            raise ValueError(f"Invalid trace event at position {position}")
        seq = item.get("seq")
        ts = item.get("ts")
        if not isinstance(seq, int) or seq <= prior_seq:
            raise ValueError("Trace seq values must be unique and strictly increasing")
        if not isinstance(ts, (int, float)) or not math.isfinite(ts) or ts < 0:
            raise ValueError(f"Invalid trace timestamp at seq {seq}")
        events.append(item)
        prior_seq = seq
    return events


def _burst(family: str, events: list[dict]) -> dict:
    return {
        "event_family": family,
        "events": events,
        "start_trace_ms": float(events[0]["ts"]),
        "end_trace_ms": float(events[-1]["ts"]),
        "event_seq": [event["seq"] for event in events],
        "action_ids": sorted({str(event["action_id"]) for event in events if event.get("action_id")}),
        "semantic_events": [],
    }


def _split_overlong(family: str, events: list[dict]) -> tuple[list[dict], list[dict]]:
    # NAPsack finalizes the first half and keeps the second half active. For an
    # odd count, the earlier half receives the extra event.
    midpoint = (len(events) + 1) // 2
    return events[:midpoint], events[midpoint:]


def build_bursts(events: list[dict], policy: dict) -> tuple[list[dict], list[dict]]:
    """Group same-family events using policy thresholds and stable server order."""
    validate_policy(policy)
    active: dict[str, list[dict]] = {}
    completed: list[dict] = []

    def flush(family: str) -> None:
        current = active.pop(family, [])
        if current:
            completed.append(_burst(family, current))

    for event in events:
        kind = event["kind"]
        if kind in DOCUMENT_BOUNDARIES:
            for family in list(active):
                flush(family)
            continue
        family = FAMILY_BY_KIND.get(kind)
        if not family:
            continue
        threshold = policy["burst_thresholds_ms"][family]
        current = active.get(family, [])
        if not current:
            active[family] = [event]
            continue
        gap = float(event["ts"]) - float(current[-1]["ts"])
        duration = float(event["ts"]) - float(current[0]["ts"])
        if gap > threshold["gap"]:
            flush(family)
            active[family] = [event]
            continue
        candidate = [*current, event]
        if duration > threshold["max_duration"]:
            finalized, carried = _split_overlong(family, candidate)
            completed.append(_burst(family, finalized))
            active[family] = carried
        else:
            active[family] = candidate
    for family in list(active):
        flush(family)

    completed.sort(key=lambda row: (
        row["start_trace_ms"], row["event_seq"][0], FAMILY_ORDER[row["event_family"]]
    ))
    for index, burst in enumerate(completed, 1):
        burst["burst_id"] = f"b{index:04d}"

    semantic = [event for event in events if event["kind"] in SEMANTIC_KINDS]
    uncovered: list[dict] = []
    window = float(policy.get("semantic_attachment_window_ms", 1500))
    for event in semantic:
        action_id = event.get("action_id")
        candidates = [burst for burst in completed if action_id and action_id in burst["action_ids"]]
        if not candidates:
            candidates = [
                burst for burst in completed
                if 0 <= float(event["ts"]) - burst["end_trace_ms"] <= window
            ]
        if candidates:
            target = min(candidates, key=lambda burst: (
                abs(float(event["ts"]) - burst["end_trace_ms"]), burst["event_seq"][0]
            ))
            target["semantic_events"].append(event)
        else:
            uncovered.append({
                "seq": event["seq"], "kind": event["kind"], "ts": event["ts"],
                "action_id": action_id, "reason": "no-nearby-low-level-burst",
            })
    for burst in completed:
        burst["semantic_events"] = sorted(burst["semantic_events"], key=lambda event: event["seq"])
    return completed, uncovered


def build_frame_requests(bursts: list[dict], timing: dict, policy: dict) -> list[dict]:
    offset = timing.get("trace_to_video_offset_ms")
    if not isinstance(offset, (int, float)) or not math.isfinite(offset):
        raise ValueError("recording timing has no valid trace_to_video_offset_ms")
    before = float(policy["offsets_ms"]["before_first_event"])
    after = float(policy["offsets_ms"]["after_last_event"])
    requests = []
    for burst in bursts:
        for role, anchor, delta in (
            ("before", burst["start_trace_ms"], before),
            ("after", burst["end_trace_ms"], after),
        ):
            requests.append({
                "burst_id": burst["burst_id"], "frame_role": role,
                "event_family": burst["event_family"],
                "event_seq": burst["event_seq"], "action_ids": burst["action_ids"],
                "anchor_trace_ts_ms": anchor,
                "anchor_video_ts_ms": float(offset) + anchor,
                "requested_video_ts_ms": float(offset) + anchor + delta,
            })
    return sorted(requests, key=lambda row: (
        row["requested_video_ts_ms"], row["event_seq"][0],
        FAMILY_ORDER[row["event_family"]], ROLE_ORDER[row["frame_role"]],
    ))


def choose_frame(points: list[FramePoint], requested_ms: float) -> tuple[FramePoint, bool]:
    if not points:
        raise VideoEvidenceIneligible("Recording has no decodable video frames")
    clamped = requested_ms < points[0].pts_ms or requested_ms > points[-1].pts_ms
    target = min(max(requested_ms, points[0].pts_ms), points[-1].pts_ms)
    # The tuple's second item deliberately chooses the earlier frame on a tie.
    chosen = min(points, key=lambda point: (abs(point.pts_ms - target), point.pts_ms, point.index))
    return chosen, clamped


def _run_json(command: list[str]) -> dict:
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _tool_record(executable: str) -> dict:
    resolved = shutil.which(executable)
    if not resolved:
        raise VideoEvidenceIneligible(f"Required tool is unavailable: {executable}")
    version = subprocess.run([resolved, "-version"], check=True, capture_output=True, text=True).stdout
    return {"path": resolved, "sha256": sha256_file(Path(resolved)), "version": version.strip()}


def probe_video(recording: Path, ffprobe: str = "ffprobe") -> tuple[list[FramePoint], dict]:
    tool = _tool_record(ffprobe)
    streams = _run_json([
        tool["path"], "-v", "error", "-show_streams", "-select_streams", "v",
        "-of", "json", str(recording),
    ]).get("streams", [])
    if len(streams) != 1:
        raise VideoEvidenceIneligible("Recording must contain exactly one video stream")
    rows = _run_json([
        tool["path"], "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(recording),
    ]).get("frames", [])
    raw: list[float] = []
    for row in rows:
        try:
            value = float(row["best_effort_timestamp_time"]) * 1000.0
        except (KeyError, TypeError, ValueError):
            raise VideoEvidenceIneligible("A decodable frame is missing best_effort_timestamp_time")
        if not math.isfinite(value):
            raise VideoEvidenceIneligible("A video frame has a non-finite PTS")
        raw.append(value)
    if not raw:
        raise VideoEvidenceIneligible("Recording has no decodable frames")
    origin = raw[0]
    points = [FramePoint(index=index, pts_ms=value - origin) for index, value in enumerate(raw)]
    if any(right.pts_ms <= left.pts_ms for left, right in zip(points, points[1:])):
        raise VideoEvidenceIneligible("Frame PTS values are not strictly increasing")
    return points, {"stream": streams[0], "pts_origin_ms": origin, "ffprobe": tool}


def validate_calibration(calibration: dict, policy: dict, manifest: dict) -> dict:
    expected = policy["calibration"]
    if calibration.get("status") != expected["required_status"]:
        raise VideoEvidenceIneligible("Recording alignment calibration has not passed")
    if calibration.get("method_id") != expected["method_id"]:
        raise VideoEvidenceIneligible("Recording alignment calibration method mismatch")
    statistic = calibration.get("error_statistic") or {}
    value = statistic.get("value_ms")
    if statistic.get("name") != expected["error_statistic"] or not isinstance(value, (int, float)):
        raise VideoEvidenceIneligible("Recording alignment calibration statistic is invalid")
    if value < 0 or value > expected["max_allowed_ms"]:
        raise VideoEvidenceIneligible("Recording alignment calibration exceeds policy")
    profile = (manifest.get("recording_timing") or {}).get("capture_profile") or {}
    calibrated_profile = calibration.get("capture_profile")
    if calibrated_profile and profile.get("profile_id") != calibrated_profile:
        raise VideoEvidenceIneligible("Attempt capture profile does not match calibration")
    return calibration


def _parse_pgm(path: Path) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    if not data.startswith(b"P5\n"):
        raise ValueError("Unexpected PGM output")
    header, pixels = data.split(b"\n255\n", 1)
    dimensions = header.splitlines()[-1].split()
    return int(dimensions[0]), int(dimensions[1]), pixels


def _dhash(path: Path) -> int:
    width, height, pixels = _parse_pgm(path)
    if (width, height) != (17, 16) or len(pixels) != width * height:
        raise ValueError("Unexpected dHash image dimensions")
    value = 0
    for y in range(height):
        for x in range(16):
            value = (value << 1) | int(pixels[y * width + x] > pixels[y * width + x + 1])
    return value


def _extract_selected(
    recording: Path, frame_indices: list[int], snapshots: Path, ffmpeg: str,
    max_width: int, max_height: int,
) -> dict:
    tool = _tool_record(ffmpeg)
    expression = "+".join(f"eq(n\\,{index})" for index in frame_indices)
    output_pattern = snapshots / "v%04d.jpg"
    command = [
        tool["path"], "-v", "error", "-i", str(recording), "-map", "0:v:0",
        "-vf", f"select={expression},scale={max_width}:{max_height}:force_original_aspect_ratio=decrease,format=yuvj420p",
        "-vsync", "0", "-threads", "1", "-map_metadata", "-1", "-q:v", "4",
        "-start_number", "1", str(output_pattern),
    ]
    subprocess.run(command, check=True, capture_output=True)
    images = sorted(snapshots.glob("v*.jpg"))
    if len(images) != len(frame_indices):
        raise VideoEvidenceIneligible("ffmpeg did not write every selected frame exactly once")
    hash_dir = snapshots.parent / ".dhash"
    hash_dir.mkdir()
    subprocess.run([
        tool["path"], "-v", "error", "-start_number", "1", "-i", str(output_pattern),
        "-vf", "scale=17:16,format=gray", "-threads", "1", "-start_number", "1",
        str(hash_dir / "h%04d.pgm"),
    ], check=True, capture_output=True)
    hashes = [_dhash(path) for path in sorted(hash_dir.glob("h*.pgm"))]
    shutil.rmtree(hash_dir)
    if len(hashes) != len(images):
        raise VideoEvidenceIneligible("Could not compute every frame diagnostic hash")
    return {"ffmpeg": tool, "images": images, "dhashes": hashes}


def derive_video_keyframes(
    recording: Path,
    trace: dict,
    manifest: dict,
    output_dir: Path,
    policy: dict,
    calibration: dict,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
) -> dict:
    validate_policy(policy)
    timing = manifest.get("recording_timing") or {}
    validate_calibration(calibration, policy, manifest)
    events = validate_events(trace)
    bursts, uncovered = build_bursts(events, policy)
    if not bursts:
        raise VideoEvidenceIneligible("Trace contains no supported low-level event bursts")
    requests = build_frame_requests(bursts, timing, policy)
    points, probe = probe_video(recording, ffprobe)
    gaps = [right.pts_ms - left.pts_ms for left, right in zip(points, points[1:])]
    median_fps = 1000.0 / statistics.median(gaps) if gaps else 0.0
    limits = policy["output"]
    if median_fps < limits["min_median_fps"]:
        raise VideoEvidenceIneligible("Recording cadence is below the frame policy")

    by_index: dict[int, dict] = {}
    for request in requests:
        point, clamped = choose_frame(points, request["requested_video_ts_ms"])
        association = {
            **request,
            "actual_video_ts_ms": point.pts_ms,
            "offset_from_anchor_ms": point.pts_ms - request["anchor_video_ts_ms"],
            "clamped": clamped,
        }
        by_index.setdefault(point.index, {"point": point, "associations": []})["associations"].append(association)
    selected = [by_index[index] for index in sorted(by_index)]
    if len(selected) > limits["max_frames"] or len(selected) > limits["max_model_images"]:
        raise VideoEvidenceIneligible("Selected frame count exceeds policy; no sampling was performed")
    selected_indices = [row["point"].index for row in selected]
    max_gap = float(limits["max_frame_gap_ms"])
    for index in selected_indices:
        neighbor_gaps = []
        if index > 0:
            neighbor_gaps.append(points[index].pts_ms - points[index - 1].pts_ms)
        if index + 1 < len(points):
            neighbor_gaps.append(points[index + 1].pts_ms - points[index].pts_ms)
        if neighbor_gaps and max(neighbor_gaps) > max_gap:
            raise VideoEvidenceIneligible("A selected burst boundary crosses an excessive frame gap")
    output_dir.mkdir(parents=True, exist_ok=False)
    snapshots = output_dir / "snapshots"
    snapshots.mkdir()
    extracted = _extract_selected(
        recording, selected_indices, snapshots, ffmpeg,
        int(limits["max_width"]), int(limits["max_height"]),
    )

    image_records = []
    index_to_snapshot: dict[int, str] = {}
    total_bytes = 0
    stream_width = int(probe["stream"].get("width") or limits["max_width"])
    stream_height = int(probe["stream"].get("height") or limits["max_height"])
    scale = min(limits["max_width"] / stream_width, limits["max_height"] / stream_height)
    output_width = max(1, round(stream_width * scale))
    output_height = max(1, round(stream_height * scale))
    pixels_per_image = output_width * output_height
    tokens_per_image = 85 + 170 * math.ceil(output_width / 512) * math.ceil(output_height / 512)
    total_pixels_estimate = 0
    total_image_tokens_estimate = 0
    for ordinal, (row, image, dhash) in enumerate(zip(selected, extracted["images"], extracted["dhashes"]), 1):
        snapshot_id = f"v{ordinal:04d}"
        expected = snapshots / f"{snapshot_id}.jpg"
        if image != expected:
            image.rename(expected)
            image = expected
        index_to_snapshot[row["point"].index] = snapshot_id
        total_bytes += image.stat().st_size
        total_pixels_estimate += pixels_per_image
        total_image_tokens_estimate += tokens_per_image
        metadata = {
            "schema_version": 1, "snapshot_id": snapshot_id,
            "source": "video-derived", "image_file": image.name,
            "frame_index": row["point"].index,
            "actual_video_ts_ms": row["point"].pts_ms,
            "policy_id": policy["policy_id"],
            "dhash_16x16": f"{dhash:064x}",
            "associations": row["associations"],
        }
        atomic_write_json(image.with_suffix(".json"), metadata)
        image_records.append(metadata)
    if total_bytes > limits["max_total_image_bytes"]:
        raise VideoEvidenceIneligible("Selected image bytes exceed policy; no sampling was performed")
    if total_pixels_estimate > limits["max_total_pixels"]:
        raise VideoEvidenceIneligible("Selected image pixel estimate exceeds policy")
    if total_image_tokens_estimate > limits["max_estimated_image_tokens"]:
        raise VideoEvidenceIneligible("Selected image token estimate exceeds policy")

    burst_by_id = {burst["burst_id"]: burst for burst in bursts}
    for burst in bursts:
        related = [
            (index, row) for index, row in by_index.items()
            if any(item["burst_id"] == burst["burst_id"] for item in row["associations"])
        ]
        roles = {}
        for index, row in related:
            for item in row["associations"]:
                if item["burst_id"] == burst["burst_id"]:
                    roles[item["frame_role"]] = index
        if "before" in roles and "after" in roles:
            before_hash = int(next(item["dhash_16x16"] for item in image_records if item["snapshot_id"] == index_to_snapshot[roles["before"]]), 16)
            after_hash = int(next(item["dhash_16x16"] for item in image_records if item["snapshot_id"] == index_to_snapshot[roles["after"]]), 16)
            burst["pair_diagnostic"] = {
                "method": "dhash-16x16-hamming",
                "distance": bin(before_hash ^ after_hash).count("1"),
            }

    sequence_items = []
    for metadata in image_records:
        associations = metadata["associations"]
        io_by_seq = {}
        for association in associations:
            if association["frame_role"] != "before":
                continue
            burst = burst_by_id[association["burst_id"]]
            for event in [*burst["events"], *burst["semantic_events"]]:
                io_by_seq[event["seq"]] = event
        sequence_items.append({
            "snapshot_id": metadata["snapshot_id"],
            "actual_video_ts_ms": metadata["actual_video_ts_ms"],
            "associations": associations,
            "event_seq": sorted({seq for item in associations for seq in item["event_seq"]}),
            "io_events": [io_by_seq[seq] for seq in sorted(io_by_seq)],
        })
    sequence_items.sort(key=lambda item: (
        item["actual_video_ts_ms"], item["event_seq"][0], item["snapshot_id"]
    ))
    segment_size = int(policy.get("segment_frames", 60))
    sequence = {
        "schema_version": 1, "policy_id": policy["policy_id"],
        "segment_frames": segment_size,
        "segments": [
            {"segment_index": start // segment_size + 1, "items": sequence_items[start:start + segment_size]}
            for start in range(0, len(sequence_items), segment_size)
        ],
    }
    atomic_write_json(output_dir / "model-input-sequence.json", sequence)

    calibration_hash = calibration.get("_artifact_file_sha256") or canonical_sha256(calibration)
    selection = {
        "schema_version": 1,
        "policy": {"policy_id": policy["policy_id"], "policy_sha256": canonical_sha256(policy)},
        "calibration": {"method_id": calibration["method_id"], "artifact_sha256": calibration_hash},
        "recording": {
            "path": "evidence/recording.webm", "sha256": sha256_file(recording),
            "duration_ms": points[-1].pts_ms, "video_stream_index": 0,
            "median_fps": median_fps, "frame_count": len(points),
            "derived_width": output_width, "derived_height": output_height,
            "estimated_image_tokens": total_image_tokens_estimate,
            "ffmpeg": extracted["ffmpeg"], "ffprobe": probe["ffprobe"],
        },
        "timing": timing,
        "bursts": bursts, "frames": image_records,
        "uncovered_semantic_events": uncovered,
        "deduplicated_request_count": len(requests) - len(selected),
        "warnings": [],
    }
    atomic_write_json(output_dir / "frame-selection.json", selection)
    return selection


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--recording", required=True)
    parser.add_argument("--trace", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--policy", default=str(Path(__file__).with_name("frame-policy.method3-v1.json")))
    parser.add_argument("--calibration", default=str(Path(__file__).parents[1] / "calibration" / "method3-recording-alignment-v1.json"))
    args = parser.parse_args()
    calibration = load_json(Path(args.calibration))
    calibration["_artifact_file_sha256"] = sha256_file(Path(args.calibration))
    selection = derive_video_keyframes(
        Path(args.recording), load_json(Path(args.trace)), load_json(Path(args.manifest)),
        Path(args.output), load_json(Path(args.policy)), calibration,
    )
    print(json.dumps({"ok": True, "frames": len(selection["frames"]), "output": args.output}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
