"""Command line entry point for the standalone evaluator."""

from __future__ import annotations

import argparse
from importlib.resources import files
import json
from pathlib import Path
import sys

from .assessment import normalize
from .bundle import validate_bundle
from .materialize import materialize_versioned
from .remediation import create_request
from .source_snapshot import create_snapshot


def _resource(relative: str) -> Path:
    return Path(str(files("ui_usability_evaluator.resources").joinpath(relative)))


def _print(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "evaluate":
        from .method3 import main as evaluate_main
        return evaluate_main(arguments[1:])

    parser = argparse.ArgumentParser(prog="ux-eval")
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate-bundle")
    validate.add_argument("--bundle", required=True)

    materialize = commands.add_parser("materialize")
    materialize.add_argument("--bundle", required=True)
    materialize.add_argument("--output-root", required=True)
    materialize.add_argument(
        "--policy",
        default=str(_resource("policies/frame-policy.method3-v1.json")),
    )
    materialize.add_argument(
        "--calibration",
        default=str(_resource("calibration/method3-recording-alignment-v1.json")),
    )

    normalize_command = commands.add_parser("normalize")
    normalize_command.add_argument("--case", required=True)
    normalize_command.add_argument("--findings", required=True)
    normalize_command.add_argument("--output", required=True)

    remediate = commands.add_parser("prepare-remediation")
    remediate.add_argument("--assessment", required=True)
    remediate.add_argument("--problem-id", action="append", required=True)
    remediate.add_argument("--source-snapshot-id", required=True)
    remediate.add_argument("--output", required=True)

    snapshot = commands.add_parser("snapshot-source")
    snapshot.add_argument("--source", required=True)
    snapshot.add_argument("--output-root", required=True)
    snapshot.add_argument("--exclude", action="append", default=[])

    commands.add_parser(
        "evaluate",
        help="Run the Method 3 provider adapter; use 'ux-eval evaluate --help'.",
    )

    args = parser.parse_args(arguments)
    if args.command == "validate-bundle":
        bundle = validate_bundle(Path(args.bundle))
        _print({
            "schemaVersion": bundle["manifest"]["schemaVersion"],
            "id": bundle["manifest"]["bundleId"],
            "path": str(bundle["root"]),
        })
    elif args.command == "materialize":
        case, path = materialize_versioned(
            Path(args.bundle), Path(args.output_root),
            Path(args.policy), Path(args.calibration),
        )
        _print({
            "schemaVersion": "method3-case/v1",
            "id": case["case_revision_id"],
            "path": str(path),
        })
    elif args.command == "normalize":
        result = normalize(
            Path(args.case), Path(args.findings), Path(args.output)
        )
        _print({
            "schemaVersion": result["schemaVersion"],
            "id": result["assessmentId"],
            "path": str(Path(args.output).resolve()),
        })
    elif args.command == "prepare-remediation":
        result = create_request(
            Path(args.assessment), args.problem_id,
            args.source_snapshot_id, Path(args.output),
        )
        _print({
            "schemaVersion": result["schemaVersion"],
            "id": result["requestId"],
            "path": str(Path(args.output).resolve()),
        })
    elif args.command == "snapshot-source":
        path, result = create_snapshot(
            Path(args.source), Path(args.output_root), set(args.exclude),
        )
        _print({
            "schemaVersion": result["schemaVersion"],
            "id": result["sourceSnapshotId"],
            "path": str(path),
        })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
