"""``hermes kit`` — install and manage WorkBuddy / UniClaw kits and experts."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Tuple

from . import installer


def _add_profile(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--profile",
        help="目标 profile（默认是当前 profile）。专家总是装成独立的 profile，这个选项只影响套件。",
    )


def setup(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="kit_command")

    p = sub.add_parser("inspect", help="只解析包、打印检查结果，不写任何文件")
    p.add_argument("paths", nargs="+", help="插件 zip 或已解压的目录")
    p.add_argument("--triggers", help="UniClaw 的 plugin_index.json，用来导入中文触发词")
    p.add_argument("--allow-builtin-overlap", action="store_true", help="兼容旧参数。和内置技能重名时总会装成「套件--技能」，不再跳过")

    p = sub.add_parser("install", help="安装套件或专家")
    p.add_argument("paths", nargs="+", help="插件 zip 或已解压的目录")
    _add_profile(p)
    p.add_argument("--triggers", help="UniClaw 的 plugin_index.json，用来导入中文触发词")
    p.add_argument("--avatars-dir", help="专家头像目录，里面放 <插件名>.png（UniClaw 宿主头像）")
    p.add_argument("--allow-builtin-overlap", action="store_true", help="兼容旧参数。和内置技能重名时总会装成「套件--技能」，不再跳过")
    p.add_argument("--market-id", default="", help="市场条目 id，记在索引上，用来认出已经装过的市场包")
    p.add_argument(
        "--no-generate-triggers",
        action="store_true",
        help="不调用当前模型为缺少中文触发词的能力生成触发词",
    )

    p = sub.add_parser("seed", help="按内容哈希播种一个目录里的 zip；相同的包不重装，也不会卸载")
    p.add_argument("directory", help="含 zip 的目录，或它的 plugins/、plugins/<市场>/plugins/ 布局")
    _add_profile(p)
    p.add_argument("--avatars-dir", help="专家头像目录；不传则用每个 zip 旁边的 avatars/")
    p.add_argument(
        "--no-generate-triggers",
        action="store_true",
        help="播种时不调用模型生成中文触发词",
    )

    p = sub.add_parser("list", help="列出已装的套件和专家")
    _add_profile(p)

    for verb, text in (("enable", "启用套件（下一场新会话生效）"), ("disable", "停用套件（下一场新会话生效）")):
        p = sub.add_parser(verb, help=text)
        p.add_argument("name", help="插件名")
        _add_profile(p)

    p = sub.add_parser("uninstall", help="卸载套件；专家要加 --delete-profile")
    p.add_argument("name", help="插件名")
    _add_profile(p)
    p.add_argument("--delete-profile", action="store_true", help="卸载专家时删除它的整个 profile（含对话和记忆）")

    p = sub.add_parser("triggers", help="重试套件里待复核 / 待生成的中文触发词")
    p.add_argument("name", help="插件名")
    _add_profile(p)
    p.add_argument("--regenerate", action="store_true", help="丢掉之前模型生成的触发词，全部重新生成并复核")

    p = sub.add_parser("config", help="给套件填写密钥或配置项（写进 .env）")
    p.add_argument("name", help="插件名")
    p.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="可重复")
    _add_profile(p)

    p = sub.add_parser("xiaohongshu", help="下载、启动种草草的本机小红书程序，或只查看状态")
    p.add_argument(
        "action",
        choices=("status", "attach", "install", "start", "stop", "consent", "prepare"),
        help="prepare = 同意 + 下载 + 启动 + 接入（种草草在对话里征得同意后运行）；扫码在对话里完成",
    )
    p.add_argument("--decision", choices=("accept", "decline"), default="accept")
    _add_profile(p)

    p = sub.add_parser("sync", help="让已装专家跟上默认配置档案的模型、密钥和 UniAI 生图搜图工具")
    _add_profile(p)

    p = sub.add_parser("media", help="查看这个 profile 的生图 / 搜图 / 生视频工具；把 UniAI 工具箱写进配置")
    p.add_argument("action", choices=("status", "connect"), help="status 只看；connect 写入 UniAI-Toolkit 这条 MCP")
    p.add_argument("--key-env", default="", help="密钥所在的 .env 变量名（默认 DESKTOP_MT_MAAS_API_KEY）")
    p.add_argument("--name", default="UniAI-Toolkit", help="写进 mcp_servers 的名字")
    _add_profile(p)


def _home(args: argparse.Namespace) -> Path:
    from hermes_constants import get_hermes_home

    if getattr(args, "profile", None):
        from hermes_cli.profiles import get_profile_dir, profile_exists

        if not profile_exists(args.profile):
            raise installer.KitError(f"没有叫 {args.profile} 的 profile")
        return Path(get_profile_dir(args.profile))
    return Path(get_hermes_home())


def _pairs(values: List[str]) -> List[Tuple[str, str]]:
    out = []
    for raw in values:
        if "=" not in raw:
            raise installer.KitError(f"--set 要写成 KEY=VALUE：{raw!r}")
        key, value = raw.split("=", 1)
        out.append((key.strip(), value))
    return out


def _print(text: str) -> None:
    try:
        print(text)
    except UnicodeEncodeError:
        sys.stdout.buffer.write((text + "\n").encode("utf-8", errors="replace"))


def handle(args: argparse.Namespace) -> None:
    from . import package
    from .xiaohongshu import XiaohongshuError

    command = getattr(args, "kit_command", None)
    if not command:
        _print("用法：hermes kit {inspect,install,seed,list,enable,disable,uninstall,triggers,config,xiaohongshu,media} ...（hermes kit -h 看说明）")
        return
    failed = False
    try:
        if command in ("inspect", "install"):
            triggers = installer.load_triggers(Path(args.triggers) if args.triggers else None)
            for raw in args.paths:
                try:
                    if command == "inspect":
                        receipt = installer.inspect(
                            Path(raw), triggers=triggers, allow_overlap=args.allow_builtin_overlap
                        )
                    else:
                        receipt = installer.install(
                            Path(raw),
                            _home(args),
                            triggers=triggers,
                            avatars_dir=Path(args.avatars_dir) if args.avatars_dir else None,
                            allow_overlap=args.allow_builtin_overlap,
                            generate_triggers=not args.no_generate_triggers,
                            market_id=args.market_id or "",
                        )
                except package.PackageError as exc:
                    receipt = installer.Receipt(plugin=Path(raw).name, ok=False, error=str(exc))
                failed = failed or not receipt.ok
                _print(receipt.render())
                _print("")
        elif command == "seed":
            from . import seed as seed_mod

            items = seed_mod.seed(
                _home(args),
                Path(args.directory),
                avatars_dir=Path(args.avatars_dir) if args.avatars_dir else None,
                generate_triggers=not args.no_generate_triggers,
            )
            for item in items:
                _print(item.line())
            failed = any(item.status in ("failed", "unreadable") for item in items)
        elif command == "list":
            home = _home(args)
            rows = installer.list_entries(home)
            if not rows:
                _print(f"{home} 里还没有通过 hermes kit 装过东西。")
            for name, entry in rows:
                kind = entry.get("kind")
                if kind == "expert" and not entry.get("self"):
                    _print(f"专家  {name} {entry.get('version', '')}  「{entry.get('display_name', '')}」 → profile {entry.get('profile')}")
                    continue
                state = "启用" if entry.get("enabled", True) else "停用"
                label = {"kit": "套件", "team": "专家团", "companion": "同伴", "expert": "本专家"}.get(kind, kind)
                _print(
                    f"{label}  {name} {entry.get('version', '')}  「{entry.get('display_name', '')}」  {state}  "
                    f"技能 {len(entry.get('skill_names') or [])}  派工 {len(entry.get('agent_skill_names') or [])}  "
                    f"MCP {len(entry.get('mcp_keys') or [])}"
                )
        elif command in ("enable", "disable"):
            installer.set_enabled(_home(args), args.name, command == "enable")
            _print(f"已{'启用' if command == 'enable' else '停用'} {args.name}。已打开的会话不会变，下一场新会话生效。")
        elif command == "uninstall":
            for line in installer.uninstall(_home(args), args.name, delete_profile=args.delete_profile):
                _print(line)
        elif command == "triggers":
            receipt = installer.refresh_triggers(_home(args), args.name, regenerate=args.regenerate)
            failed = not receipt.ok
            _print(receipt.render())
        elif command == "config":
            if not args.set:
                raise installer.KitError("至少给一个 --set KEY=VALUE")
            written = installer.set_config(_home(args), args.name, _pairs(args.set))
            _print(f"已写入 .env：{', '.join(written)}。下一场新会话生效。")
        elif command == "xiaohongshu":
            from . import xiaohongshu

            home = _home(args)
            if args.action == "status":
                found = xiaohongshu.status(home)
                place = "已放好" if found["present"] else "还没有"
                _print(f"程序{place}：{found['binary']}")
                _print(f"发布包：{found['download_url']}")
                _print(f"接入地址：{found['url']}")
            elif args.action == "install":
                _print(xiaohongshu.install_binary(home))
            elif args.action == "start":
                _print(xiaohongshu.start(home))
            elif args.action == "stop":
                _print(xiaohongshu.stop(home))
            elif args.action == "consent":
                _print(xiaohongshu.set_consent(home, args.decision))
            elif args.action == "prepare":
                _print(xiaohongshu.prepare(home))
            else:
                _print(xiaohongshu.attach(home))
        elif command == "sync":
            from . import expert_sync

            lines = expert_sync.sync_all(_home(args))
            for line in lines or ["专家都已和默认配置档案一致，没有改动。"]:
                _print(line)
            failed = any("同步失败" in line for line in lines)
        elif command == "media":
            from . import media_slot

            home = _home(args)
            if args.action == "connect":
                try:
                    _print(media_slot.connect_uniai(
                        home, key_env=args.key_env or media_slot.DEFAULT_KEY_ENV, name=args.name,
                    ))
                except ValueError as exc:
                    raise installer.KitError(str(exc)) from exc
            for line in media_slot.status_lines(home):
                _print(line)
    except XiaohongshuError as exc:
        _print(str(exc))
        failed = True
    except installer.KitError as exc:
        _print(f"失败：{exc}")
        failed = True
    if failed:
        sys.exit(1)
