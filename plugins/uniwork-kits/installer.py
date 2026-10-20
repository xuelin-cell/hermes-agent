"""Install, toggle and remove WorkBuddy / UniClaw packages in Hermes homes.

A *kit* lands in one profile home (the current one by default): skills under
``skills/kits/<plugin>/skills/`` with ``<plugin>:<skill>`` names, MCP servers
in ``config.yaml`` with secrets referenced from ``.env``. An *expert* becomes
its own profile: the lead persona is its ``SOUL.md``, its skills / subagents /
MCP live only there, and companion skills are copied in from kits installed
in the home the command ran in. Every write is recorded in the home's
``imported-plugins/index.json`` so later operations stay symmetric.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple


from . import expert_cards, host_rules, llm, naming, package, router, store
from . import plugin_spec as spec
from . import triggers as triggers_mod
from . import yaml_compat as yaml

PLUGIN_KEY = "uniwork-kits"
SOUL_SOFT_LIMIT = 20_000  # Hermes' context-file truncation floor
AVATAR_MAX_BYTES = 2 * 1024 * 1024
SVG_AVATAR_MAX_BYTES = 48 * 1024  # rides profiles.list via ui_meta (64KB cap)
_AVATAR_EXTS = {".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp"}
_PLACEHOLDER_RE = re.compile(r"\$\{(?:CLAUDE|CODEBUDDY)_PLUGIN_ROOT\}")
_TEXT_SUFFIXES = (".md", ".txt")
_CJK_RE = re.compile(r"[一-鿿]")
_DOC_SUFFIXES = (".md", ".txt", ".json", ".yaml", ".yml")
_RESERVED_PROFILE_NAMES = frozenset({"default", "hermes", "test", "tmp", "root", "sudo", "custom"})


class KitError(Exception):
    """An operation was refused; the message is meant for the user."""


# ── receipt ─────────────────────────────────────────────────────────────────


_KIND_LABELS = {
    "kit": "套件",
    "expert": "专家",
    "team": "专家团（已降级为套件，不能作为一个专家打开）",
    "broken": "残包",
}


@dataclass
class Receipt:
    plugin: str
    version: str = ""
    display_name: str = ""
    kind: str = ""
    target: str = ""
    dry_run: bool = False
    ok: bool = True
    error: str = ""
    skills: List[str] = field(default_factory=list)
    command_skills: List[str] = field(default_factory=list)
    agent_skills: List[str] = field(default_factory=list)
    companions: List[str] = field(default_factory=list)
    skipped_skills: List[str] = field(default_factory=list)
    mcp_written: List[str] = field(default_factory=list)
    mcp_planned: List[str] = field(default_factory=list)
    mcp_failed: List[str] = field(default_factory=list)
    env_written: List[str] = field(default_factory=list)
    env_missing: List[str] = field(default_factory=list)
    rewrites: List[str] = field(default_factory=list)
    dropped: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    profile: str = ""

    def render(self) -> str:
        """把安装结果整理成给人看的回执文字：判定、装到哪里、装了什么、跳过什么、要用户补什么。"""
        head = "检查结果（只解析，没有写入任何文件）" if self.dry_run else "安装回执"
        lines = [f"{head} · {self.plugin} {self.version}".rstrip()]
        if self.display_name and self.display_name != self.plugin:
            lines.append(f"显示名：{self.display_name}")
        lines.append(f"判定：{_KIND_LABELS.get(self.kind, self.kind or '失败')}")
        if self.target:
            lines.append(f"目标：{self.target}")
        if not self.ok:
            lines.append(f"失败：{self.error}")

        def block(title: str, items: Iterable[str]) -> None:
            """有内容时追加一段带标题和条数的列表。"""
            items = list(items)
            if items:
                lines.append(f"{title}（{len(items)}）：")
                lines.extend(f"  - {i}" for i in items)

        verb = "将装上" if self.dry_run else "装上"
        block(f"{verb}的技能", self.skills)
        block("其中由 commands/ 改写成技能", self.command_skills)
        block("子代理改写成的派工技能", self.agent_skills)
        block("同伴技能", self.companions)
        block("跳过的技能", self.skipped_skills)
        block("计划写入的 MCP" if self.dry_run else "写入 mcp_servers", self.mcp_planned if self.dry_run else self.mcp_written)
        block("没有写入的 MCP", self.mcp_failed)
        block("写入 .env 的默认值", self.env_written)
        block("还缺这些密钥 / 配置（hermes kit config <名> --set KEY=值）", self.env_missing)
        block("改写", self.rewrites)
        block("丢掉的东西", self.dropped)
        block("注意", self.warnings)
        if self.ok and not self.dry_run:
            lines.append("已打开的会话不会变，下一场新会话生效。")
            if self.kind == "expert" and self.profile:
                lines.append(
                    f"请用 profile `{self.profile}` 开新会话（桌面 Bots 列表里点「{self.display_name or self.plugin}」，"
                    f"或命令行 hermes -p {self.profile}），不要在当前对话里切换。"
                )
        lines.extend(self.notes)
        return "\n".join(lines)


# ── small helpers ───────────────────────────────────────────────────────────


def _now() -> str:
    """当前本地时间的字符串，记进索引。"""
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def env_name(plugin: str, key: str) -> str:
    """包里某个用户配置项对应的环境变量名（包名_键名，大写，特殊字符换成下划线）。"""
    return re.sub(r"[^A-Za-z0-9]+", "_", f"{plugin}_{key}").strip("_").upper()


def stored_user_config(plugin: str, fields: List[dict]) -> List[Dict[str, Any]]:
    """存进索引的配置项表单定义（标题、是否敏感、是否必填、默认值），从不存用户填的值。"""
    out: List[Dict[str, Any]] = []
    for field in fields or []:
        if not isinstance(field, dict):
            continue
        key = str(field.get("key") or "").strip()
        if not key:
            continue
        item: Dict[str, Any] = {
            "key": key,
            "env": env_name(plugin, key),
            "title": str(field.get("title") or key),
            "sensitive": bool(field.get("sensitive", False)),
            "required": bool(field.get("required", False)),
            "default": field.get("default"),
        }
        out.append(item)
    return out


def _env_file_value(home: Path, name: str) -> Optional[str]:
    """从 home 的 .env 里读一个变量的值；没有或读不到返回 None。"""
    try:
        for line in (home / ".env").read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            if key.strip() == name:
                return value.strip().strip('"').strip("'")
    except OSError:
        return None
    return None


def _has_real_env(path: Path) -> bool:
    """.env 里有没有真正的变量行（只有注释的空模板不算）。"""
    try:
        return any(
            line.strip() and not line.strip().startswith("#")
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
        )
    except OSError:
        return False


_BUILTIN_NAMES: Optional[Set[str]] = None


def builtin_skill_names() -> Set[str]:
    """Hermes 自带技能（仓库 skills/ 下）的名字，用来避免套件技能和它们重名；结果缓存在进程里。"""
    global _BUILTIN_NAMES
    if _BUILTIN_NAMES is None:
        names: Set[str] = set()
        try:
            import hermes_constants
            from agent.skill_utils import parse_frontmatter

            root = Path(hermes_constants.__file__).resolve().parent / "skills"
            for md in root.rglob("SKILL.md"):
                names.add(md.parent.name)
                try:
                    fm, _ = parse_frontmatter(md.read_text(encoding="utf-8", errors="replace")[:4000])
                    if isinstance(fm, dict) and fm.get("name"):
                        names.add(str(fm["name"]).strip())
                except OSError:
                    pass
        except Exception:
            pass
        _BUILTIN_NAMES = names
    return _BUILTIN_NAMES


BUNDLED_TRIGGERS = Path(__file__).with_name("bundled_triggers.json")


def bundled_triggers() -> Dict[str, Any]:
    """内置套件已经校验过的中文触发词，格式和 plugin_index.json 相同。

    从一个所有词都通过模型复核的账号导出，装内置包时不再调模型。包变了的，还对得上的能力照用，新能力再去生成。文件缺失或读不懂时返回空，不报错。
    """
    try:
        return load_triggers(BUNDLED_TRIGGERS) if BUNDLED_TRIGGERS.is_file() else {}
    except KitError:
        return {}


def load_triggers(path: Optional[Path]) -> Dict[str, Any]:
    """读数字员工（UniClaw）的 plugin_index.json 触发词文件；读不了时报中文错误。"""
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise KitError(f"读不了触发词文件 {path}：{exc}") from exc
    plugins = data.get("plugins") if isinstance(data, dict) else None
    return plugins if isinstance(plugins, dict) else {}


def _phrases(triggers: Dict[str, Any], plugin: str, key: str, description: str) -> List[str]:
    """一个能力现成的触发词：导入的表里有的，加上作者在说明里写的，去重。"""
    entry = triggers.get(plugin) if isinstance(triggers.get(plugin), dict) else {}
    table = entry.get("triggers") if isinstance(entry.get("triggers"), dict) else {}
    out: List[str] = []
    for phrase in list(table.get(key) or []) + router.author_phrases(description):
        if isinstance(phrase, str) and phrase.strip() and phrase.strip() not in out:
            out.append(phrase.strip())
    return out


_TAG_RE = re.compile(r"^(\[[^\]]{1,8}\]\s*)")


def _trigger_note(plugin: str, state: "triggers_mod.TriggerState", total: int) -> str:
    """回执里关于触发词的一行：几个能力已生成并复核、剔除了多少、还有多少没做完。"""
    note = f"中文触发词：{len(state.triggers)}/{total} 个能力的触发词已由模型生成并复核"
    rejected = state.stats.get("rejected", 0)
    if rejected:
        note += f"，复核剔除了 {rejected} 个不准的词"
    if state.open:
        note += (
            f"；还有 {len(state.unverified)} 个待复核、{len(state.pending)} 个待重新生成"
            f"（第 {state.attempts}/{triggers_mod.MAX_ATTEMPTS} 次），可用 hermes kit triggers {plugin} 重试"
        )
    return note


def index_description(original: str, phrases: List[str]) -> str:
    """Hermes 的技能列表只显示说明的前 60 个字；前 60 个字里没有中文时，在前面加上几个中文触发词。

    开头的「[工作流]」「[子代理]」标签保留在最前面，而且不算中文内容，否则每个由命令转来的技能都会被当成已经有中文。
    """
    from agent.skill_utils import SKILL_PROMPT_DESC_LIMIT

    if not phrases:
        return original
    match = _TAG_RE.match(original)
    tag = match.group(1) if match else ""
    rest = original[len(tag):]
    if _CJK_RE.search(rest[: max(0, SKILL_PROMPT_DESC_LIMIT - len(tag))]):
        return original
    return f"{tag}{'、'.join(phrases[:3])}｜{rest}"


def _dump_skill_md(frontmatter: Dict[str, Any], body: str) -> str:
    """把 frontmatter 和正文拼回 SKILL.md 文本，中文不转义、不折行。"""
    head = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False, width=10**6).strip()
    return f"---\n{head}\n---\n\n{body.lstrip()}"


def _substitute_root(directory: Path, root_posix: str) -> int:
    """把文本文件里的包根占位符（${CLAUDE_PLUGIN_ROOT} 等）换成原包副本的真实路径，返回替换次数。"""
    count = 0
    for f in directory.rglob("*"):
        if f.is_file() and f.suffix.lower() in _TEXT_SUFFIXES:
            try:
                text = f.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            new, n = _PLACEHOLDER_RE.subn(root_posix, text)
            if n:
                f.write_text(new, encoding="utf-8")
                count += n
    return count


# Root files that must not be mirrored next to the skills: a root SKILL.md *is*
# the package's only skill (already installed under skills/<plugin>/) and would
# be indexed a second time under its original name; a DESCRIPTION.md would turn
# into a stray category header.
_NOT_A_DOC = frozenset({"skill.md", "description.md"})


def _copy_root_docs(src: Path, dest: Path) -> None:
    """把包根的说明文档复制到技能旁边，供技能引用；根目录的 SKILL.md、DESCRIPTION.md 不复制，免得被重复索引或变成多余的分类标题。"""
    dest.mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        if (
            f.is_file()
            and f.suffix.lower() in _DOC_SUFFIXES
            and f.name.lower() not in _NOT_A_DOC
            and not (dest / f.name).exists()
        ):
            shutil.copy2(f, dest / f.name)


def _write_category_description(path: Path, display: str, description: str, phrases: List[str]) -> None:
    """写套件这一类技能的分类说明（名字、简介、几个触发词），技能列表里按它分组。"""
    text = display
    if description:
        clipped = description if len(description) <= 120 else description[:117] + "..."
        # Many manifests already open with their own title ("金融数据与研究：…").
        text = clipped if clipped.startswith(display) else f"{display}：{clipped}"
    if phrases:
        text += f"（触发词：{'、'.join(phrases[:8])}）"
    path.write_text(f"---\ndescription: {json.dumps(text, ensure_ascii=False)}\n---\n", encoding="utf-8")


def agent_dir_name(agent_name: str) -> str:
    """子代理转成派发技能后的目录名（agent-<名字>）。"""
    return "agent-" + re.sub(r"[^A-Za-z0-9_-]+", "-", agent_name).strip("-")


def agent_skill_names(plan: package.Plan) -> Dict[str, str]:
    """{子代理名: 派发技能的完整名}，同一个包每次算出来都一样。"""
    taken = {item.full_name for item in plan.skills}
    out: Dict[str, str] = {}
    for agent in plan.agents:
        full = naming.skill_name(plan.name, agent_dir_name(agent.name), taken=taken)
        taken.add(full)
        out[agent.name] = full
    return out


def ref_mapping(plan: package.Plan) -> Dict[str, str]:
    """包里文字在「包名:」后面可能写的各种名字，到安装后完整名字的对照表。"""
    skills = [(i.bare_name, i.full_name) for i in plan.skills] + [(i.rel_dir, i.full_name) for i in plan.skills]
    skills += [(i.alias, i.full_name) for i in plan.skills if i.alias]
    return naming.ref_mapping(plan.name, skills, agent_skill_names(plan).items())


def _rewrite_refs_in_dir(directory: Path, plugin: str, mapping: Dict[str, str]) -> int:
    """把目录里文本文件中的「包名:旧名」引用都改成安装后的完整名字，返回改了几处。"""
    total = 0
    for f in directory.rglob("*"):
        if f.is_file() and f.suffix.lower() in _TEXT_SUFFIXES:
            try:
                text = f.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            new, count = naming.rewrite_refs(text, plugin, mapping)
            if count:
                f.write_text(new, encoding="utf-8")
                total += count
    return total


def hermes_command_preamble(body: str, plugin: str, command: str, full_name: str) -> str:
    """替换数字员工写在命令开头的「没有斜杠入口」说明：在 Hermes 里每个技能都是一个命令。"""
    lines = body.lstrip("\n").splitlines(keepends=True)
    if not lines or not lines[0].startswith("> **来源**"):
        return body
    i = 0
    while i < len(lines) and lines[i].startswith(">"):
        i += 1
    preamble = (
        f"> **来源**：本工作流由插件 `{plugin}` 的斜杠命令 `/{command}` 转换而来。"
        f"在 Hermes 里可以输入 `{naming.slash_command(full_name)}` 调起它，也可以直接按下面的步骤执行。\n"
        f"> 正文里的 `/{command}` 等写法是原文保留，不是本应用里的命令；需要参数时以用户本轮的实际要求为准。\n"
    )
    return preamble + "".join(lines[i:])


def _dispatch_skill_md(
    plugin: str, full_name: str, agent: spec.PluginAgentSpec, phrases: Optional[List[str]] = None
) -> str:
    """把一个子代理写成派发技能：说明什么时候用 delegate_task 派给它、怎么写 goal 和 context，并附上原人设和原定义里的限制。

    Hermes 不会替原定义强制执行工具和轮数限制，所以写进说明让模型在 goal 里写明。
    """
    limits = []
    if agent.tools:
        limits.append(f"- 原定义允许的工具：{', '.join(agent.tools)}")
    if agent.model:
        limits.append(f"- 原定义指定的模型：{agent.model}")
    if agent.max_turns:
        limits.append(f"- 原定义的最大轮数：{agent.max_turns}")
    limit_block = "\n".join(limits) if limits else "- 原定义没有额外限制。"
    description = agent.description or f"{plugin} 的子代理 {agent.name}"
    frontmatter = {
        "name": full_name,
        "description": index_description(f"[子代理] {description}", phrases or []),
        "metadata": {"uniwork": {"plugin": plugin, "origin": "agent", "source": agent.source_file}},
    }
    body = (
        f"# 子代理：{agent.name}\n\n"
        f"遇到下面这类任务时，用 `delegate_task` 把它派给一个子代理：\n\n{description}\n\n"
        "怎么派：\n"
        "- `goal`：写清楚这次要完成的具体任务、交付物和保存路径。\n"
        "- `context`：放进下面「人设」整段原文，再补上任务需要的文件路径、材料和约束。\n"
        "- 派工结果是异步回来的；派完可以先做别的，结果回来后再整合。\n\n"
        "原定义里的限制（Hermes 不会替你强制执行，子任务会继承父级的全部工具，请在 goal 里写明）：\n"
        f"{limit_block}\n\n"
        "## 人设\n\n"
        f"{agent.system_prompt.strip()}\n"
    )
    return _dump_skill_md(frontmatter, body)


# ── MCP ─────────────────────────────────────────────────────────────────────


def _resolve_command(command: str, retained: Path) -> Optional[str]:
    """MCP 的启动命令：绝对路径要存在；相对路径在原包副本里找，不能跑到包外；其他按命令名原样交给系统查找。"""
    if not command:
        return None
    if os.path.isabs(command):
        return command if Path(command).exists() else None
    if command.startswith(("./", "../", ".\\", "..\\")) or "/" in command or "\\" in command:
        candidate = (retained / command).resolve()
        if store.is_within(retained, candidate) and candidate.exists():
            return candidate.as_posix()
        return None
    return command if shutil.which(command) else None


def hermes_mcp_config(
    plugin: str, server: Dict[str, Any], retained: Path, data_dir: Path
) -> Tuple[Optional[Dict[str, Any]], str, Dict[str, str]]:
    """把包里一条 MCP 声明转成 Hermes 的 mcp_servers 配置，返回（配置, 不能用的原因, {配置项: 环境变量名}）。

    用户配置的值不写进配置，只留 ${变量名}，Hermes 加载时从 .env 展开。
    """
    refs = {k: env_name(plugin, k) for k in spec.referenced_user_config_keys(server)}
    ctx = {
        "plugin_root": retained.resolve().as_posix(),
        "plugin_data": data_dir.resolve().as_posix(),
        "project_dir": "",
        # Leave a ${VAR} reference: Hermes interpolates it from .env at load time.
        "user_config": lambda key: "${" + env_name(plugin, key) + "}",
        "env": {},
    }
    stype = server.get("type")
    if stype == "ws":
        return None, "WebSocket 传输 Hermes 不支持", refs
    if stype == "stdio":
        command = str(spec.expand_plugin_vars(server.get("command") or "", ctx))
        resolved = _resolve_command(command, retained)
        if not resolved:
            return None, f"找不到要运行的程序 {command}（需要先安装）", refs
        cfg: Dict[str, Any] = {"command": resolved, "args": spec.expand_plugin_vars(list(server.get("args") or []), ctx)}
        env = server.get("env")
        if isinstance(env, str):
            try:
                env = json.loads(env)
            except ValueError:
                env = None
        if isinstance(env, dict) and env:
            cfg["env"] = spec.expand_plugin_vars(env, ctx)
        return cfg, "", refs
    cfg = {"url": spec.expand_plugin_vars(server.get("url") or "", ctx)}
    headers = server.get("headers")
    if isinstance(headers, str):
        try:
            headers = json.loads(headers)
        except ValueError:
            headers = None
    if isinstance(headers, dict) and headers:
        cfg["headers"] = spec.expand_plugin_vars(headers, ctx)
    if stype == "sse":
        cfg["transport"] = "sse"
    if server.get("auth") == "oauth" or server.get("oauth") or server.get("oauth_resource"):
        cfg["auth"] = "oauth"
        if isinstance(server.get("oauth"), dict):
            cfg["oauth"] = dict(server["oauth"])
    return cfg, "", refs


def _plan_env(plan: package.Plan, refs: Dict[str, str], home: Path, receipt: Receipt, *, write: bool) -> List[str]:
    """整理包声明的用户配置：对应到环境变量名，把不敏感的默认值写进 .env，列出还缺的项。"""
    declared = {f["key"]: f for f in plan.manifest.user_config}
    names: Dict[str, str] = dict(refs)
    for key in declared:
        names.setdefault(key, env_name(plan.name, key))
    for key, var in sorted(names.items()):
        fspec = declared.get(key, {})
        if _env_file_value(home, var):
            continue
        default = fspec.get("default")
        if default is not None and not fspec.get("sensitive"):
            if write:
                with store.scoped_home(home):
                    from hermes_cli.config import save_env_value

                    save_env_value(var, str(default))
            receipt.env_written.append(f"{var}={default}")
        elif fspec.get("required") or key in refs:
            title = fspec.get("title") or key
            receipt.env_missing.append(f"{var}（{title}）")
    return sorted(set(names.values()))


# ── install into one home ───────────────────────────────────────────────────


def _remove_package_files(home: Path, plugin: str, entry: Dict[str, Any], *, drop_env: bool) -> None:
    """删掉一个包装过的东西：套件技能目录、技能开关里的名字、它的 MCP；drop_env 时连它的 .env 变量一起删。"""
    store.safe_rmtree(store.kit_root(home, plugin), home)
    names = set(entry.get("skill_names") or []) | set(entry.get("agent_skill_names") or [])
    with store.scoped_home(home):
        from hermes_cli.config import load_config, remove_env_value
        from hermes_cli.mcp_config import _remove_mcp_server
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

        for key in entry.get("mcp_keys") or []:
            _remove_mcp_server(key)
        cfg = load_config()
        disabled = get_disabled_skills(cfg)
        if names & disabled:
            save_disabled_skills(cfg, disabled - names)
        if drop_env:
            for var in entry.get("env_keys") or []:
                remove_env_value(var)


def install_into_home(
    plan: package.Plan,
    home: Path,
    receipt: Receipt,
    *,
    entry_kind: str,
    triggers: Dict[str, Any],
    skill_filter: Optional[Set[str]] = None,
    include_agents: bool = True,
    include_mcp: bool = True,
    allow_overlap: bool = False,
    generate_triggers: bool = True,
    regenerate_triggers: bool = False,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """把包里的技能、子代理、MCP、配置项和触发词装进一个 home，并更新索引。

    已装过同名包时先清掉旧文件再装（类型不同直接拒绝）；原包整份保留一份副本，技能里的占位符和互相引用都改成安装后的路径和名字。触发词按导入表、作者写的、模型生成并复核的顺序取。
    """
    index = store.load_index(home)
    previous = index["plugins"].get(plan.name)
    enabled = bool(previous.get("enabled", True)) if isinstance(previous, dict) else True
    if isinstance(previous, dict) and previous.get("kind") not in (entry_kind, None):
        raise KitError(f"{home} 里已经以「{previous.get('kind')}」装过 {plan.name}，先卸载再装。")
    if isinstance(previous, dict):
        _remove_package_files(home, plan.name, previous, drop_env=False)
        receipt.notes.append(f"覆盖了之前的版本 {previous.get('version', '')}".rstrip())
    store.safe_rmtree(store.imported_root(home) / plan.name, home)

    retained = store.retained_dir(home, plan.name, plan.version)
    retained.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(plan.pristine_root, retained)
    root_posix = retained.resolve().as_posix()
    kroot = store.kit_root(home, plan.name)
    skills_dir = kroot / "skills"
    builtin = builtin_skill_names() if (entry_kind == "kit" and not allow_overlap) else set()

    kept: List[package.SkillItem] = []
    for item in plan.skills:
        if skill_filter is not None and item.full_name not in skill_filter:
            continue
        if item.bare_name in builtin:
            receipt.notes.append(
                f"{item.full_name}（Hermes 已有内置技能 {item.bare_name}，套件这份使用 {item.full_name}，不覆盖原来的技能）"
            )
        kept.append(item)
    agent_full = agent_skill_names(plan)
    agents = list(plan.agents) if include_agents else []
    mapping = ref_mapping(plan)

    # Trigger phrases: imported cache, author-written, then generated for the rest.
    trig: Dict[str, List[str]] = {}
    components: List[triggers_mod.Component] = []
    for item in kept:
        components.append(triggers_mod.Component(item.full_name, "skill", item.full_name, item.description))
        phrases = _phrases(triggers, plan.name, item.trigger_key, item.description)
        if phrases:
            trig[item.full_name] = phrases
    for agent in agents:
        full = agent_full[agent.name]
        components.append(triggers_mod.Component(full, "agent", full, agent.description))
        phrases = _phrases(triggers, plan.name, f"agent:{agent.name}", agent.description)
        if phrases:
            trig[full] = phrases
    if include_mcp:
        for server in plan.mcp_servers:
            key = spec.mcp_server_key(plan.name, server["name"])
            components.append(triggers_mod.Component(key, "mcp", server["name"], str(server.get("url") or server.get("command") or "")))
            phrases = _phrases(triggers, plan.name, f"mcp:{server['name']}", "")
            if phrases:
                trig[key] = phrases
    # Imported (already verified by UniClaw) and author-written phrases are trusted
    # as-is; the model makes the rest, and those are used only once verified.
    same_package = isinstance(previous, dict) and previous.get("digest") == plan.digest
    previous_state = previous.get("trigger_state") if same_package and isinstance(previous.get("trigger_state"), dict) else None
    for key, phrases in ((previous_state or {}).get("trusted") or {}).items():
        trig.setdefault(key, phrases)
    trusted = dict(trig)
    state: Optional[triggers_mod.TriggerState] = None
    if entry_kind in ("kit", "team"):
        candidates = [c for c in components if c.key not in trusted]
        prior = None if (regenerate_triggers or previous_state is None) else triggers_mod.TriggerState.from_dict(previous_state)
        if candidates and generate_triggers and llm.available():
            state, called = triggers_mod.refresh(plan.name, plan.manifest.description, candidates, llm.complete, previous=prior)
            if called:
                receipt.notes.append(_trigger_note(plan.name, state, len(candidates)))
        elif prior is not None:
            state = prior
        elif candidates and generate_triggers:
            receipt.warnings.append(f"{len(candidates)} 个能力没有中文触发词，也没有可用模型来生成；路由推荐只能按名字命中")
        if state is not None:
            for key, phrases in state.triggers.items():
                trig.setdefault(key, phrases)

    skill_names: List[str] = []
    command_names: List[str] = []
    all_phrases: List[str] = []
    ref_count = 0
    for item in kept:
        dest = skills_dir / item.rel_dir
        ignore = package.root_skill_ignore(plan.root) if item.source_dir == plan.root else None
        shutil.copytree(item.source_dir, dest, ignore=ignore)
        phrases = trig.get(item.full_name) or []
        frontmatter = dict(item.frontmatter)
        frontmatter["name"] = item.full_name
        new_description = index_description(item.description, phrases)
        meta = frontmatter.get("metadata") if isinstance(frontmatter.get("metadata"), dict) else {}
        uni: Dict[str, Any] = {"plugin": plan.name, "version": plan.version, "origin": item.origin}
        if new_description != item.description:
            uni["source_description"] = item.description
        frontmatter["description"] = new_description
        frontmatter["metadata"] = {**meta, "uniwork": uni}
        body = item.body
        if item.origin == "command":
            body = hermes_command_preamble(body, plan.name, item.rel_dir, item.full_name)
        md = package._find_skill_md(dest)
        if md is not None and md.name != "SKILL.md":
            md.unlink()
        (dest / "SKILL.md").write_text(_dump_skill_md(frontmatter, body), encoding="utf-8")
        _substitute_root(dest, root_posix)
        ref_count += _rewrite_refs_in_dir(dest, plan.name, mapping)
        skill_names.append(item.full_name)
        if item.origin == "command":
            command_names.append(item.full_name)
        all_phrases.extend(p for p in phrases if p not in all_phrases)

    agent_names: List[str] = []
    for agent in agents:
        full = agent_full[agent.name]
        dest = skills_dir / agent_dir_name(agent.name)
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "SKILL.md").write_text(
            _dispatch_skill_md(plan.name, full, agent, trig.get(full)), encoding="utf-8"
        )
        _substitute_root(dest, root_posix)
        ref_count += _rewrite_refs_in_dir(dest, plan.name, mapping)
        agent_names.append(full)
    if agents:
        receipt.rewrites.append("子代理改成了派工技能；原定义的 tools / model / maxTurns 只写成文字，Hermes 不强制")
    if ref_count:
        receipt.rewrites.append(f"包内 {ref_count} 处「{plan.name}:技能名」引用改成了 Hermes 里的技能名（{naming.SEP} 分隔）")

    if skill_names or agent_names:
        _copy_root_docs(retained, kroot)
        _write_category_description(
            skills_dir / "DESCRIPTION.md", plan.display_name(), plan.manifest.description, all_phrases
        )

    mcp_keys: List[str] = []
    env_refs: Dict[str, str] = {}
    if include_mcp and plan.mcp_servers:
        data_dir = store.imported_root(home) / plan.name / "data"
        with store.scoped_home(home):
            from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server

            existing = _get_mcp_servers()
            for server in plan.mcp_servers:
                key = spec.mcp_server_key(plan.name, server["name"])
                cfg, reason, refs = hermes_mcp_config(plan.name, server, retained, data_dir)
                if cfg is None:
                    receipt.mcp_failed.append(f"{server['name']}：{reason}")
                    continue
                if key in existing:
                    receipt.mcp_failed.append(f"{server['name']}：配置里已有同名的 {key}，没有覆盖")
                    continue
                if not enabled:
                    cfg["enabled"] = False
                if not _save_mcp_server(key, cfg):
                    receipt.mcp_failed.append(f"{server['name']}：命令或参数看起来可疑，Hermes 拒绝写入")
                    continue
                mcp_keys.append(key)
                env_refs.update(refs)
                if cfg.get("auth") == "oauth":
                    receipt.warnings.append(
                        f"MCP {key} 需要登录授权（OAuth），还没有连上；首次使用时按 Hermes 的提示授权"
                    )
        for skipped in plan.mcp_skipped:
            receipt.mcp_failed.append(f"{skipped.get('name')}：{skipped.get('reason')}")
    env_keys = _plan_env(plan, env_refs, home, receipt, write=True) if include_mcp else []

    entry: Dict[str, Any] = {
        "kind": entry_kind,
        "display_name": plan.display_name(),
        "description": host_rules.localized(plan.manifest.description),
        "version": plan.version,
        "digest": plan.digest,
        "enabled": enabled,
        "installed_at": _now(),
        "source_dir": retained.relative_to(home).as_posix(),
        "skill_names": skill_names,
        "command_skill_names": command_names,
        "agent_skill_names": agent_names,
        "mcp_keys": mcp_keys,
        "env_keys": env_keys,
        "user_config": stored_user_config(plan.name, plan.manifest.user_config),
        "triggers": trig,
        "trigger_state": {**(state.to_dict() if state is not None else {}), "trusted": trusted},
        "allow_overlap": allow_overlap,
        "dropped": list(plan.dropped),
        "hooks": dict(plan.hooks),
    }
    if extra:
        entry.update(extra)
    index["plugins"][plan.name] = entry
    store.save_index(home, index)
    if not enabled:
        set_enabled(home, plan.name, False)

    receipt.skills.extend(s for s in skill_names if s not in receipt.skills)
    receipt.command_skills.extend(command_names)
    receipt.agent_skills.extend(agent_names)
    receipt.mcp_written.extend(mcp_keys)
    return entry


# ── experts ─────────────────────────────────────────────────────────────────


def profile_name_for(plugin: str) -> str:
    """专家对应的档案名：只留小写字母数字和 - _，最长 64，开头不是字母数字或撞上保留名时加前后缀。"""
    name = re.sub(r"[^a-z0-9_-]+", "-", plugin.lower()).strip("-_")[:64]
    if not name or not name[0].isalnum():
        name = f"expert-{name}".strip("-")[:64]
    if name in _RESERVED_PROFILE_NAMES:
        name = f"{name}-expert"
    return name


def _mirror_credentials(src_home: Path, dst_home: Path) -> bool:
    """和桌面新建档案同一条规则：新档案的 .env 只是注释模板时，复制默认档案的 .env 过去，并收紧权限。"""
    src, dst = src_home / ".env", dst_home / ".env"
    if src.is_file() and _has_real_env(src) and not _has_real_env(dst):
        shutil.copy2(src, dst)
        try:
            os.chmod(dst, 0o600)
        except OSError:
            pass
        return True
    return False


def _avatar_source(plan: package.Plan, avatars_dir: Optional[Path]) -> Tuple[Optional[Path], str]:
    """专家头像从哪来：先找宿主头像目录里画好的图（数字员工的头像），再用包自己的。"""
    if avatars_dir:
        for suffix in (*_AVATAR_EXTS, ".svg"):
            candidate = Path(avatars_dir) / f"{plan.name}{suffix}"
            if candidate.is_file():
                return candidate, ""
    declared = plan.manifest.persona.get("avatar")
    if isinstance(declared, str) and declared.strip():
        candidate = (plan.pristine_root / declared.strip().lstrip("/\\")).resolve()
        if candidate.is_file() and store.is_within(plan.pristine_root, candidate):
            suffix = candidate.suffix.lower()
            if suffix in _AVATAR_EXTS or suffix == ".svg":
                return candidate, ""
            return None, f"包里的头像是 {candidate.suffix} 格式，支持 png / jpg / webp / svg，没有设置头像"
    return None, ""


def _apply_bot_identity(home: Path, title: str, avatar: Optional[Path]) -> None:
    """把专家的名字和头像写进档案的 profile.yaml，机器人名单就按它显示。"""
    from utils import atomic_yaml_write

    meta_path = home / "profile.yaml"
    try:
        existing = yaml.safe_load(meta_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        existing = {}
    if not isinstance(existing, dict):
        existing = {}
    ui = existing.get("ui_meta") if isinstance(existing.get("ui_meta"), dict) else {}
    bots = dict(ui.get("hermes-bots") or {})
    bots["title"] = title
    if avatar is not None:
        bots["imageKind"] = "photo"
        bots["custom"] = True
        assets = home / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        for ext in set(_AVATAR_EXTS.values()):
            stale = assets / f"avatar.{ext}"
            if stale.exists():
                stale.unlink()
        if avatar.suffix.lower() == ".svg":
            # The profile asset store takes rasters only; Bot Mode renders the
            # server-side ui_meta ``image`` directly when it has no local copy
            # (``mergeServerMeta``), so a small SVG rides there as a data URL.
            bots["image"] = "data:image/svg+xml;base64," + base64.b64encode(avatar.read_bytes()).decode("ascii")
        else:
            bots.pop("image", None)
            shutil.copy2(avatar, assets / f"avatar.{_AVATAR_EXTS[avatar.suffix.lower()]}")
    ui["hermes-bots"] = bots
    existing["ui_meta"] = ui
    revisions = existing.get("_ui_meta_revisions") if isinstance(existing.get("_ui_meta_revisions"), dict) else {}
    revisions["hermes-bots"] = int(revisions.get("hermes-bots") or 0) + 1
    existing["_ui_meta_revisions"] = revisions
    atomic_yaml_write(meta_path, existing, sort_keys=False)


def _enable_self_in(home: Path) -> None:
    """在专家自己的档案里也启用本插件，专家对话才有宿主规则和钩子。"""
    with store.scoped_home(home):
        from hermes_cli.config import load_config, save_config

        cfg = load_config()
        plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
        enabled = list(plugins.get("enabled") or [])
        if PLUGIN_KEY not in enabled:
            enabled.append(PLUGIN_KEY)
        plugins["enabled"] = enabled
        cfg["plugins"] = plugins
        save_config(cfg)


def _sha(text: str) -> str:
    """文本的 SHA-256，用来判断 SOUL.md 有没有被用户改过。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# Bot Mode appends this section to a bot's SOUL (apps/desktop hermes-bots soul.ts).
_BOT_PROTOCOL_HEADING = "## Messaging other agents"


def _split_soul(text: str) -> Tuple[str, str]:
    """把已装的 SOUL.md 拆成（人设, 桌面后来追加的机器人模式协议），重装时保留协议部分。"""
    marker = f"\n{_BOT_PROTOCOL_HEADING}"
    idx = text.find(marker)
    if idx < 0:
        return text.strip(), ""
    return text[:idx].strip(), text[idx + 1 :].strip() + "\n"


def install_expert(
    plan: package.Plan,
    home: Path,
    receipt: Receipt,
    *,
    triggers: Dict[str, Any],
    avatars_dir: Optional[Path],
    market_id: str = "",
) -> None:
    """把专家装成一个独立档案：建档案、写人设（SOUL.md）、名字和头像，把技能和 MCP 装进去，再在默认档案的索引里记一笔。

    用户手改过的 SOUL.md 和桌面追加的机器人协议都保留；新档案的模型和密钥跟默认档案一致。
    """
    from hermes_cli.profiles import (
        create_profile,
        get_profile_dir,
        profile_exists,
        validate_profile_name,
    )
    from tools.threat_patterns import scan_for_threats

    profile = profile_name_for(plan.name)
    validate_profile_name(profile)
    phome = Path(get_profile_dir(profile))
    receipt.profile = profile
    receipt.target = f"专家 profile `{profile}`（{phome}）"

    found = store.self_expert(store.load_index(phome)) if phome.exists() else None
    if profile_exists(profile):
        if not found or found[0] != plan.name:
            raise KitError(f"已经有一个叫 {profile} 的 profile，不是这个专家装的，没有覆盖。")
    else:
        description = host_rules.localized(plan.manifest.persona.get("profession")) or plan.manifest.description
        create_profile(profile, no_skills=True, description=(description or None))
        if _mirror_credentials(home, phome):
            receipt.notes.append("已把当前 profile 的 .env（模型等密钥）复制给专家，专家可以直接对话。")

    persona, changes, unmapped = host_rules.rewrite_persona(plan.lead.system_prompt.strip())
    persona, ref_count = naming.rewrite_refs(persona, plan.name, ref_mapping(plan))
    persona = persona.strip() + "\n"
    receipt.rewrites.extend(f"人设：{c}" for c in changes)
    if ref_count:
        receipt.rewrites.append(f"人设：{ref_count} 处「{plan.name}:技能名」改成了 Hermes 里的技能名")
    if unmapped:
        receipt.warnings.append(
            f"人设里提到 {', '.join(unmapped)}，Hermes 没有对应工具；已在专家守则里告诉模型怎么处理，原文保留"
        )
    soul_path = phome / "SOUL.md"
    soul_hash = _sha(persona.strip())
    previous_hash = found[1].get("soul_sha256") if found else None
    current = soul_path.read_text(encoding="utf-8") if soul_path.is_file() else ""
    core, protocol = _split_soul(current)
    if found and previous_hash and core and previous_hash not in (_sha(core), _sha(core + "\n")):
        receipt.warnings.append("SOUL.md 在上次安装后被改过，这次没有覆盖；要换成新人设请先手动处理")
        soul_hash = previous_hash
    else:
        # Keep the Bot Mode messaging protocol the desktop appends after install.
        soul_path.write_text(persona + (f"\n{protocol}" if protocol else ""), encoding="utf-8")
    threats = scan_for_threats(persona, scope="context")
    if threats:
        receipt.warnings.append(f"人设命中 Hermes 的注入扫描（{', '.join(threats)}），会话里 SOUL 会被整份拦下")
    if len(persona) > SOUL_SOFT_LIMIT:
        receipt.warnings.append(f"人设有 {len(persona)} 字，超过 2 万字下限，小上下文模型上会被截断")

    install_into_home(
        plan,
        phome,
        receipt,
        entry_kind="expert",
        triggers=triggers,
        extra={
            "self": True,
            "profile": profile,
            "agent_name": plan.manifest.agent_name,
            "profession": expert_cards.card_name(plan.name, plan.manifest.persona)[1],
            "intro": expert_cards.intro(plan.name, plan.manifest.persona),
            "soul_sha256": soul_hash,
            **({"market_id": market_id} if market_id else {}),
        },
    )

    for companion in host_rules.COMPANION_SKILLS.get(plan.name, ()):
        cplugin = companion.split(naming.SEP, 1)[0]
        centry = store.load_index(home)["plugins"].get(cplugin)
        if not isinstance(centry, dict) or centry.get("kind") != "kit":
            receipt.warnings.append(f"同伴技能 {companion} 所属的套件 {cplugin} 没有装在当前 profile，跳过")
            continue
        sub = Receipt(plugin=cplugin)
        with package.open_package(home / centry["source_dir"]) as (pristine, work, digest):
            cplan = package.build_plan(pristine, work, digest)
            install_into_home(
                cplan, phome, sub, entry_kind="companion", triggers=triggers,
                skill_filter={companion}, include_agents=False, include_mcp=False,
            )
        if companion in sub.skills:
            receipt.companions.append(companion)
        else:
            receipt.warnings.append(f"同伴技能 {companion} 在套件 {cplugin} 里没找到")

    avatar, avatar_note = _avatar_source(plan, avatars_dir)
    if avatar_note:
        receipt.warnings.append(avatar_note)
    if avatar is not None and avatar.stat().st_size > AVATAR_MAX_BYTES:
        receipt.warnings.append("头像超过 2MB，没有设置")
        avatar = None
    if avatar is not None and avatar.suffix.lower() == ".svg" and avatar.stat().st_size > SVG_AVATAR_MAX_BYTES:
        receipt.warnings.append("SVG 头像超过 48KB（它要随 Bots 列表一起传输），没有设置；请换成 png")
        avatar = None
    _apply_bot_identity(phome, plan.display_name(), avatar)
    if avatar is not None:
        receipt.notes.append(f"头像：{avatar.name}")
    _enable_self_in(phome)

    index = store.load_index(home)
    stub: Dict[str, Any] = {
        "kind": "expert",
        "display_name": plan.display_name(),
        "version": plan.version,
        "digest": plan.digest,
        "profile": profile,
        "profession": expert_cards.card_name(plan.name, plan.manifest.persona)[1],
        "intro": expert_cards.intro(plan.name, plan.manifest.persona),
        "installed_at": _now(),
        "user_config": stored_user_config(plan.name, plan.manifest.user_config),
    }
    if market_id:
        stub["market_id"] = market_id
    index["plugins"][plan.name] = stub
    store.save_index(home, index)

    from . import expert_sync

    try:
        for change in expert_sync.sync_expert(home, phome):
            receipt.notes.append(f"跟随默认配置档案：{change}")
    except Exception as exc:  # the expert is installed either way; `hermes kit sync` retries
        receipt.warnings.append(f"同步默认配置档案的模型 / 密钥 / 生图工具失败：{exc}")


# ── public operations ───────────────────────────────────────────────────────


def inspect(path: Path, *, triggers: Dict[str, Any], allow_overlap: bool = False) -> Receipt:
    """只解析包、列出会装什么，不写任何文件（hermes kit inspect）。"""
    with package.open_package(path) as (pristine, work, digest):
        plan = package.build_plan(pristine, work, digest)
        receipt = Receipt(plugin=plan.name, version=plan.version, display_name=plan.display_name(),
                          kind=plan.kind, dry_run=True)
        if plan.kind == "broken":
            receipt.ok, receipt.error = False, plan.problem or "残包"
            return receipt
        builtin = builtin_skill_names() if (plan.kind != "expert" and not allow_overlap) else set()
        for item in plan.skills:
            if item.bare_name in builtin:
                receipt.notes.append(
                    f"{item.full_name}（Hermes 已有内置技能 {item.bare_name}，套件这份使用 {item.full_name}，不覆盖原来的技能）"
                )
            receipt.skills.append(item.full_name)
            if item.origin == "command":
                receipt.command_skills.append(item.full_name)
        receipt.agent_skills = list(agent_skill_names(plan).values())
        if receipt.skills:
            receipt.notes.append(f"斜杠命令形如 {naming.slash_command(receipt.skills[0])}")
        retained = Path("<原包目录>")
        for server in plan.mcp_servers:
            cfg, reason, refs = hermes_mcp_config(plan.name, server, plan.pristine_root, retained)
            key = spec.mcp_server_key(plan.name, server["name"])
            if cfg is None:
                receipt.mcp_failed.append(f"{server['name']}：{reason}")
            else:
                receipt.mcp_planned.append(key)
                if cfg.get("auth") == "oauth":
                    receipt.warnings.append(f"MCP {key} 需要登录授权（OAuth），装上后首次使用时授权")
        for skipped in plan.mcp_skipped:
            receipt.mcp_failed.append(f"{skipped.get('name')}：{skipped.get('reason')}")
        if plan.kind == "expert":
            receipt.profile = profile_name_for(plan.name)
            receipt.target = f"会新建专家 profile `{receipt.profile}`"
            persona, changes, unmapped = host_rules.rewrite_persona(plan.lead.system_prompt.strip())
            receipt.rewrites.extend(f"人设：{c}" for c in changes)
            receipt.companions = list(host_rules.COMPANION_SKILLS.get(plan.name, ()))
            from tools.threat_patterns import scan_for_threats

            threats = scan_for_threats(persona, scope="context")
            if threats:
                receipt.warnings.append(f"人设命中 Hermes 的注入扫描：{', '.join(threats)}")
            receipt.notes.append(f"人设长度：{len(persona)} 字")
        if plan.agents:
            receipt.rewrites.append("子代理会改成派工技能（tools / model / maxTurns 只写成文字）")
        receipt.dropped = list(plan.dropped)
        receipt.warnings.extend(plan.warnings)
        return receipt


def install(
    path: Path,
    home: Path,
    *,
    triggers: Dict[str, Any],
    avatars_dir: Optional[Path] = None,
    allow_overlap: bool = False,
    generate_triggers: bool = True,
    market_id: str = "",
) -> Receipt:
    """安装一个包（套件装进 home，专家装成独立档案），返回回执；任何失败都写进回执，不往外抛。

    这次安装新建的专家档案在失败时会删掉，重试时不会被当成别人的档案拒绝。
    """
    with package.open_package(path) as (pristine, work, digest):
        plan = package.build_plan(pristine, work, digest)
        receipt = Receipt(plugin=plan.name, version=plan.version, display_name=plan.display_name(), kind=plan.kind)
        receipt.warnings.extend(plan.warnings)
        receipt.dropped = list(plan.dropped)
        if plan.kind == "broken":
            receipt.ok, receipt.error = False, plan.problem or "残包"
            receipt.notes.append("残包：没有安装任何技能、MCP，也没有建 profile。")
            return receipt
        fresh_profile = _profile_to_create(plan)
        try:
            if plan.kind == "expert":
                install_expert(
                    plan, home, receipt, triggers=triggers, avatars_dir=avatars_dir, market_id=market_id
                )
                _write_receipt(Path(receipt_home(receipt)), plan.name, receipt)
            else:
                receipt.target = f"{home}"
                install_into_home(
                    plan, home, receipt, entry_kind=plan.kind, triggers=triggers,
                    allow_overlap=allow_overlap, generate_triggers=generate_triggers,
                    extra={"market_id": market_id} if market_id else None,
                )
                if receipt.skills:
                    receipt.notes.append(f"斜杠命令形如 {naming.slash_command(receipt.skills[0])}")
                if plan.kind == "team":
                    receipt.notes.append("专家团不能作为一个专家打开；成员已降级为派工技能，装在当前 profile。")
        except (KitError, OSError) as exc:
            receipt.ok, receipt.error = False, _failure_text(exc, home)
            if fresh_profile:
                _discard_new_profile(fresh_profile, receipt)
            return receipt
        _write_receipt(home, plan.name, receipt)
        return receipt


def _profile_to_create(plan: package.Plan) -> str:
    """这次安装将要新建的专家档案名；档案已经存在或不是专家时返回空字符串。"""
    if plan.kind != "expert":
        return ""
    from hermes_cli.profiles import profile_exists

    profile = profile_name_for(plan.name)
    return "" if profile_exists(profile) else profile


_WINDOWS_MAX_PATH = 260


def _failure_text(exc: Exception, home: Path) -> str:
    """回执里的错误一行；路径超过 Windows 260 字符上限时说明原因和怎么办。"""
    if isinstance(exc, KitError):
        return str(exc)
    if os.name != "nt" or max(map(len, _error_paths(exc)), default=0) < _WINDOWS_MAX_PATH:
        return f"安装失败：{exc}"
    return (
        f"有文件路径超过了 Windows 的 {_WINDOWS_MAX_PATH} 字符上限，没有装上"
        f"（数据目录 {home} 本身就有 {len(str(home))} 个字符）。"
        "请开启 Windows 长路径支持（注册表 LongPathsEnabled=1，需要管理员权限），或把数据目录放到更短的路径后重装。"
    )


def _error_paths(exc: BaseException) -> List[str]:
    """从 OSError（或 shutil.Error 的逐个文件列表）里取出出错的路径。"""
    found = [getattr(exc, "filename", None), getattr(exc, "filename2", None)]
    if isinstance(exc, shutil.Error) and exc.args and isinstance(exc.args[0], list):
        for item in exc.args[0]:
            if isinstance(item, tuple):
                found.extend(item[:2])
    return [str(p) for p in found if p]


_EXTENDED_PREFIX = "\\\\?\\"


def _extended(path: Path) -> str:
    """Windows 上把路径换成扩展长路径写法（带固定前缀），不受 260 字符上限限制。"""
    text = str(path.resolve())
    return text if os.name != "nt" or text.startswith(_EXTENDED_PREFIX) else _EXTENDED_PREFIX + text


def _discard_new_profile(profile: str, receipt: Receipt) -> None:
    """撤销这次安装失败前新建的档案，免得重试时被当成别人的档案拒绝。"""
    import contextlib
    import io

    from hermes_cli.profiles import delete_profile, get_profile_dir, profile_exists

    if not profile_exists(profile):
        return
    phome = Path(get_profile_dir(profile))
    # Package copies can lie past the path limit that stopped the install; clear them
    # in extended-length form so the core delete does not trip over the same files.
    for sub in (store.imported_root(phome), phome / "skills"):
        if sub.is_dir() and not sub.is_symlink():
            shutil.rmtree(_extended(sub), ignore_errors=True)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            delete_profile(profile, yes=True)
    except Exception as exc:  # noqa: BLE001 - report, the install already failed
        receipt.warnings.append(f"安装失败后没能删掉这次新建的 profile {profile}：{exc}；重装前请先删除它")
    else:
        receipt.notes.append(f"已撤回这次新建的 profile {profile}，修好问题后可以直接重装")


def receipt_home(receipt: Receipt) -> str:
    """专家回执写在专家自己的档案里，这里给出那个档案的目录。"""
    from hermes_cli.profiles import get_profile_dir

    return str(get_profile_dir(receipt.profile))


def _write_receipt(home: Path, plugin: str, receipt: Receipt) -> None:
    """把回执写成文本文件，套件页的「查看记录」读它。"""
    path = store.receipt_path(home, plugin)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(receipt.render() + "\n", encoding="utf-8")


def set_enabled(home: Path, plugin: str, enabled: bool) -> Dict[str, Any]:
    """启用或停用一个套件（技能开关、MCP 开关一起改）；专家是独立档案，没有开关。"""
    index = store.load_index(home)
    entry = index["plugins"].get(plugin)
    if not isinstance(entry, dict):
        raise KitError(f"{home} 里没有装 {plugin}")
    if entry.get("kind") == "expert":
        raise KitError("专家是一个独立 profile，没有开关；不想要可以卸载（hermes kit uninstall <名> --delete-profile）")
    names = set(entry.get("skill_names") or []) | set(entry.get("agent_skill_names") or [])
    with store.scoped_home(home):
        from hermes_cli.config import load_config
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

        cfg = load_config()
        servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
        for key in entry.get("mcp_keys") or []:
            if isinstance(servers.get(key), dict):
                servers[key]["enabled"] = enabled
        cfg["mcp_servers"] = servers
        disabled = get_disabled_skills(cfg)
        save_disabled_skills(cfg, (disabled - names) if enabled else (disabled | names))
    entry["enabled"] = enabled
    index["plugins"][plugin] = entry
    store.save_index(home, index)
    return entry


def uninstall(home: Path, plugin: str, *, delete_profile: bool = False) -> List[str]:
    """卸载一个包：套件删掉技能、MCP、它的 .env 变量和原包副本；专家要明确 delete_profile 才删整个档案（含对话和记忆）。"""
    index = store.load_index(home)
    entry = index["plugins"].get(plugin)
    if not isinstance(entry, dict):
        raise KitError(f"{home} 里没有装 {plugin}")
    notes: List[str] = []
    if entry.get("kind") == "expert" and not entry.get("self"):
        profile = entry.get("profile") or ""
        if not delete_profile:
            raise KitError(
                f"{plugin} 是专家（profile `{profile}`）。卸载会删除整个 profile，包括它的对话记录和记忆；"
                "确认请加 --delete-profile。"
            )
        from hermes_cli.profiles import delete_profile as _delete_profile, profile_exists

        if profile and profile_exists(profile):
            _delete_profile(profile, yes=True)
            notes.append(f"已删除 profile `{profile}`")
    else:
        _remove_package_files(home, plugin, entry, drop_env=True)
        store.safe_rmtree(store.imported_root(home) / plugin, home)
        receipt = store.receipt_path(home, plugin)
        if receipt.exists():
            receipt.unlink()
        notes.append("已删除技能目录、MCP 配置、它的 .env 变量和原包副本")
    index["plugins"].pop(plugin, None)
    store.save_index(home, index)
    notes.append("已打开的会话不会变，下一场新会话生效；MCP 要等新会话或重启后端才彻底消失。")
    return notes


def set_config(home: Path, plugin: str, pairs: List[Tuple[str, str]]) -> List[str]:
    """把用户填的配置值写进 .env；专家的写进它自己的档案。"""
    index = store.load_index(home)
    entry = index["plugins"].get(plugin)
    if not isinstance(entry, dict):
        raise KitError(f"{home} 里没有装 {plugin}")
    target = home
    if entry.get("kind") == "expert" and not entry.get("self"):
        from hermes_cli.profiles import get_profile_dir

        target = Path(get_profile_dir(entry.get("profile") or ""))
        entry = store.load_index(target)["plugins"].get(plugin) or entry
    known = set(entry.get("env_keys") or [])
    written: List[str] = []
    with store.scoped_home(target):
        from hermes_cli.config import save_env_value

        for key, value in pairs:
            var = key if key in known else env_name(plugin, key)
            save_env_value(var, value)
            written.append(var)
    return written


def refresh_triggers(home: Path, plugin: str, *, regenerate: bool = False) -> Receipt:
    """给已装套件补做没生成或没复核完的触发词，regenerate 时全部重来；只有套件有触发词。"""
    entry = store.load_index(home)["plugins"].get(plugin)
    if not isinstance(entry, dict):
        raise KitError(f"{home} 里没有装 {plugin}")
    if entry.get("kind") not in ("kit", "team"):
        raise KitError("只有套件有触发词；专家 profile 里不做路由推荐")
    if not llm.available():
        raise KitError("没有可用的模型，无法生成或复核触发词")
    with package.open_package(home / entry["source_dir"]) as (pristine, work, digest):
        plan = package.build_plan(pristine, work, digest)
        plan.digest = str(entry.get("digest") or digest)  # the retained copy *is* the installed package
        receipt = Receipt(plugin=plan.name, version=plan.version, display_name=plan.display_name(),
                          kind=plan.kind, target=str(home))
        install_into_home(
            plan, home, receipt, entry_kind=entry["kind"], triggers={},
            allow_overlap=bool(entry.get("allow_overlap")), regenerate_triggers=regenerate,
        )
    if not any(n.startswith("中文触发词") for n in receipt.notes):
        receipt.notes.append("触发词都已复核完，或已经重试满 3 次，没有调用模型；要重新生成请加 --regenerate")
    _write_receipt(home, plugin, receipt)
    return receipt


def list_entries(home: Path) -> List[Tuple[str, Dict[str, Any]]]:
    """按名字排序的全部已装条目。"""
    return sorted((store.load_index(home).get("plugins") or {}).items())
