"""将当前账号的 UniWork 技能声明名转换为明确路径，避免套件目录短名误匹配。"""

from pathlib import Path
from typing import Any

from agent.skill_utils import (
    get_external_skills_dirs,
    get_project_skills_dirs,
    iter_skill_index_files,
    parse_frontmatter,
)
from hermes_constants import get_hermes_home

from . import store


def _matches(root: Path, name: str) -> list[tuple[Path, dict]]:
    """保留声明名和目录短名的全部候选，不能让转换掩盖真正的重名。"""
    matches = []
    for path in iter_skill_index_files(root, "SKILL.md"):
        frontmatter, _ = parse_frontmatter(path.read_text(encoding="utf-8-sig", errors="replace"))
        if path.parent.name == name or frontmatter.get("name") == name:
            matches.append((path, frontmatter))
    # 旧式单文件技能也交给原生规则处理，不能因路径转换而被覆盖。
    matches.extend((path, {}) for path in root.rglob(f"{name}.md"))
    return matches


def _managed(path: Path, frontmatter: dict, root: Path, index: dict) -> bool:
    """只认当前账号内置技能和套件登记的技能，不认领用户或外部目录。"""
    relative = path.relative_to(root)
    if path.name != "SKILL.md" or not store.is_within(root, path):
        return False
    if relative.parts[0] == "uniwork":
        return True
    if len(relative.parts) < 3 or relative.parts[0] != store.KITS_DIRNAME:
        return False
    plugin = relative.parts[1]
    entry = index.get("plugins", {}).get(plugin)
    if not isinstance(entry, dict):
        return False
    names = set(entry.get("skill_names") or []) | set(entry.get("agent_skill_names") or [])
    return frontmatter.get("name") in names


def _relative_path(home: Path, name: str) -> str | None:
    """从当前账号实时生成唯一声明名的相对路径，不缓存跨账号或过期的安装位置。"""
    root = home / "skills"
    candidates = _matches(root, name)
    exact = [(path, fm) for path, fm in candidates if fm.get("name", path.parent.name) == name]
    if len(exact) != 1:
        return None
    index = store.load_index(home)
    if not all(_managed(path, fm, root, index) for path, fm in candidates):
        return None
    target = exact[0][0].parent.relative_to(root)
    if target.parts[0] == store.KITS_DIRNAME and not index["plugins"][target.parts[1]].get("enabled", True):
        return None
    # 项目技能优先级、外部技能冲突和隔离状态全部保留原生判断，不擅自选本地副本。
    for other in [*get_project_skills_dirs(), *get_external_skills_dirs()]:
        if other.resolve() == root.resolve():
            continue
        if _matches(other, name):
            return None
    return target.as_posix()


def on_pre_tool_call(tool_name: str = "", args: Any = None, **_: Any):
    """唯一声明名才转换；显式路径、真正冲突或读取失败继续交给原生工具判断。"""
    if tool_name != "skill_view" or not isinstance(args, dict):
        return None
    name = args.get("name")
    if not isinstance(name, str) or not name or any(char in name for char in "/\\:*?[]"):
        return None
    try:
        relative = _relative_path(Path(get_hermes_home()), name)
    except OSError:
        # 并发卸载或无权读取时不猜选，也不让辅助解析盖过原生工具的错误信息。
        return None
    if relative is None:
        return None
    return {"action": "modify", "args": {**args, "name": relative}}
