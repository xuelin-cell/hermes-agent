"""实例引导时按平台策略收起 hermes 上游自带的技能。转发器在拉起 hermes 之前，用 hermes 的 Python 跑这个脚本。

镜像里的自带技能 = hermes 上游的一大套 + 我们的 UniWork 技能（skills/uniwork/）。hermes 每次启动都把自带技能同步进
用户的技能目录；系统提示里列出所有启用的技能（约 3000 token），还要求模型「沾边就先加载」。上游那一大套用户大多
用不上（1Password、TouchDesigner、Apple……），又和 UniWork 的 doc / excel / pdf-generator 重复，既费 token 又会把
agent 带偏。

做法全用 hermes 自己的机制和函数（tools/skills_sync.py、tools/skill_usage.py），口径和 hermes 一致：
- 要收起的技能名写进技能目录的 .curator_suppressed：hermes 的「不再补回」名单，同步时跳过；
- 用户目录里这些技能的副本，没改过的（和同步清单 .bundled_manifest 里记的哈希一样）删掉，并从清单里去掉，以后
  放开时 hermes 当新技能补回来；改过的、agent 自己写的、从技能市场装的不动；
- 平台加进名单的名字另记在 .mt_platform_suppressed：策略放宽时只拿掉平台加的，用户或 hermes 的整理功能加的留着。
hermes 的必需技能（hermes-agent：系统提示固定指向它）hermes 自己就不让收起，这里也不碰。

用法：hermes 的 Python 跑，标准输入给策略 JSON，标准输出回一行 JSON 报告：
    {"keep_categories": ["uniwork"], "keep": ["powerpoint"]}   只留这些分类和点名的上游技能
    {"all": true}                                              全部放开（撤掉平台以前收起的）
HERMES_HOME 指向用户的数据目录（和拉起 hermes 用同一份环境）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from tools import skill_usage, skills_sync

PLATFORM_FILE = ".mt_platform_suppressed"


def _read_names(path: Path) -> set[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return set()
    return {line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")}


def _write_names(path: Path, names: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("".join(f"{name}\n" for name in sorted(names)))
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def apply(policy: dict) -> dict:
    """按策略收起（或放开）上游自带的技能，返回报告。"""
    bundled_dir = skills_sync._get_bundled_dir()
    bundled = skills_sync._discover_bundled_skills(bundled_dir)
    skills_dir = skills_sync._skills_dir()
    if policy.get("all"):
        target: set[str] = set()
    else:
        keep_categories = {str(c) for c in policy.get("keep_categories") or []}
        keep = {str(n) for n in policy.get("keep") or []} | set(skills_sync._essential_names())
        target = {
            name for name, src in bundled
            if src.relative_to(bundled_dir).parts[0] not in keep_categories and name not in keep
        }

    # 名单：这次要收的都在；平台以前加、这次不收的拿掉；用户或整理功能自己加的不动。
    before = skill_usage.read_suppressed_names()
    previous = _read_names(skills_dir / PLATFORM_FILE)
    released = previous - target
    ours = (previous & target) | (target - before)
    after = (before - released) | target
    if after != before:
        skill_usage._write_suppressed_names(after)
    if ours != previous:
        _write_names(skills_dir / PLATFORM_FILE, ours)

    # 副本：没改过的删掉（从清单里去掉，放开时 hermes 当新技能补回），改过的留着。
    manifest = skills_sync._read_manifest()
    removed: list[str] = []
    kept: list[str] = []
    for name, src in bundled:
        if name not in target:
            continue
        dest = skills_sync._compute_relative_dest(src, bundled_dir)
        if not dest.exists():
            continue
        origin = manifest.get(name)
        if origin and skills_sync._dir_hash(dest) == origin:
            skills_sync._rmtree_writable(dest)
            manifest.pop(name, None)
            removed.append(name)
        else:
            kept.append(name)
    if removed:
        skills_sync._write_manifest(manifest)
    return {
        "suppressed": len(target),
        "released": sorted(released),
        "removed": len(removed),
        "kept_modified": sorted(kept),
    }


def main() -> int:
    try:
        policy = json.loads(sys.stdin.read() or "{}")
        if not isinstance(policy, dict):
            raise ValueError("策略不是 JSON 对象")
        print(json.dumps(apply(policy), ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 — 报告给转发器，由它记日志；不挡 hermes 启动
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
