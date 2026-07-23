"""Create and verify a closed, immutable website source snapshot."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile

from .evidence import atomic_write_json, javascript_canonical_json, sha256_file


DEFAULT_EXCLUDES = {".git", "node_modules", ".venv", "__pycache__"}


def _digest(value: object) -> str:
    encoded = javascript_canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _source_files(source: Path, excludes: set[str]) -> list[Path]:
    files = []
    for item in source.rglob("*"):
        relative = item.relative_to(source)
        if any(part in excludes for part in relative.parts):
            continue
        if item.is_symlink():
            raise ValueError(f"Source snapshots forbid symlinks: {relative}")
        if item.is_file():
            files.append(item)
    return sorted(files)


def create_snapshot(
    source: Path,
    output_root: Path,
    excludes: set[str] | None = None,
    max_bytes: int = 250 * 1024 * 1024,
) -> tuple[Path, dict]:
    if source.is_symlink():
        raise ValueError("Source must be a real directory")
    source = source.resolve()
    output_root = output_root.resolve()
    if not source.is_dir():
        raise ValueError("Source must be a real directory")
    if (
        output_root == source
        or output_root in source.parents
        or source in output_root.parents
    ):
        raise ValueError("Source snapshot output must not overlap the source")
    excluded = DEFAULT_EXCLUDES | set(excludes or ())
    files = _source_files(source, excluded)
    size = sum(path.stat().st_size for path in files)
    if not files or size > max_bytes:
        raise ValueError("Source snapshot is empty or exceeds its size limit")
    records = [{
        "path": path.relative_to(source).as_posix(),
        "bytes": path.stat().st_size,
        "sha256": f"sha256:{sha256_file(path)}",
    } for path in files]
    identity = {
        "schemaVersion": "source-snapshot/v1",
        "files": records,
    }
    snapshot_id = f"src_{_digest(identity).removeprefix('sha256:')[:32]}"
    output_root.mkdir(parents=True, exist_ok=True)
    target = output_root / snapshot_id
    if target.exists():
        validate_snapshot(target)
        return target, json.loads(
            (target / "source-manifest.json").read_text(encoding="utf-8")
        )
    stage = Path(tempfile.mkdtemp(prefix=".source-stage-", dir=output_root))
    try:
        content = stage / "files"
        for source_file in files:
            relative = source_file.relative_to(source)
            destination = content / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, destination)
        manifest = {**identity, "sourceSnapshotId": snapshot_id}
        atomic_write_json(stage / "source-manifest.json", manifest)
        os.replace(stage, target)
        return target, manifest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def validate_snapshot(root: Path) -> dict:
    if root.is_symlink():
        raise ValueError("SourceSnapshot forbids symlinks")
    root = root.resolve()
    if any(item.is_symlink() for item in root.rglob("*")):
        raise ValueError("SourceSnapshot forbids symlinks")
    manifest = json.loads(
        (root / "source-manifest.json").read_text(encoding="utf-8")
    )
    records = manifest.get("files")
    if manifest.get("schemaVersion") != "source-snapshot/v1" or not isinstance(
        records, list
    ):
        raise ValueError("Unsupported SourceSnapshot")
    expected = set()
    for record in records:
        relative = PurePosixPath(str(record.get("path") or ""))
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or "\\" in relative.as_posix()
            or ":" in relative.as_posix()
        ):
            raise ValueError("SourceSnapshot has an unsafe path")
        path = root / "files" / Path(*relative.parts)
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size != record.get("bytes")
            or f"sha256:{sha256_file(path)}" != record.get("sha256")
        ):
            raise ValueError(f"SourceSnapshot file mismatch: {relative}")
        expected.add(relative.as_posix())
    actual = {
        path.relative_to(root / "files").as_posix()
        for path in (root / "files").rglob("*") if path.is_file()
    }
    if actual != expected:
        raise ValueError("SourceSnapshot closed file set mismatch")
    identity = {
        key: manifest[key]
        for key in ("schemaVersion", "files")
    }
    expected_id = f"src_{_digest(identity).removeprefix('sha256:')[:32]}"
    if manifest.get("sourceSnapshotId") != expected_id:
        raise ValueError("SourceSnapshot ID mismatch")
    return manifest
