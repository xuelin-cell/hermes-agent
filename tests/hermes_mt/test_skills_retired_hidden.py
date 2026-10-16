"""退役技能的隐藏归档不出现在技能列表里。

tools/skills_sync.py 把用户改过、已不再发行的内置技能移进技能目录下的 .retired-hermes/ 当归档；
技能页（/api/skills）和 agent 列技能都按 agent/skill_utils.py 的 EXCLUDED_SKILL_DIRS 跳过目录。
归档目录不在这份清单里，老用户换代后技能页和 agent 都会看到新旧两份。上游一改目录名或清单，这里先报出来。
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_the_retired_skills_archive_is_skipped_when_listing_skills() -> None:
    sync = (REPO / "tools" / "skills_sync.py").read_text(encoding="utf-8")
    utils = (REPO / "agent" / "skill_utils.py").read_text(encoding="utf-8")
    archive = re.search(r'def _retired_archive_path\(.*?_skills_dir\(\) / "(\.[\w-]+)"', sync, re.S)
    excluded = re.search(r"^EXCLUDED_SKILL_DIRS = frozenset\(\((.*?)^\)\)", utils, re.M | re.S)
    assert archive, "tools/skills_sync.py 里找不到退役技能的归档目录"
    assert excluded, "agent/skill_utils.py 里找不到 EXCLUDED_SKILL_DIRS"
    assert f'"{archive.group(1)}"' in excluded.group(1)
