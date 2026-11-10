"""构建云端镜像时按 bundled-skills.list 收窄 UniWork 预制技能（Dockerfile.cube 调用，兼容 Python 3.6）。

办公、设计类能力由配置仓库的套件提供：镜像带了套件才收窄，没带就全部保留，免得这些能力没有来源。
删掉的技能交给实例引导时的 sync_skills 处理（tools/skills_sync.py）：用户没改过的副本删除，
改过的移进 .retired-hermes；以后加回清单会重新装上。

用法：prune_bundled_skills.py <清单> <预制技能目录> <套件目录>
"""
import shutil
import sys
from pathlib import Path


def read_list(path):
    names = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        name = line.split('#', 1)[0].strip()
        if not name:
            continue
        if '/' in name or name in ('.', '..'):
            raise ValueError('预制技能清单里只能写目录名：' + name)
        names.append(name)
    return names


def ships_kits(kits_dir):
    return Path(kits_dir).is_dir() and any(Path(kits_dir).glob('*.zip'))


def prune(skills_dir, keep, kits_dir):
    """返回 (保留, 删除)；不带套件时什么也不动。清单里有目录里没有的技能就报错，不悄悄少一个。"""
    skills_dir = Path(skills_dir)
    present = sorted(p.name for p in skills_dir.iterdir() if p.is_dir())
    if not ships_kits(kits_dir):
        return present, []
    if not keep:
        raise ValueError('预制技能清单是空的')
    missing = sorted(set(keep) - set(present))
    if missing:
        raise ValueError('预制技能清单里的技能不在 {}：{}'.format(skills_dir, ', '.join(missing)))
    removed = [name for name in present if name not in keep]
    for name in removed:
        shutil.rmtree(str(skills_dir / name))
    return sorted(keep), removed


def main(argv):
    list_path, skills_dir, kits_dir = argv
    kept, removed = prune(skills_dir, read_list(list_path), kits_dir)
    if ships_kits(kits_dir):
        print('预制技能保留 {} 个：{}；移除 {} 个：{}'.format(
            len(kept), ', '.join(kept), len(removed), ', '.join(removed) or '-'))
    else:
        print('镜像没带套件，预制技能全部保留（{} 个）'.format(len(kept)))


if __name__ == '__main__':
    main(sys.argv[1:])
