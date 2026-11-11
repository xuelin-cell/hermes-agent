"""Authoritative bundled-skill sync for the UniWork offline distribution.

The GitCode payload is the desired state for ``skills/uniwork`` and the
essential ``autonomous-ai-agents/hermes-agent`` skill. The normal Hermes sync
protects edits and deletions; this distribution instead converges those
package-owned paths after an in-place app upgrade while leaving unrelated user
and Hub skills alone.
"""

from __future__ import annotations

import json
import logging
import re
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

from agent.skill_utils import ESSENTIAL_SKILLS, is_excluded_skill_path
from tools.skill_usage import skill_file_lock
from utils import atomic_write_text

logger = logging.getLogger("tools.skills_sync")

DISTRIBUTION_STATE = ".bundled-distribution.json"
ARCHIVE_ROOT = ".retired-hermes"
ESSENTIAL_PATH = "autonomous-ai-agents/hermes-agent"
INSTALL_RECORD = ".bundled-source.json"
DISTRIBUTION_ID = "uniwork-gitcode-public"
_SAFE_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _ss():
    """Resolve the live facade so profile overrides and tests patch one place."""
    from tools import skills_sync

    return skills_sync


def _skill_dirs(root: Path) -> List[Path]:
    """Direct real skill directories in a managed namespace."""
    if not root.is_dir():
        return []
    result = []
    for child in sorted(root.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if skill_md.is_file() and not is_excluded_skill_path(
                skill_md.relative_to(root.parent), root=root.parent):
            result.append(child)
    return result


def _read_install_record(bundled_dir: Path, *, required: bool) -> Optional[dict]:
    path = bundled_dir / INSTALL_RECORD
    if not path.exists():
        if required:
            raise ValueError(f"bundled UniWork install record is missing: {path}")
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"bundled UniWork install record is invalid: {path}") from exc
    if not isinstance(record, dict):
        raise ValueError(f"bundled UniWork install record must be an object: {path}")
    return record


def _declared_skill_names(record: Optional[dict]) -> Optional[List[str]]:
    if record is None:
        return None
    declared = record.get("skills")
    if not isinstance(declared, list) or not all(isinstance(name, str) for name in declared):
        raise ValueError("bundled UniWork install record has no skill inventory")
    names = sorted(declared)
    if len(set(names)) != len(names):
        raise ValueError("bundled UniWork install record has duplicate skill names")
    invalid = [name for name in names if not _SAFE_NAME.fullmatch(name)]
    if invalid:
        raise ValueError(f"bundled UniWork install record has invalid skill names: {invalid}")
    if "hermes-agent" in names:
        raise ValueError("bundled UniWork install record cannot declare the essential hermes-agent skill")
    return names


def _record_file_hashes(record: Optional[dict]) -> Optional[Dict[str, str]]:
    if record is None:
        return None
    files = record.get("files")
    if not isinstance(files, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in files.items()):
        raise ValueError("bundled UniWork install record has no file inventory")
    return {key: value.lower() for key, value in files.items()}


def _package_desired(
    bundled_dir: Path, *, record_required: bool
) -> Tuple[Dict[str, Path], Optional[dict], Set[str]]:
    """Canonical path -> source, package provenance, and ordinary skill names."""
    record = _read_install_record(bundled_dir, required=record_required)
    names = _declared_skill_names(record)
    root = bundled_dir / "uniwork"
    directories = _skill_dirs(root)
    by_name = {path.name: path for path in directories}
    ordinary = set(names) if names is not None else set(by_name)
    if names is not None:
        missing = sorted(ordinary - set(by_name))
        extra = sorted(set(by_name) - ordinary)
        if missing or extra:
            raise ValueError(
                f"bundled UniWork skill inventory mismatch: missing={missing}, extra={extra}")
    desired = {name: by_name[name] for name in sorted(ordinary)}
    essential = bundled_dir / ESSENTIAL_PATH
    if not essential.is_dir() or not (essential / "SKILL.md").is_file():
        raise ValueError(f"bundled essential skill is missing: {ESSENTIAL_PATH}")
    desired["hermes-agent"] = essential
    return desired, record, ordinary


def _package_file_hashes(source: Path, bundled_dir: Path) -> Dict[str, str]:
    import hashlib

    result = {}
    for path in sorted(source.rglob("*")):
        if (not path.is_file() or path.is_symlink()
                or _ss()._is_runtime_cache(path, source)):
            continue
        relative = path.relative_to(bundled_dir).as_posix()
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _verify_package_sources(
    desired: Dict[str, Path], record: Optional[dict], bundled_dir: Path
) -> None:
    inventory = _record_file_hashes(record)
    if inventory is None:
        return
    for name, source in desired.items():
        actual = _package_file_hashes(source, bundled_dir)
        if not actual:
            raise ValueError(f"bundled skill has no files: {name}")
        for relative, digest in actual.items():
            expected = inventory.get(relative)
            if expected is None:
                raise ValueError(f"bundled skill file is absent from install record: {relative}")
            if digest.lower() != expected:
                raise ValueError(f"bundled skill file hash mismatch: {relative}")
        prefix = source.relative_to(bundled_dir).as_posix() + "/"
        declared = {path for path in inventory if path.startswith(prefix)}
        missing = sorted(declared - set(actual))
        if missing:
            raise ValueError(f"bundled skill files are missing: {missing}")


def _relative_path(path: Path, skills_dir: Path) -> str:
    return path.relative_to(skills_dir).as_posix()


def _archive_path(name: str) -> Path:
    """Unique hidden archive outside the skill scanner's active namespaces."""
    root = _ss()._skills_dir() / ARCHIVE_ROOT
    candidate = root / name
    index = 2
    while candidate.exists():
        candidate = root / f"{name}-{index}"
        index += 1
    return candidate


def _transaction_path(name: str) -> Path:
    root = _ss()._skills_dir() / ARCHIVE_ROOT / ".transactions"
    candidate = root / name
    index = 2
    while candidate.exists():
        candidate = root / f"{name}-{index}"
        index += 1
    return candidate


def _manifest_origin(manifest: Dict[str, str], name: str) -> str:
    return manifest.get(name, "")


def _path_is_old_origin(
    path: Path, name: str, manifest: Dict[str, str]
) -> bool:
    if path.is_symlink() or not path.is_dir():
        return False
    origin = _manifest_origin(manifest, name)
    return bool(origin) and _ss()._matches_origin_hash(path, origin)


def _remove_or_archive(name: str, path: Path, manifest: Dict[str, str]) -> str:
    ss = _ss()
    if _path_is_old_origin(path, name, manifest):
        ss._rmtree_writable(path)
        return "pristine"
    ss._move_dir(path, _archive_path(name))
    return "modified"


def _safe_skip_symlink(path: Path, *, quiet: bool) -> None:
    message = f"  ! Skipping unknown symlink in UniWork namespace: {path}"
    logger.warning(message.strip())
    if not quiet:
        print(message)


def _retire_manifest_paths(
    skills_dir: Path,
    desired_paths: Set[Path],
    manifest: Dict[str, str],
    hub_paths: Set[str],
    *,
    quiet: bool,
) -> Tuple[List[str], List[str], List[str]]:
    """Retire stale package-owned paths in both current and historical layouts."""
    removed: List[str] = []
    archived: List[str] = []
    cleaned_manifest: Set[str] = set()
    ss = _ss()

    # Manifests from older releases contain names but not paths. Build a
    # name -> active-path index so category layouts such as
    # ``skills/devops/foo`` are retired alongside ``skills/uniwork/foo``.
    active_by_name: Dict[str, List[Path]] = {}
    for skill_md in ss._iter_active_skill_mds(sort=True):
        path = skill_md.parent
        if path in desired_paths:
            continue
        for name in {path.name, ss._read_skill_name(skill_md, path.name)}:
            if name:
                active_by_name.setdefault(name, []).append(path)

    for name in sorted(manifest):
        if name in ESSENTIAL_SKILLS:
            continue
        candidates: List[Path] = []
        seen: Set[Path] = set()
        for path in active_by_name.get(name, []):
            if path in desired_paths or path in seen:
                continue
            seen.add(path)
            candidates.append(path)
        if not candidates:
            cleaned_manifest.add(name)
            continue

        unmanaged = False
        for path in candidates:
            if not path.exists() and not path.is_symlink():
                continue
            try:
                relative = _relative_path(path, skills_dir)
            except ValueError:
                unmanaged = True
                continue
            if path.is_symlink():
                _safe_skip_symlink(path, quiet=quiet)
                unmanaged = True
                continue
            if relative in hub_paths:
                # The Hub still owns this path. It is not a bundled skill, so
                # remove only the stale package provenance for this name.
                continue
            try:
                outcome = _remove_or_archive(name, path, manifest)
            except (OSError, ValueError) as exc:
                logger.warning("Could not retire UniWork skill %s: %s", path, exc)
                if not quiet:
                    print(f"  ! Failed to retire {name}: {exc}")
                unmanaged = True
                continue
            (archived if outcome == "modified" else removed).append(name)
        if not unmanaged:
            cleaned_manifest.add(name)
    return removed, archived, sorted(cleaned_manifest)


def _install_or_replace(
    name: str, source: Path, destination: Path, manifest: Dict[str, str]
) -> str:
    """Make a desired path byte-for-byte match the package with recovery."""
    ss = _ss()
    package_hash = ss._dir_hash(source)
    if destination.is_dir() and not destination.is_symlink() and ss._dir_hash(destination) == package_hash:
        return "unchanged"
    existed = destination.exists() or destination.is_symlink()
    rollback: Optional[Path] = None
    customized = False
    if existed:
        rollback = _transaction_path(name)
        ss._move_dir(destination, rollback)
        customized = not _path_is_old_origin(rollback, name, manifest)
    try:
        ss._copy_dir(source, destination)
    except OSError:
        if destination.is_dir() and not destination.is_symlink():
            with suppress(OSError, ValueError):
                ss._rmtree_writable(destination)
        elif destination.exists() or destination.is_symlink():
            destination.unlink()
        if rollback is not None and rollback.exists() and not destination.exists():
            ss._move_dir(rollback, destination)
        raise
    if rollback is None:
        return "copied"
    if customized:
        archive = _archive_path(name)
        ss._move_dir(rollback, archive)
    else:
        with suppress(OSError):
            ss._rmtree_writable(rollback)
    return "updated"


def _load_hub_lock() -> Optional[dict]:
    from tools.skills_sync_optional import _load_hub_lock as load

    return load()


def _drop_conflicting_hub_entries(desired_paths: Set[Path]) -> List[str]:
    """Remove Hub lock entries only for canonical paths taken over by this package."""
    ss = _ss()
    skills_dir = ss._skills_dir()
    desired = {_relative_path(path, skills_dir) for path in desired_paths}
    data = _load_hub_lock()
    installed = data.get("installed") if isinstance(data, dict) else None
    if not isinstance(installed, dict):
        return []
    dropped = []
    for key, entry in list(installed.items()):
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("install_path") or "").strip("/")
        if path in desired:
            installed.pop(key, None)
            dropped.append(str(key))
    if dropped:
        atomic_write_text(
            ss._skills_dir() / ".hub" / "lock.json",
            tmp_prefix=".lock_",
            content=json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        )
    return dropped


def _drop_suppressed(desired_names: Iterable[str]) -> List[str]:
    path = _ss()._skills_dir() / ".curator_suppressed"
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return []
    desired = set(desired_names)
    kept = [line for line in lines if line.strip() not in desired]
    removed = sorted({line.strip() for line in lines if line.strip() in desired})
    if removed:
        atomic_write_text(path, tmp_prefix=".curator_suppressed_", content="\n".join(kept) + ("\n" if kept else ""))
    return removed


def _distribution_state(
    desired: Dict[str, Path],
    record: Optional[dict],
    bundled_dir: Path,
    *,
    status: str,
    error: Optional[str] = None,
    last_success_at: Optional[str] = None,
) -> dict:
    managed = {}
    for name, source in desired.items():
        managed[name] = {
            "relative_path": source.relative_to(bundled_dir).as_posix(),
            "content_hash": _ss()._dir_hash(source),
        }
    state = {
        "schema_version": 1,
        "distribution": DISTRIBUTION_ID,
        "policy": "authoritative",
        "source_commit": (record or {}).get("commit", ""),
        "desired_skills": sorted(name for name in desired if name not in ESSENTIAL_SKILLS),
        "essential_skills": sorted(name for name in desired if name in ESSENTIAL_SKILLS),
        "managed": managed,
        "sync_status": status,
    }
    if last_success_at is not None:
        state["last_success_at"] = last_success_at
    if error is not None:
        state["error"] = error
    return state


def _write_distribution_state(state: dict) -> None:
    atomic_write_text(
        _ss()._skills_dir() / DISTRIBUTION_STATE,
        tmp_prefix=".bundled_distribution_",
        content=json.dumps(state, ensure_ascii=False, indent=2) + "\n",
    )


def _read_previous_success() -> Optional[str]:
    path = _ss()._skills_dir() / DISTRIBUTION_STATE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    value = data.get("last_success_at") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def _active_ordinary_names(
    skills_dir: Path, retained_hub_paths: Optional[Set[str]] = None
) -> List[str]:
    retained = retained_hub_paths or set()
    return sorted(
        path.name for path in _skill_dirs(skills_dir / "uniwork")
        if _relative_path(path, skills_dir) not in retained
    )


def _mark_failure_from_existing(error: str) -> None:
    """Record a package-validation failure without discarding last known state."""
    skills_dir = _ss()._skills_dir()
    with suppress(OSError):
        skills_dir.mkdir(parents=True, exist_ok=True)
    path = skills_dir / DISTRIBUTION_STATE
    data: dict = {}
    with suppress(OSError, json.JSONDecodeError, ValueError):
        previous = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(previous, dict):
            data = previous
    data.update({
        "schema_version": 1,
        "distribution": DISTRIBUTION_ID,
        "policy": "authoritative",
        "sync_status": "failed",
        "error": error,
    })
    with suppress(Exception):
        _write_distribution_state(data)


def _destination_for(name: str, source: Path, bundled_dir: Path, skills_dir: Path) -> Path:
    relative = source.relative_to(bundled_dir).as_posix()
    if name in ESSENTIAL_SKILLS:
        if relative != ESSENTIAL_PATH:
            raise ValueError(f"unexpected bundled essential path: {relative}")
        return skills_dir / ESSENTIAL_PATH
    return skills_dir / "uniwork" / name


def sync_uniwork_skills(bundled_dir: Path, quiet: bool = False) -> dict:
    """Authoritatively converge a HERMES_HOME to the current UniWork payload."""
    ss = _ss()
    skills_dir = ss._skills_dir()
    skills_dir.mkdir(parents=True, exist_ok=True)
    try:
        desired, record, ordinary = _package_desired(bundled_dir, record_required=True)
        if not ordinary:
            raise ValueError("UniWork bundle contains no ordinary bundled skills")
        _verify_package_sources(desired, record, bundled_dir)
    except Exception as exc:
        _mark_failure_from_existing(f"{type(exc).__name__}: {exc}")
        raise
    desired_paths = {
        _destination_for(name, source, bundled_dir, skills_dir)
        for name, source in desired.items()
    }
    lock_path = skills_dir / ".bundled-distribution.lock"
    copied: List[str] = []
    updated: List[str] = []
    unchanged: List[str] = []
    retired_pristine: List[str] = []
    retired_modified: List[str] = []
    cleaned_manifest: List[str] = []
    dropped_suppressed: List[str] = []
    dropped_hub: List[str] = []
    previous_success = _read_previous_success()
    with skill_file_lock(lock_path):
        in_progress = _distribution_state(
            desired, record, bundled_dir, status="in_progress",
            last_success_at=previous_success)
        _write_distribution_state(in_progress)
        try:
            manifest = ss._read_manifest()
            hub_paths = ss._read_hub_install_paths()
            retired_pristine, retired_modified, cleaned_manifest = _retire_manifest_paths(
                skills_dir, desired_paths, manifest, hub_paths, quiet=quiet)
            dropped_hub = _drop_conflicting_hub_entries(desired_paths)
            dropped_suppressed = _drop_suppressed(set(desired))
            for name, source in sorted(desired.items()):
                destination = _destination_for(name, source, bundled_dir, skills_dir)
                outcome = _install_or_replace(name, source, destination, manifest)
                if outcome == "copied":
                    copied.append(name)
                elif outcome == "updated":
                    updated.append(name)
                else:
                    unchanged.append(name)
            retained_hub_paths = ss._read_hub_install_paths()
            actual = _active_ordinary_names(skills_dir, retained_hub_paths)
            expected = sorted(ordinary)
            if actual != expected:
                raise ValueError(
                    f"authoritative UniWork skill set mismatch: actual={actual}, expected={expected}")
            for name, source in desired.items():
                destination = _destination_for(name, source, bundled_dir, skills_dir)
                if not destination.is_dir() or destination.is_symlink():
                    raise ValueError(f"authoritative bundled skill is missing: {name}")
                if ss._dir_hash(source) != ss._dir_hash(destination):
                    raise ValueError(f"authoritative bundled skill bytes differ: {name}")

            retained = {
                name: origin for name, origin in manifest.items()
                if (name not in ordinary and name not in ESSENTIAL_SKILLS
                    and name not in cleaned_manifest)
            }
            for name, source in desired.items():
                retained[name] = ss._dir_hash(source)
            from hermes_constants import mkdir_under_hermes_home
            mkdir_under_hermes_home(ss._manifest_file().parent)
            atomic_write_text(
                ss._manifest_file(),
                tmp_prefix=".bundled_manifest_",
                preserve_mode=True,
                content="".join(f"{name}:{digest}\n" for name, digest in sorted(retained.items())),
            )
            completed_at = datetime.now(timezone.utc).isoformat()
            _write_distribution_state(_distribution_state(
                desired, record, bundled_dir, status="complete",
                last_success_at=completed_at))
        except Exception as exc:
            failed = _distribution_state(
                desired, record, bundled_dir, status="failed",
                error=f"{type(exc).__name__}: {exc}", last_success_at=previous_success)
            with suppress(Exception):
                _write_distribution_state(failed)
            raise
    result = {
        "copied": copied,
        "updated": updated,
        "skipped": len(unchanged),
        "user_modified": [],
        "cleaned": cleaned_manifest,
        "suppressed": dropped_suppressed,
        "relocated": [],
        "total_bundled": len(desired),
        "optional_provenance_backfilled": [],
        "shadowed_by_external": [],
        "retired_pristine": retired_pristine,
        "retired_modified": retired_modified,
        "skipped_opt_out": False,
        "authoritative_uniwork": True,
        "desired_builtin": sorted(ordinary),
        "actual_builtin": actual,
        "hub_conflicts_dropped": dropped_hub,
    }
    if not quiet:
        print(
            "Bundled skills authoritative sync: "
            f"{len(ordinary)} package skills, {len(copied)} added, "
            f"{len(updated)} updated, {len(retired_pristine) + len(retired_modified)} retired"
        )
    return result
