"""Distribution snapshots, PM facts and portable link sealing."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.build.filesystem import remove_build_tree


# Snapshot dirs the sealed agent payload never reads. Tests, docs and CI
# definitions never ship; the frontend/desktop sources and build scripts are
# prebuilt by CI into staged products (AgentInputs.frontends) — a sealed
# payload never re-enters the source-build graph (is_bundled_payload routes
# updates to the channel updater), and linux_desktop_entry degrades to the
# themed icon when apps/desktop/assets is absent. Excluded here means:
# not packaged, not compiled, not baked. Frontend product staging
# (scripts/bundles/stage.py) needs its full tree and passes no exclusions.
INERT_SNAPSHOT_DIRS = (
    "tests", "tests-js", "website", "evals", ".github", "nix", "docker",
    "apps", "ui-tui", "web", "scripts",
)


def snapshot(repo: Path, ref: str, destination: Path, exclude: tuple[str, ...] = ()) -> None:
    """Archive a resolved git revision without carrying checkout metadata."""
    repo, destination = repo.resolve(), destination.resolve()
    if repo == destination or repo.is_relative_to(destination):
        raise ValueError("the snapshot destination must not contain the source checkout")
    with tempfile.TemporaryDirectory(prefix="hermes-archive-") as temp:
        archive = Path(temp) / "source.tar"
        pathspecs = [f":(exclude){name}" for name in exclude]
        subprocess.run(
            ["git", "archive", "--format=tar", "--output", str(archive), ref, "--", *pathspecs],
            cwd=repo, check=True)
        if destination.exists():
            remove_build_tree(destination)
        destination.mkdir(parents=True)
        with tarfile.open(archive) as source:
            source.extractall(destination, filter="data")


def _payload_file(root: Path, relative: str) -> Path:
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"metadata path escapes payload or is symlinked: {path}")
    return path


def _share_metadata(path: Path) -> None:
    # Atomic PM publication stays private; only packaged, non-secret records
    # cross this boundary. Windows installers own their ACL policy.
    if os.name != "nt":
        path.chmod(0o644)


def _discard_build_locks(root: Path) -> None:
    for name in ("venv", "pm-runtime"):
        _payload_file(root, f"{name}/.lock").unlink(missing_ok=True)


def record_tools(root: Path, lock_path: Path, target: str, entries: dict[str, str]) -> None:
    from pm.lock import Facts, Lockfile
    from pm.registry import get_package
    from pm.store import tree_digest

    store = root / "tools"
    facts, lock = Facts(_payload_file(root, "tools/facts.json")), Lockfile(lock_path)
    for name, entry_name in entries.items():
        entry = store / entry_name
        version, artifacts = lock.version(name), lock.artifacts(name, target)
        if not entry.is_dir() or not version or not artifacts:
            raise ValueError(f"incomplete payload tool: {name}")
        facts.record(name, version, entry_name, get_package(name).env(entry, target), store,
                     target=target, artifacts=[a["sha256"] for a in artifacts], digest=tree_digest(entry))
    if entries:
        _share_metadata(facts.path)


def rehash_tools(root: Path) -> int:
    """Record final tool bytes before the enclosing package is signed."""
    from pm.lock import Facts

    store = root / "tools"
    facts = Facts(_payload_file(root, "tools/facts.json"), strict=True)
    count = facts.refresh_digests(store)
    _share_metadata(facts.path)
    return count


def read_precomputed_archive_digests(root: Path) -> dict[str, str]:
    """Read archive component digests from an existing stamp file.

    When rehashing after signing, the archive files (.7z) still exist but the
    original directories don't. The stamp must preserve the directory digests
    (computed before archiving) so the installer can verify extracted directories.
    This function reads those digests from the old stamp.

    Returns a dict mapping component name to its pre-computed directory digest,
    only for components marked as 'archive' in the stamp.
    """
    stamp_path = root / STAMP_NAME
    if not stamp_path.exists():
        return {}
    digests = {}
    for line in stamp_path.read_text(encoding="utf-8").splitlines():
        # Format: "<name> <digest> archive" or "<name> <digest>"
        parts = line.split()
        if len(parts) >= 3 and parts[-1] == "archive" and len(parts[1]) == 64:
            digests[parts[0]] = parts[1]
    return digests


STAMP_NAME = "payload-stamp.txt"
RUNTIME_COMPONENTS = ("venv", "pm-runtime", "uv-cache.zip")
# Components that get archived into .7z on Windows to speed up installation
# (fewer file-creation operations → less AV scanning overhead).
ARCHIVED_COMPONENTS_WIN = ("venv", "hermes-agent")


def archive_component(payload_root: Path, name: str) -> tuple[Path, str]:
    """Pack a component directory into a .7z archive, moving the original to a temp location.

    The archive uses fast compression (-mx=1) because install-time decompression
    speed matters more than package size. Multi-threaded (-mmt=on) for speed.

    Returns (archive_path, original_directory_digest).
    The digest is computed BEFORE archiving so the stamp matches what the installer
    will verify (the extracted directory, not the archive file).

    Instead of deleting the directory immediately (which can be blocked by AV),
    we move it to a temp location within the payload root. The temp directory
    will be cleaned up later by remove_build_tree, which has retry logic.
    """
    import shutil
    import uuid

    source_dir = payload_root / name
    archive = payload_root / f"{name}.7z"

    if not source_dir.is_dir():
        raise ValueError(f"archive_component: {source_dir} is not a directory")

    # Compute digest of the directory BEFORE archiving
    # This is what the installer will verify after extraction
    directory_digest = _stamp_digest(source_dir)

    if archive.exists():
        archive.unlink()

    # Use 7z if available, fall back to Python's lzma module
    seven_zip = shutil.which("7z") or shutil.which("7za")
    if seven_zip:
        subprocess.run(
            [seven_zip, "a", "-t7z", "-mx=1", "-mmt=on", str(archive), str(source_dir)],
            check=True, capture_output=True,
        )
    else:
        # Fallback: create .tar.xz (slower but no external dependency)
        import tarfile
        archive = payload_root / f"{name}.tar.xz"
        with tarfile.open(archive, "w:xz", preset=1) as tar:
            tar.add(source_dir, arcname=name)

    # Move the original directory to a temp location instead of deleting it.
    # This avoids AV file locks that block immediate deletion.
    # The temp directory will be cleaned up by remove_build_tree later.
    temp_dir = payload_root / f".{name}-pending-delete-{uuid.uuid4().hex[:8]}"
    source_dir.rename(temp_dir)

    return archive, directory_digest


def _stamp_digest(path: Path) -> str:
    """Same contract as pm.store.tree_digest, one file at a time (uv-cache.zip
    can be hundreds of MiB; nothing here may hold it in memory)."""
    from pm.store import tree_digest

    if path.is_dir():
        return tree_digest(path)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _find_component_path(root: Path, name: str) -> Path | None:
    """Find a component path: directory, .7z archive, or .tar.xz archive."""
    for suffix in ("", ".7z", ".tar.xz"):
        path = _payload_file(root, f"{name}{suffix}")
        if path.exists():
            return path
    return None


def _is_archive(path: Path) -> bool:
    """Check if a path is a compressed archive (.7z or .tar.xz)."""
    return path.suffix in (".7z", ".xz") and path.is_file()


def write_payload_stamp(root: Path, precomputed_digests: dict[str, str] | None = None) -> Path:
    """Record every runtime component's digest next to the payload.

    An installer compares these lines with the ones the previous build left in
    the install directory: equal digests mean the component a user already has
    is byte-for-byte the component this build ships, so extraction may skip it.
    Digests are recomputed here rather than read back from facts so a stamp can
    never describe bytes other than the ones being shipped.

    Archive components (venv.7z, hermes-agent.7z) are stamped with the digest
    of the original directory (computed before archiving), so the installer can
    verify the extracted directory matches. The stamp format is:
        venv <digest> archive
        hermes-agent <digest> archive
        pm-runtime <digest>
        uv-cache.zip <digest>
        tool <name> <entry> <version> <digest>

    Args:
        root: The payload root directory.
        precomputed_digests: Optional dict mapping component names to their
            pre-computed digests (used for archived components where the
            directory no longer exists at stamp time).
    """
    from pm.lock import Facts
    from pm.store import current_target

    root = root.resolve()
    facts = Facts(_payload_file(root, "tools/facts.json"), strict=True)
    lines = ["schema 1", f"target {current_target()}"]
    precomputed_digests = precomputed_digests or {}
    for name in RUNTIME_COMPONENTS:
        path = _find_component_path(root, name)
        if path is None:
            raise ValueError(f"payload stamp: {name} is missing")
        is_archive = _is_archive(path)
        # Use precomputed digest for archives, otherwise compute from path
        if name in precomputed_digests:
            digest = precomputed_digests[name]
        else:
            digest = _stamp_digest(path)
        if is_archive:
            lines.append(f"{name} {digest} archive")
        else:
            lines.append(f"{name} {digest}")
    # Also stamp hermes-agent if it exists (may be archived)
    hermes_path = _find_component_path(root, "hermes-agent")
    if hermes_path is not None:
        is_archive = _is_archive(hermes_path)
        if "hermes-agent" in precomputed_digests:
            digest = precomputed_digests["hermes-agent"]
        else:
            digest = _stamp_digest(hermes_path)
        if is_archive:
            lines.append(f"hermes-agent {digest} archive")
        else:
            lines.append(f"hermes-agent {digest}")
    tools = 0
    for name, fact in sorted(facts.entries().items()):
        entry = fact.get("entry")
        if entry is None:
            # State rows (venv extras) share the file but own no store entry.
            continue
        entry_path = _payload_file(root, f"tools/{entry}")
        if not entry_path.is_dir():
            raise ValueError(f"payload stamp: tools/{entry} is missing")
        lines.append(f"tool {name} {entry} {fact['version']} {_stamp_digest(entry_path)}")
        tools += 1
    if not tools:
        raise ValueError(f"payload stamp: {facts.path} records no tool entries")
    stamp = root / STAMP_NAME
    stamp.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    _share_metadata(stamp)
    return stamp


def seal_pm_runtime(root: Path, python: Path) -> dict:
    """Record a resident PM runtime without Windows' CWD-bound redirector.

    Sealed workers execute the base interpreter with -I -S and add only the
    recorded site directory. Its paths remain valid after the payload moves.
    """
    root, python = root.resolve(), python.resolve()
    if not python.is_relative_to(root) or not python.is_file():
        raise ValueError(f"PM interpreter must belong to the payload: {python}")
    runtime = root / "pm-runtime"
    sites = list(runtime.glob("lib/python*/site-packages")) + list(runtime.glob("Lib/site-packages"))
    if len(sites) != 1:
        raise ValueError(f"PM dependency directory missing or ambiguous: {runtime}")
    marker = {
        "python": Path(os.path.relpath(python, runtime)).as_posix(),
        "sitePackages": sites[0].relative_to(runtime).as_posix(),
    }
    cfg = _payload_file(root, "pm-runtime/pyvenv.cfg")
    marker_path = _payload_file(root, "pm-runtime/pm-runtime.json")
    lines = cfg.read_text(encoding="utf-8-sig").splitlines()
    lines = [line for line in lines if line.partition("=")[0].strip() not in
             {"home", "executable", "base-executable", "base-prefix", "base-exec-prefix", "command"}]
    lines.insert(0, f"home = {os.path.relpath(python.parent, runtime)}")
    cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # A sealed runtime is not activated, and copied Windows redirectors cannot
    # follow its relative home from arbitrary working directories.
    bindir = runtime / ("Scripts" if os.name == "nt" else "bin")
    for entry in bindir.iterdir():
        if os.name == "nt" or not entry.is_symlink():
            if entry.is_file():
                entry.unlink()
    _relativize_bin_links(root, runtime / "bin")
    marker_path.write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    _share_metadata(marker_path)
    _discard_build_locks(root)
    return marker


def relativize_links(root: Path) -> int:
    """Only dependency-venv links move; framework links belong to codesign."""
    root = root.resolve()
    _discard_build_locks(root)
    return sum(_relativize_bin_links(root, root / name / "bin") for name in ("venv", "pm-runtime"))


def _relativize_bin_links(root: Path, directory: Path) -> int:
    count = 0
    if not directory.is_dir():
        return count
    for link in directory.iterdir():
        if not link.is_symlink():
            continue
        target = os.readlink(link)
        if not os.path.isabs(target):
            # Keep sibling chains intact; their absolute store link is rewritten separately.
            if not Path(os.path.abspath(directory / target)).is_relative_to(root):
                raise ValueError(f"link escapes payload: {link} -> {target}")
            continue
        resolved = (directory / target).resolve()
        if not resolved.is_relative_to(root):
            parts = Path(target).parts
            if "tools" not in parts:
                raise ValueError(f"link escapes payload: {link} -> {target}")
            resolved = root.joinpath(*parts[parts.index("tools"):]).resolve()
        if not resolved.is_relative_to(root) or not resolved.exists():
            raise ValueError(f"missing payload link target: {link} -> {target}")
        relative = os.path.relpath(resolved, directory)
        if relative != target:
            link.unlink()
            link.symlink_to(relative)
            count += 1
    for link in directory.iterdir():
        if link.is_symlink() and (not link.resolve().is_relative_to(root) or not link.exists()):
            raise ValueError(f"invalid relative payload link: {link}")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["relocate", "rehash", "stamp", "archive"])
    parser.add_argument("payload", type=Path)
    parser.add_argument("--platform", choices=["win32", "darwin", "linux"],
                        help="Target platform (required for archive action)")
    args = parser.parse_args()
    if args.action == "rehash":
        # Signing rewrites tool bytes, so the stamp must be republished with
        # the refreshed facts or an upgrade would never match what it installed.
        count = rehash_tools(args.payload)
        print(f"rehashed {count} payload tools")
        # Preserve archive component digests from the old stamp: the directories
        # no longer exist (they were archived), so we must reuse the pre-computed
        # directory digests rather than hashing the .7z files.
        precomputed = read_precomputed_archive_digests(args.payload)
        print(write_payload_stamp(args.payload, precomputed_digests=precomputed or None))
    elif args.action == "stamp":
        print(write_payload_stamp(args.payload))
    elif args.action == "archive":
        # Pack large component directories into archives to speed up installation.
        # Only applies to Windows (other platforms don't have the same AV overhead).
        platform = args.platform or sys.platform
        if platform != "win32":
            print(f"archive: skipping on {platform} (only Windows benefits)")
            return
        precomputed_digests = {}
        archived = []
        for name in ARCHIVED_COMPONENTS_WIN:
            source = args.payload / name
            if source.is_dir():
                archive, directory_digest = archive_component(args.payload, name)
                precomputed_digests[name] = directory_digest
                archived.append(f"{name} -> {archive.name}")
        if archived:
            print(f"archived {len(archived)} component(s): {', '.join(archived)}")
            # Re-stamp with precomputed directory digests
            print(write_payload_stamp(args.payload, precomputed_digests=precomputed_digests))
        else:
            print("archive: no components to archive (already archived or missing)")
    else:
        relativize_links(args.payload)


if __name__ == "__main__":
    main()
