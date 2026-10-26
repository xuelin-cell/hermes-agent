#!/usr/bin/env python3
"""Set the UniWork desktop product version across every source that records it.

The version lives in four places and they disagree in different ways when one
drifts:

* ``pyproject.toml`` is the authority for a commit build. ``version_at()``
  reads it from ``git show <commit>:pyproject.toml``, never from the worktree,
  so a version that is not committed is not packaged.
* ``apps/desktop/package.json`` feeds electron-builder defaults (FileVersion,
  artifact name when no explicit override is passed).
* ``package-lock.json`` and ``uv.lock`` carry the same value; an unsynced lock
  makes ``npm ci`` / ``uv sync`` believe the tree changed.

The root ``package.json`` is the npm workspace version and is deliberately not
touched: it is not part of the shipped desktop product.

Usage:
    python scripts/releases/set_version.py 1.0.2
    python scripts/releases/set_version.py --bump patch
    python scripts/releases/set_version.py --check
    python scripts/releases/set_version.py 1.0.2 --dry-run
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
BUMPS = ("major", "minor", "patch")

TARGETS = (
    ("pyproject.toml", "[project].version"),
    ("apps/desktop/package.json", "version"),
    ("package-lock.json", 'packages["apps/desktop"].version'),
    ("uv.lock", 'hermes-agent package version'),
)


def repo_root() -> Path:
    """Walk up from this file until the checkout root is found."""
    candidates = [Path(__file__).resolve().parent, Path.cwd().resolve()]
    for start in candidates:
        for parent in (start, *start.parents):
            if (parent / "pyproject.toml").is_file() and (parent / "apps/desktop/package.json").is_file():
                return parent
    raise SystemExit("Cannot locate the repository root (pyproject.toml + apps/desktop/package.json).")


def read_text(path: Path) -> str:
    # newline="" preserves the file's CRLF/LF convention byte for byte.
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def write_text(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def set_pyproject(text: str, version: str) -> str:
    lines = text.splitlines(keepends=True)
    in_project = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[project]":
            in_project = True
            continue
        if in_project and stripped.startswith("["):
            break
        if in_project and re.match(r'^version\s*=\s*"', line):
            lines[index] = re.sub(r'(^version\s*=\s*")[^"]+(")', rf"\g<1>{version}\g<2>", line, count=1)
            return "".join(lines)
    raise SystemExit("pyproject.toml: [project].version not found")


def set_package_json(text: str, version: str) -> str:
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        # The top-level field is the only one indented by exactly two spaces.
        if re.match(r'^  "version"\s*:\s*"', line):
            lines[index] = re.sub(r'(^  "version"\s*:\s*")[^"]+(")', rf"\g<1>{version}\g<2>", line, count=1)
            return "".join(lines)
    raise SystemExit("apps/desktop/package.json: top-level version not found")


def set_package_lock(text: str, version: str) -> str:
    lines = text.splitlines(keepends=True)
    in_desktop = False
    for index, line in enumerate(lines):
        if re.match(r'^    "apps/desktop"\s*:\s*\{', line):
            in_desktop = True
            continue
        if not in_desktop:
            continue
        if re.match(r"^    \}", line):
            break
        if re.match(r'^      "version"\s*:\s*"', line):
            lines[index] = re.sub(r'(^      "version"\s*:\s*")[^"]+(")', rf"\g<1>{version}\g<2>", line, count=1)
            return "".join(lines)
    raise SystemExit('package-lock.json: packages["apps/desktop"].version not found')


def set_uv_lock(text: str, version: str) -> str:
    lines = text.splitlines(keepends=True)
    in_block = False
    is_hermes = False
    for index, line in enumerate(lines):
        if line.strip() == "[[package]]":
            in_block, is_hermes = True, False
            continue
        if not in_block:
            continue
        if line.startswith("[["):
            in_block = False
            continue
        if line.startswith("name = "):
            is_hermes = line.split("=", 1)[1].strip().strip('"') == "hermes-agent"
            continue
        if is_hermes and re.match(r'^version\s*=\s*"', line):
            lines[index] = re.sub(r'(^version\s*=\s*")[^"]+(")', rf"\g<1>{version}\g<2>", line, count=1)
            return "".join(lines)
    raise SystemExit("uv.lock: hermes-agent package version not found")


SETTERS = {
    "pyproject.toml": set_pyproject,
    "apps/desktop/package.json": set_package_json,
    "package-lock.json": set_package_lock,
    "uv.lock": set_uv_lock,
}


def current_version(root: Path) -> str:
    document = tomllib.loads(read_text(root / "pyproject.toml"))
    version = document["project"]["version"]
    if not VERSION_RE.fullmatch(version):
        raise SystemExit(f"pyproject.toml: invalid project.version {version!r}")
    return version


def bump(version: str, kind: str) -> str:
    major, minor, patch = (int(part) for part in version.split("."))
    if kind == "major":
        return f"{major + 1}.0.0"
    if kind == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def validate(root: Path) -> list[str]:
    """Parse every touched file and report versions that still disagree."""
    errors: list[str] = []
    versions: dict[str, str] = {}
    try:
        versions["pyproject.toml"] = tomllib.loads(read_text(root / "pyproject.toml"))["project"]["version"]
    except Exception as error:  # noqa: BLE001 - report, do not traceback
        errors.append(f"pyproject.toml: {error}")
    for relative, label in (
        ("apps/desktop/package.json", "apps/desktop/package.json"),
        ("package-lock.json", "package-lock.json"),
    ):
        try:
            document = json.loads(read_text(root / relative))
            if relative == "package-lock.json":
                versions[label] = document["packages"]["apps/desktop"]["version"]
            else:
                versions[label] = document["version"]
        except Exception as error:  # noqa: BLE001
            errors.append(f"{relative}: {error}")
    try:
        packages = tomllib.loads(read_text(root / "uv.lock"))["package"]
        match = next((item["version"] for item in packages if item.get("name") == "hermes-agent"), None)
        if match is None:
            errors.append("uv.lock: hermes-agent package missing")
        else:
            versions["uv.lock"] = match
    except Exception as error:  # noqa: BLE001
        errors.append(f"uv.lock: {error}")

    distinct = set(versions.values())
    if len(distinct) > 1:
        detail = ", ".join(f"{name}={value}" for name, value in versions.items())
        errors.append(f"version mismatch: {detail}")
    return errors


def uv_lock_check(root: Path) -> str:
    uv = shutil.which("uv")
    if not uv:
        return "skipped (uv not on PATH)"
    result = subprocess.run([uv, "lock", "--check"], cwd=root, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip().splitlines()
        return f"FAILED: {message[-1] if message else result.returncode}"
    return "ok"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("version", nargs="?", help="target version, for example 1.0.2")
    group.add_argument("--bump", choices=BUMPS, help="derive the target from the current version")
    group.add_argument("--check", action="store_true", help="only verify the four sources agree")
    parser.add_argument("--dry-run", action="store_true", help="print the changes without writing")
    args = parser.parse_args(argv)

    root = repo_root()
    current = current_version(root)

    if args.check:
        errors = validate(root)
        if errors:
            for error in errors:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1
        print(f"ok: all four sources report {current}")
        print(f"uv lock --check: {uv_lock_check(root)}")
        return 0

    target = bump(current, args.bump) if args.bump else args.version
    if not VERSION_RE.fullmatch(target):
        print(f"invalid version {target!r}: expected MAJOR.MINOR.PATCH", file=sys.stderr)
        return 2

    print(f"repo:    {root}")
    print(f"current: {current}")
    print(f"target:  {target}")

    changed = 0
    for relative, label in TARGETS:
        path = root / relative
        text = read_text(path)
        updated = SETTERS[relative](text, target)
        if updated != text:
            changed += 1
            print(f"  {relative:<28} {label}")
            if not args.dry_run:
                write_text(path, updated)
        else:
            print(f"  {relative:<28} already {target}")

    if args.dry_run:
        print(f"dry run: {changed} file(s) would change; nothing written")
        return 0

    errors = validate(root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if changed == 0:
        print("nothing to do")
        return 0

    print(f"OK: {changed} file(s) updated to {target}")
    print(f"uv lock --check: {uv_lock_check(root)}")
    print("")
    print("Next:")
    print("  1. commit these files - build-windows-installer.ps1 reads the version from the commit")
    print("  2. git show HEAD:pyproject.toml | Select-String '^version'   (verify the commit, not the worktree)")
    print("  3. .\\build-windows-installer.ps1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
