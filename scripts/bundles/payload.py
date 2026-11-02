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


STAMP_NAME = "payload-stamp.txt"
RUNTIME_COMPONENTS = ("venv", "pm-runtime", "uv-cache.zip")


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


def write_payload_stamp(root: Path) -> Path:
    """Record every runtime component's digest next to the payload.

    An installer compares these lines with the ones the previous build left in
    the install directory: equal digests mean the component a user already has
    is byte-for-byte the component this build ships, so extraction may skip it.
    Digests are recomputed here rather than read back from facts so a stamp can
    never describe bytes other than the ones being shipped.
    """
    from pm.lock import Facts
    from pm.store import current_target

    root = root.resolve()
    facts = Facts(_payload_file(root, "tools/facts.json"), strict=True)
    lines = ["schema 1", f"target {current_target()}"]
    for name in RUNTIME_COMPONENTS:
        path = _payload_file(root, name)
        if not path.exists():
            raise ValueError(f"payload stamp: {name} is missing")
        lines.append(f"{name} {_stamp_digest(path)}")
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
    parser.add_argument("action", choices=["relocate", "rehash", "stamp"])
    parser.add_argument("payload", type=Path)
    args = parser.parse_args()
    if args.action == "rehash":
        # Signing rewrites tool bytes, so the stamp must be republished with
        # the refreshed facts or an upgrade would never match what it installed.
        count = rehash_tools(args.payload)
        print(f"rehashed {count} payload tools")
        print(write_payload_stamp(args.payload))
    elif args.action == "stamp":
        print(write_payload_stamp(args.payload))
    else:
        relativize_links(args.payload)


if __name__ == "__main__":
    main()
