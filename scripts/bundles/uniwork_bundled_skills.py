"""Build-only GitCode skills staging; clients consume the resulting offline tree.

An unconfigured standalone native preparation stays offline. Desktop identity
requires this source; a configured source always fails closed, never falls back.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

from scripts.bundles.uniwork_bundled import (
    BUILDER_HOME_ENV, SOURCE_RECORD, TARGET, _fetch, _public_source, _revision,
)

SOURCE_ENV = "UNIWORK_BUNDLED_SKILLS_SOURCE"
REF_ENV = "UNIWORK_BUNDLED_SKILLS_REF"
REQUIRED_ENV = "UNIWORK_BUNDLED_SKILLS_REQUIRED"
RECORD = ".bundled-source.json"
ESSENTIAL = Path("autonomous-ai-agents/hermes-agent")
MARKER = "UNIWORK_BUNDLED_ONLY"


class BundledSkillsError(ValueError):
    """The build cannot prove the bundled skills came from its chosen source."""


def _files(root: Path) -> dict[str, str]:
    """Hash complete resource trees, rejecting links and nonportable paths."""
    if not root.is_dir() or root.is_symlink():
        raise BundledSkillsError(f"invalid skills directory: {root}")
    result = {}
    seen = set()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        parts = path.relative_to(root).parts
        if any(part.endswith((".", " ")) or re.search(r'[<>:"\\|?*\x00-\x1f]', part)
               or part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(
                   f"{prefix}{n}" for prefix in ("COM", "LPT") for n in range(1, 10))}
               for part in parts):
            raise BundledSkillsError(f"nonportable resource path: {relative}")
        mode = path.lstat().st_mode
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)() or not (
            stat.S_ISREG(mode) or stat.S_ISDIR(mode)
        ):
            raise BundledSkillsError(f"linked or special resource: {relative}")
        if relative.casefold() in seen:
            raise BundledSkillsError(f"case-colliding resource: {relative}")
        seen.add(relative.casefold())
        if path.is_file():
            # Native preparation bakes bytecode after recording the source tree;
            # assembly may also omit these reproducible interpreter caches.
            if path.parent.name == "__pycache__" and path.suffix == ".pyc":
                continue
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _skill(path: Path) -> None:
    from hermes_yaml import safe_load, YAMLError

    _files(path)
    md = path / "SKILL.md"
    if not md.is_file():
        raise BundledSkillsError(f"missing SKILL.md: {path.name}")
    text = md.read_text(encoding="utf-8-sig")
    match = re.match(r"\A---\s*\n(.*?)\n---(?:\s*\n|$)", text, re.S)
    try:
        meta = safe_load(match[1]) if match else None
    except YAMLError as exc:
        raise BundledSkillsError(f"invalid frontmatter: {path.name}") from exc
    if not isinstance(meta, dict) or meta.get("name") != path.name or not meta.get("description"):
        raise BundledSkillsError(f"invalid name/description in SKILL.md: {path.name}")


def _public_skills(root: Path) -> list[Path]:
    _files(root)
    skills = sorted(p for p in root.iterdir() if p.is_dir())
    if not skills:
        raise BundledSkillsError("skills/public is empty")
    for skill in skills:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill.name) or skill.name == "hermes-agent":
            raise BundledSkillsError(f"invalid or reserved skill name: {skill.name}")
        _skill(skill)
    return skills


def verify_bundled_skills(root: Path, expected: dict | None = None) -> dict:
    """Verify final payload bytes and exact skill set against build provenance."""
    record = json.loads((root / RECORD).read_text(encoding="utf-8"))
    if expected is not None and record != expected:
        raise BundledSkillsError("bundled skills provenance changed during assembly")
    files = _files(root)
    files.pop(RECORD, None)
    if files != record["files"]:
        expected_files = record["files"]
        missing = sorted(expected_files.keys() - files.keys())
        extra = sorted(files.keys() - expected_files.keys())
        changed = sorted(key for key in files.keys() & expected_files.keys()
                         if files[key] != expected_files[key])
        raise BundledSkillsError(
            f"bundled skills payload differs from source file inventory: {root}; "
            f"missing={missing}, extra={extra}, changed={changed}")
    # Nested reference examples are resources, not standalone installed skills.
    from agent.skill_utils import is_excluded_skill_path
    discovered = {p.parent.relative_to(root).as_posix() for p in root.rglob("SKILL.md")
                  if not is_excluded_skill_path(p.relative_to(root), root=root)}
    wanted = {f"uniwork/{name}" for name in record["skills"]} | {ESSENTIAL.as_posix()}
    if discovered != wanted or not (root / MARKER).is_file():
        raise BundledSkillsError("bundled skills payload has an unexpected skill set")
    return record


def stage_bundled_skills(repo_dir: Path, env: dict[str, str] | None = None) -> int:
    env = os.environ if env is None else env
    source = env.get(SOURCE_ENV, "").strip()
    required = env.get(REQUIRED_ENV) == "1"
    if not source and not required:
        return 0
    if not source or source.lower() == "off":
        raise BundledSkillsError("a bundled skills source is required; local skills are not a fallback")
    if (repo_dir / ".git").exists():
        raise BundledSkillsError("skills staging requires a snapshot, not a Git working tree")
    ref = env.get(REF_ENV, "").strip()
    plugin_record = repo_dir / TARGET / SOURCE_RECORD
    plugins = json.loads(plugin_record.read_text(encoding="utf-8")) if plugin_record.is_file() else None
    # Resolve a moving branch only once: kits already recorded its immutable commit.
    same_source = plugins and plugins["source"] == _public_source(source)
    if same_source and plugins.get("commit") and not ref:
        ref = plugins["commit"]
    with tempfile.TemporaryDirectory(prefix="uniwork-skills-") as temporary:
        checkout = Path(temporary) / "config"
        local = Path(source)
        if local.is_dir() and not ref and not required:
            checkout = local
        else:
            _fetch(str(local.resolve()) if local.is_dir() else source, ref, checkout,
                   env.get(BUILDER_HOME_ENV, ""))
        commit = _revision(checkout)
        if commit:
            # On Windows Git can materialize symlinks as ordinary text files.
            tree = subprocess.check_output(
                ["git", "ls-tree", "-r", commit, "--", "skills/public"], cwd=checkout,
                text=True, timeout=30)
            if any(line.startswith(("120000 ", "160000 ")) for line in tree.splitlines()):
                raise BundledSkillsError("skills/public contains Git symlinks or submodules")
        if (checkout / "skills").is_symlink():
            raise BundledSkillsError("skills/public cannot traverse a symlink")
        if required and not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise BundledSkillsError("required skills source must have a Git commit")
        if plugins and plugins.get("commit") != commit:
            raise BundledSkillsError("skills and bundled plugins must use the same config commit")
        skills = _public_skills(checkout / "skills/public")
        target = repo_dir / "skills"
        _skill(target / ESSENTIAL)
        with tempfile.TemporaryDirectory(prefix=".skills-stage-", dir=repo_dir) as staging:
            clean = Path(staging) / "skills"
            shutil.copytree(target / ESSENTIAL, clean / ESSENTIAL)
            (clean / MARKER).write_text("GitCode build-time distribution\n", encoding="utf-8")
            for skill in skills:
                shutil.copytree(skill, clean / "uniwork" / skill.name)
            record = {"source": _public_source(source), "ref": ref, "commit": commit,
                      "skills": [p.name for p in skills], "files": _files(clean)}
            (clean / RECORD).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            verify_bundled_skills(clean, record)
            backup = Path(staging) / "previous"
            target.rename(backup)
            try:
                clean.rename(target)
            except OSError:
                backup.rename(target)
                raise
    print(f"==> Bundled skills: {_public_source(source)} @ {commit} ({len(skills)} skills)", flush=True)
    return len(skills)


def main() -> None:
    """Create an explicit preview without changing source or existing user homes."""
    import argparse
    from scripts.bundles.uniwork_bundled import DEFAULT_SOURCE

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, required=True, help="new, disposable output directory")
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--ref", default="HEAD")
    args = parser.parse_args()
    args.preview.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parents[2]
    shutil.copytree(repo / "skills" / ESSENTIAL, args.preview / "skills" / ESSENTIAL)
    stage_bundled_skills(args.preview, {**os.environ, SOURCE_ENV: args.source,
                                     REF_ENV: args.ref, REQUIRED_ENV: "1"})
    print(f"Preview ready: HERMES_BUNDLED_SKILLS={args.preview.resolve() / 'skills'}")


if __name__ == "__main__":
    main()
