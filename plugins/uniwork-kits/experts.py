"""Experts as the summon picker sees them, and which were summoned lately.

数字员工 summoned an expert from the chat box: a picker with the five most
recent and all experts, a new conversation with the expert, its opening prompt
in the input and its quick prompts as cards. Here an expert is a profile, so a
summon opens a new chat in that profile; this module serves the directory and
remembers the order. Read from the default profile's index, where every
installed expert has a pointer entry.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from . import store

RECENT_FILE = "expert_recent.json"
MAX_RECENT = 5


def _recent_path(home: Path) -> Path:
    """「最近召唤」名单的文件位置。"""
    return store.imported_root(home) / RECENT_FILE


def _installed(home: Path) -> Dict[str, Dict[str, Any]]:
    """已装、并且对应档案还存在的专家（不含专家档案里自己的那条）。"""
    from hermes_cli.profiles import profile_exists

    out: Dict[str, Dict[str, Any]] = {}
    for name, entry in sorted((store.load_index(home).get("plugins") or {}).items()):
        if not isinstance(entry, dict) or entry.get("kind") != "expert" or entry.get("self"):
            continue
        profile = str(entry.get("profile") or "")
        if profile and profile_exists(profile):
            out[name] = entry
    return out


def _row(name: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    """召唤名单里一位专家需要的字段。"""
    intro = entry.get("intro") if isinstance(entry.get("intro"), dict) else {}
    return {
        "name": name,
        "profile": str(entry.get("profile") or ""),
        "display_name": str(entry.get("display_name") or name),
        "profession": str(entry.get("profession") or ""),
        "description": str(intro.get("description") or ""),
        "init_prompt": str(intro.get("init_prompt") or ""),
        "quick_prompts": [str(p) for p in intro.get("quick_prompts") or [] if str(p).strip()],
        "tags": [str(t) for t in intro.get("tags") or [] if str(t).strip()],
    }


def _read_recent(home: Path) -> List[str]:
    """读出最近召唤的专家名；文件缺失或损坏时当作没有。"""
    try:
        data = json.loads(_recent_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [str(n) for n in data if isinstance(n, str)] if isinstance(data, list) else []


def directory(home: Path) -> Dict[str, Any]:
    """召唤名单：全部仍然装着的专家，加上最近召唤的几位。"""
    installed = _installed(home)
    recent = [name for name in _read_recent(home) if name in installed][:MAX_RECENT]
    return {"experts": [_row(name, entry) for name, entry in installed.items()], "recent": recent}


_AVATAR_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


def avatar_data_url(home: Path, name: str) -> str:
    """专家头像转成 data URL，和机器人名单的画法一致；没有头像返回空字符串。

    位图在档案的 assets/ 里；小的 SVG 存在 profile.yaml 的 ui_meta['hermes-bots'].image 里（见安装器）。
    """
    import base64

    from hermes_cli.profiles import get_profile_dir

    from . import yaml_compat

    entry = _installed(home).get(name)
    if entry is None:
        return ""
    phome = Path(get_profile_dir(str(entry.get("profile") or "")))
    for ext, mime in _AVATAR_MIME.items():
        path = phome / "assets" / f"avatar.{ext}"
        if path.is_file():
            return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    try:
        meta = yaml_compat.safe_load((phome / "profile.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, yaml_compat.YAMLError):
        return ""
    ui = meta.get("ui_meta") if isinstance(meta, dict) else None
    image = ((ui or {}).get("hermes-bots") or {}).get("image") if isinstance(ui, dict) else None
    return image if isinstance(image, str) and image.startswith("data:image/") else ""


def record_recent(home: Path, name: str) -> List[str]:
    """把这位专家挪到「最近召唤」的最前面；不认识的名字直接拒绝。"""
    from .installer import KitError

    if name not in _installed(home):
        raise KitError(f"没有装 {name} 这个专家")
    recent = [name] + [n for n in _read_recent(home) if n != name]
    path = _recent_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    from utils import atomic_json_write

    atomic_json_write(path, recent[:MAX_RECENT])
    return recent[:MAX_RECENT]
