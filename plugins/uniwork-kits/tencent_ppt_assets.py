"""Transport the complete PPT sidecar through a private Git assets repository."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

if __package__:
    from .tencent_ppt_bundle import REQUIRED_FILES, probe_node
else:
    from tencent_ppt_bundle import REQUIRED_FILES, probe_node


def sha256(path: Path) -> str:
    """Hash a file without loading a runtime archive into memory."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pack(source: Path, destination: Path, chunk_bytes: int = 32 * 1024 * 1024) -> dict:
    """Archive only engine and Node, split into ordinary Git binary files."""
    source, destination = source.resolve(), destination.resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Runtime source and distribution must not overlap")
    if chunk_bytes <= 0:
        raise ValueError("Chunk size must be positive")
    for name in REQUIRED_FILES:
        if not (source / name).is_file():
            raise FileNotFoundError(name)
    node = probe_node(source)
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="ppt-archive-") as temporary:
        archive_path = Path(temporary) / "runtime.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            for folder in ("engine", "node"):
                for path in sorted((source / folder).rglob("*")):
                    if path.is_symlink():
                        raise ValueError(f"Runtime must not contain symlinks: {path}")
                    if path.is_file():
                        archive.write(path, path.relative_to(source).as_posix())
        parts = []
        with archive_path.open("rb") as stream:
            while block := stream.read(chunk_bytes):
                name = f"runtime.zip.part{len(parts):03d}"
                (destination / name).write_bytes(block)
                parts.append({"name": name, "bytes": len(block), "sha256": hashlib.sha256(block).hexdigest()})
        manifest = {
            "schema": 1, "platform": "windows-x64", "node": node,
            "archive_bytes": archive_path.stat().st_size, "archive_sha256": sha256(archive_path), "parts": parts,
        }
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def unpack(distribution: Path, destination: Path) -> None:
    """Verify every chunk and safe archive path before creating a sidecar."""
    distribution, destination = distribution.resolve(), destination.resolve()
    if destination.exists():
        raise FileExistsError(destination)
    manifest = json.loads((distribution / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or manifest.get("platform") != "windows-x64" or not manifest.get("parts"):
        raise ValueError("Unsupported PPT runtime distribution manifest")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ppt-unpack-", dir=destination.parent) as temporary:
        temporary_path = Path(temporary)
        archive_path = temporary_path / "runtime.zip"
        with archive_path.open("wb") as output:
            for index, part in enumerate(manifest["parts"]):
                if part["name"] != f"runtime.zip.part{index:03d}":
                    raise ValueError("Invalid runtime chunk order or path")
                path = distribution / part["name"]
                if path.stat().st_size != part["bytes"] or sha256(path) != part["sha256"]:
                    raise ValueError(f"Runtime chunk checksum mismatch: {path.name}")
                with path.open("rb") as stream:
                    shutil.copyfileobj(stream, output)
        if archive_path.stat().st_size != manifest["archive_bytes"] or sha256(archive_path) != manifest["archive_sha256"]:
            raise ValueError("Runtime archive checksum mismatch")
        with zipfile.ZipFile(archive_path) as archive:
            seen = set()
            for member in archive.infolist():
                path = PurePosixPath(member.filename)
                if ("\\" in member.orig_filename or path.is_absolute() or ".." in path.parts or not path.parts
                        or path.parts[0] not in {"engine", "node"} or ":" in member.filename
                        or (member.external_attr >> 16) & 0o170000 == 0o120000 or member.filename in seen):
                    raise ValueError(f"Unsafe runtime archive entry: {member.filename}")
                seen.add(member.filename)
            if not set(REQUIRED_FILES).issubset(seen):
                raise ValueError("Runtime archive is incomplete")
            # The destination is a fresh, build-owned directory, never an
            # installed runtime. Extract there before executing Node: Windows
            # may retain executable/scanner handles after the probe exits,
            # making a subsequent directory rename fail with WinError 5.
            destination.mkdir()
            try:
                archive.extractall(destination)
                probe_node(destination)
            except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
                try:
                    shutil.rmtree(destination)
                except OSError as cleanup_error:
                    error.add_note(f"Could not remove incomplete build runtime {destination}: {cleanup_error}")
                raise


def main() -> None:
    """Provide a dependency-free build tool, before PyInstaller is invoked."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("pack")
    create.add_argument("--source", type=Path, required=True)
    create.add_argument("--destination", type=Path, required=True)
    restore = sub.add_parser("unpack")
    restore.add_argument("--distribution", type=Path, required=True)
    restore.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "pack":
        manifest = pack(args.source, args.destination)
        print(f"PPT runtime packed: {len(manifest['parts'])} parts, {manifest['archive_bytes']} bytes")
    else:
        unpack(args.distribution, args.destination)
        print(f"PPT runtime verified and extracted: {args.destination}")


if __name__ == "__main__":
    main()
