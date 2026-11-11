"""Overlay only bundled PPT packages; retain uploaded packages and user state."""
from __future__ import annotations

import hashlib
import io
import json
import shutil
from pathlib import Path
import zipfile

from . import native_ppt, native_ppt_runtime, store


def package_bytes():
    manifest = {"name": "pptx", "version": "1.0.0-native.10", "displayName": "PPT",
                "description": "原生PPT创建、理解与编辑，逐页检查并交付独立最终版本。"}
    files = {"plugin.json": json.dumps(manifest, ensure_ascii=False).encode("utf-8")}
    for p in native_ppt.SKILL_DIR.rglob("*"):
        if p.is_file() and "__pycache__" not in p.parts:
            files["skills/pptx/" + p.relative_to(native_ppt.SKILL_DIR).as_posix()] = p.read_bytes()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        for name, payload in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 11, 4, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, payload)
    return output.getvalue()


def overlay(home: Path, archives: list[Path], removed=()):
    if not native_ppt_runtime.available():
        return archives
    entries = store.load_index(home).get("plugins", {})
    old = {p.stem: p for p in archives if p.name in {"pptx.zip", "ppt-writer.zip"}}
    previous = entries.get("pptx", {})
    if previous and not native_ppt.installed(home):
        source = old.get("pptx")
        # The builtin seed archive is the provenance proof; a user upload is not replaced.
        if source is None or previous.get("digest") != hashlib.sha256(source.read_bytes()).hexdigest():
            return [p for p in archives if p.stem not in {"pptx", "ppt-writer"}]
        backup = store.imported_root(home) / ".native-ppt/backups" / previous["digest"]
        if not backup.exists():
            backup.mkdir(parents=True)
            root = store.kit_root(home, "pptx")
            if root.is_dir():
                shutil.copytree(root, backup / "installed-skills")
            (backup / "entry.json").write_text(json.dumps(previous, ensure_ascii=False), encoding="utf-8")
    writer = entries.get("ppt-writer", {})
    if writer and "ppt-writer" in old and writer.get("digest") == hashlib.sha256(old["ppt-writer"].read_bytes()).hexdigest():
        from . import installer

        if writer.get("enabled", True):
            installer.set_enabled(home, "ppt-writer", False)
        index = store.load_index(home)
        index["plugins"]["ppt-writer"]["native_retired"] = True
        store.save_index(home, index)
    result = [p for p in archives if p.stem not in {"pptx", "ppt-writer"}]
    if "pptx" in removed:
        return result
    payload = package_bytes()
    archive = store.imported_root(home) / ".native-ppt/pptx.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.is_file() or archive.read_bytes() != payload:
        temp = archive.with_suffix(".tmp")
        temp.write_bytes(payload)
        temp.replace(archive)
    result.append(archive)
    return result


def hide_competing_builtins(home):
    if not native_ppt.installed(home):
        return
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

    with store.scoped_home(home):
        cfg = load_config()
        disabled = get_disabled_skills(cfg)
        retired = {"office/pptx-scripted-decks", "uniwork/uniai-ppt"}
        if not retired.issubset(disabled):
            save_disabled_skills(cfg, disabled | retired)
