"""Open a WorkBuddy / UniClaw package and describe what installing it means.

Nothing here writes into a Hermes home. :func:`open_package` unpacks into a
temporary directory (a pristine copy that will be retained as-is, plus a
working copy the command→skill conversion may modify) and :func:`build_plan`
classifies the package and lists its parts. ``hermes kit inspect`` prints the
plan; ``hermes kit install`` executes it.

Classification follows UniClaw (``plugin_experts.lead_problem``): only the
manifest decides — ``expertType: agent`` with a readable, non-empty
``agents/<agentName>.md`` is an expert, ``expertType: team`` is an expert team
(degraded to a kit), anything else is a kit. Market directory never matters.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from . import naming
from . import plugin_spec as spec

# Same bounded manifest search as UniClaw routes/plugins.py.
_MANIFEST_SCAN_EXCLUDE = frozenset(
    {
        "node_modules", ".git", ".hg", ".svn", "__MACOSX", "__pycache__",
        "examples", "example", "samples", "sample", "test", "tests", "fixtures",
    }
)
_MANIFEST_MAX_DEPTH = 2
_MANIFEST_MARKER_KEYS = frozenset(
    {
        "name", "skills", "mcpServers", "commands", "agents",
        "hooks", "version", "description", "author", "userConfig", "user_config",
    }
)
# Package parts Hermes has no home for. Reported in the receipt, never installed.
_DROPPED_DIRS = ("rules", "hooks")
# Vendor / component folders that are not part of a root-level single skill.
_NON_SKILL_ROOT_ENTRIES = frozenset(
    {".codebuddy-plugin", ".claude-plugin", ".codex-plugin", ".codex", "agents",
     "commands", "hooks", "rules", "avatars", ".git", "__MACOSX"}
)


class PackageError(Exception):
    """The package cannot be installed at all (no manifest, unsafe archive, ...)."""


@dataclass
class SkillItem:
    """One skill the package contributes, after namespacing."""

    source_dir: Path          # directory in the working copy
    rel_dir: str              # dir name under kits/<plugin>/skills/
    bare_name: str
    full_name: str            # <plugin>:<skill>
    frontmatter: Dict[str, Any]
    body: str
    origin: str = "skill"     # skill | command
    trigger_key: str = ""     # UniClaw plugin_index component key
    alias: str = ""           # the package's own name when it was not usable as one (see _usable_bare)

    @property
    def description(self) -> str:
        return str(self.frontmatter.get("description") or "").strip()


# ── command descriptions ──────────────────────────────────────────────────

_COMMAND_TAG = "[工作流] "
_PREFERRED_SECTIONS = ("your role", "role", "purpose", "description", "overview", "goal", "what it does")
_SKIPPED_SECTIONS = ("usage", "context", "arguments", "parameters", "syntax", "example", "examples")
_HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$")


def _looks_like_usage(text: str) -> bool:
    text = text.strip()
    return (
        not text
        or text.startswith(("`", "/"))
        or (len(text) < 100 and "<" in text and ">" in text and " " not in text.split("<", 1)[0].strip())
    )


def _prose(lines: List[str]) -> str:
    """First prose paragraph, skipping usage lines, lists, quotes and code."""
    out: List[str] = []
    in_fence = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if not stripped:
            if out:
                break
            continue
        if stripped.startswith(("#", ">", "-", "*", "+", "|", "`", "/")) or re.match(r"^\d+[.)]\s", stripped):
            if out:
                break
            continue
        out.append(stripped)
    return " ".join(out).strip()


def command_summary(raw: str) -> str:
    """What a ``commands/*.md`` does, when its own description is only a usage line."""
    _, body = spec._split_command_frontmatter(raw)
    sections: List[tuple[str, List[str]]] = [("", [])]
    for line in body.splitlines():
        match = _HEADING_RE.match(line.strip())
        if match:
            sections.append((match.group(1).strip().lower(), []))
        else:
            sections[-1][1].append(line)
    for title, lines in sections:
        if any(title.startswith(p) for p in _PREFERRED_SECTIONS):
            text = _prose(lines)
            if text:
                return text[:300]
    for title, lines in sections:
        if any(title.startswith(s) for s in _SKIPPED_SECTIONS):
            continue
        text = _prose(lines)
        if text:
            return text[:300]
    return ""


@dataclass
class Plan:
    pristine_root: Path
    root: Path
    manifest: spec.PluginManifest
    raw_manifest: Dict[str, Any]
    digest: str
    kind: str                         # kit | expert | team | broken
    problem: Optional[str] = None
    skills: List[SkillItem] = field(default_factory=list)
    agents: List[spec.PluginAgentSpec] = field(default_factory=list)  # excludes the lead
    lead: Optional[spec.PluginAgentSpec] = None
    mcp_servers: List[Dict[str, Any]] = field(default_factory=list)
    mcp_skipped: List[Dict[str, Any]] = field(default_factory=list)
    commands_converted: List[str] = field(default_factory=list)
    hooks: Dict[str, Any] = field(default_factory=dict)
    dropped: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.manifest.name

    @property
    def version(self) -> str:
        return self.manifest.version

    def display_name(self) -> str:
        from .host_rules import localized

        return (
            localized(self.manifest.persona.get("displayName"))
            or DISPLAY_TITLES.get(self.name, "")
            or self.name
        )


# Display-only Chinese titles UniClaw shows for packages whose manifest has none.
DISPLAY_TITLES: Dict[str, str] = {
    "finance-research": "金融数据与研究",
    "plugin-advisor": "插件顾问",
    "long-manuscript-expert": "长文档写作与改稿专家",
    "equity-research": "股票研究专家",
    "douyin-strategist": "抖音策略师",
    "wechat-official-account-expert": "微信公众号运营专家",
    "xiaohongshu-operations-expert": "小红书运营专家",
}


# ── unpacking ──────────────────────────────────────────────────────────────


def _digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _digest_dir(path: Path) -> str:
    h = hashlib.sha256()
    for f in sorted(p for p in path.rglob("*") if p.is_file()):
        h.update(f.relative_to(path).as_posix().encode("utf-8"))
        h.update(_digest_file(f).encode("ascii"))
    return h.hexdigest()


def _safe_extract(archive: Path, dest: Path) -> None:
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            name = member.filename.replace("\\", "/")
            parts = [p for p in name.split("/") if p]
            if name.startswith("/") or ".." in parts or (parts and ":" in parts[0]):
                raise PackageError(f"压缩包里有不安全的路径：{member.filename}")
        zf.extractall(dest)


def _unwrap(root: Path) -> Path:
    """Descend through a single wrapper folder (``pkg.zip`` → ``pkg/…``)."""
    current = root
    for _ in range(2):
        entries = [e for e in current.iterdir() if e.name not in ("__MACOSX",)]
        if len(entries) == 1 and entries[0].is_dir() and not _manifest_candidates(current):
            current = entries[0]
        else:
            break
    return current


@contextmanager
def open_package(path: Path) -> Iterator[tuple[Path, Path, str]]:
    """Yield ``(pristine_dir, work_dir, digest)`` for a zip or a directory."""
    path = Path(path)
    if not path.exists():
        raise PackageError(f"找不到：{path}")
    with tempfile.TemporaryDirectory(prefix="uniwork-kit-") as tmp:
        pristine = Path(tmp) / "pristine"
        if path.is_dir():
            shutil.copytree(path, pristine, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            digest = _digest_dir(path)
        elif zipfile.is_zipfile(path):
            pristine.mkdir()
            _safe_extract(path, pristine)
            digest = _digest_file(path)
        else:
            raise PackageError(f"不是 zip 也不是目录：{path}")
        pristine = _unwrap(pristine)
        work = Path(tmp) / "work"
        shutil.copytree(pristine, work)
        yield pristine, work, digest


# ── manifest ───────────────────────────────────────────────────────────────


def _looks_like_manifest(path: Path) -> bool:
    try:
        data = json.loads(spec.read_pkg_text(path))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and bool(_MANIFEST_MARKER_KEYS & data.keys())


def _manifest_rank(source: Path, path: Path) -> tuple:
    rel = path.relative_to(source).parts
    depth = len(rel) - 1
    parent = rel[-2].lower() if len(rel) >= 2 else ""
    vendor = 0 if parent.endswith("-plugin") else 1
    is_root = 0 if depth == 0 else 1
    try:
        has_name = 0 if "name" in json.loads(spec.read_pkg_text(path)) else 1
    except (OSError, ValueError):
        has_name = 1
    return (vendor, is_root, depth, has_name, str(path))


def _manifest_candidates(source: Path) -> List[Path]:
    found: List[Path] = []
    for root_str, dirs, files in os.walk(source):
        root = Path(root_str)
        depth = 0 if root == source else len(root.relative_to(source).parts)
        dirs[:] = [] if depth >= _MANIFEST_MAX_DEPTH else [d for d in dirs if d not in _MANIFEST_SCAN_EXCLUDE]
        if "plugin.json" in files and _looks_like_manifest(root / "plugin.json"):
            found.append(root / "plugin.json")
    found.sort(key=lambda p: _manifest_rank(source, p))
    return found


def resolve_manifest(source: Path) -> Path:
    cands = _manifest_candidates(source)
    if not cands:
        raise PackageError("没有清单：包里找不到 plugin.json（也不在 .codebuddy-plugin/ 等目录下）")
    top = _manifest_rank(source, cands[0])[:4]
    tied = [c for c in cands if _manifest_rank(source, c)[:4] == top]
    if len(tied) > 1:
        raise PackageError(
            f"这个包里有 {len(tied)} 个同样像清单的 plugin.json，无法判断装哪一个；请一次只装一个插件。"
        )
    return cands[0]


def package_root_for(manifest: Path) -> Path:
    parent = manifest.parent
    return parent.parent if parent.name.lower().endswith("-plugin") else parent


# ── components ─────────────────────────────────────────────────────────────


def _find_skill_md(directory: Path) -> Optional[Path]:
    for name in ("SKILL.md", "skill.md", "Skill.md"):
        if (directory / name).is_file():
            return directory / name
    return None


def _split_frontmatter(text: str) -> tuple[Dict[str, Any], str]:
    from agent.skill_utils import parse_frontmatter

    fm, body = parse_frontmatter(text)
    return (fm if isinstance(fm, dict) else {}), body


def _collect_skills(plan: Plan, converted: set[str]) -> None:
    root = plan.root
    skills_root = root / "skills"
    dirs = (
        sorted(d for d in skills_root.iterdir() if d.is_dir() and not d.name.startswith("."))
        if skills_root.is_dir()
        else []
    )
    single_root = False
    if not dirs and _find_skill_md(root) is not None:
        dirs = [root]
        single_root = True

    taken: set[str] = set()
    for skill_dir in dirs:
        skill_md = _find_skill_md(skill_dir)
        if skill_md is None:
            plan.warnings.append(f"技能目录「{skill_dir.name}」里没有 SKILL.md，已跳过。")
            continue
        try:
            fm, body = _split_frontmatter(spec.read_pkg_text(skill_md))
        except (OSError, UnicodeDecodeError) as exc:
            plan.warnings.append(f"技能「{skill_dir.name}」读取失败（{exc}），已跳过。")
            continue
        default = plan.name if single_root else skill_dir.name
        bare = naming.strip_own(plan.name, str(fm.get("name") or default).strip() or default)
        if not bare or bare in (".", "..") or any(ch in '<>:"/\\|?*' for ch in bare):
            plan.warnings.append(f"技能「{skill_dir.name}」的名字不能用（{bare!r}），已跳过。")
            continue
        alias = ""
        usable = _usable_bare(bare, skill_dir.name)
        if usable != bare:
            alias, bare = bare, usable
            fm = dict(fm)
            description = str(fm.get("description") or "").strip()
            if alias not in description:
                fm["description"] = f"{alias}｜{description}" if description else alias
        full = naming.skill_name(plan.name, bare, taken=taken, warnings=plan.warnings)
        if full in taken:
            plan.warnings.append(f"包里有两个技能都叫 {full}，后一个已跳过。")
            continue
        taken.add(full)
        rel_dir = plan.name if single_root else skill_dir.name
        if skill_dir.name in converted:
            current = str(fm.get("description") or "").strip()
            if _looks_like_usage(current[len(_COMMAND_TAG):] if current.startswith(_COMMAND_TAG) else current):
                command_md = root / "commands" / f"{skill_dir.name}.md"
                try:
                    summary = command_summary(spec.read_pkg_text(command_md))
                except (OSError, UnicodeDecodeError):
                    summary = ""
                fm = dict(fm)
                fm["description"] = _COMMAND_TAG + (summary or f"{plan.name} 套件的 {skill_dir.name} 命令")
        plan.skills.append(
            SkillItem(
                source_dir=skill_dir,
                rel_dir=rel_dir,
                bare_name=bare,
                full_name=full,
                frontmatter=fm,
                body=body,
                origin="command" if skill_dir.name in converted else "skill",
                trigger_key=f"skill:{skill_dir.name}",
                alias=alias,
            )
        )


_ASCII_SLUG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _usable_bare(name: str, directory: str) -> str:
    """A skill name Hermes can turn into a slash command.

    Hermes keeps only ``[a-z0-9-]`` of a skill name for its ``/command``, so
    ``PPT视觉设计`` and ``PPT内容生成`` in one package both became ``/ppt-writer-ppt``
    and the second lost its command. Such a skill is registered under its
    directory name instead (``ppt-design``); the package's own name leads its
    description and still resolves ``<plugin>:<name>`` references.
    """
    if name.isascii() or not _ASCII_SLUG_RE.fullmatch(directory or ""):
        return name
    return directory


def _collect_mcp(plan: Plan) -> None:
    servers: List[Dict[str, Any]] = list(plan.manifest.mcp_servers)
    plan.mcp_skipped.extend(plan.manifest.mcp_skipped)
    paths: List[Path] = []
    for name in spec.MCP_MANIFEST_NAMES:
        if (plan.root / name).is_file():
            paths.append(plan.root / name)
            break
    for rel in plan.manifest.mcp_manifest_paths:
        candidate = plan.root / rel.lstrip("/\\")
        try:
            candidate.resolve().relative_to(plan.root.resolve())
        except ValueError:
            plan.warnings.append(f"mcpServers 指向包外的文件 {rel!r}，已忽略。")
            continue
        if candidate.is_file():
            if candidate not in paths:
                paths.append(candidate)
        else:
            plan.warnings.append(f"mcpServers 指向的 {rel!r} 在包里不存在，已忽略。")
    for mcp_path in paths:
        try:
            servers.extend(
                spec.parse_plugin_mcp(
                    spec.read_pkg_text(mcp_path), warnings=plan.warnings, skipped=plan.mcp_skipped
                )
            )
        except spec.PluginSpecError as exc:
            plan.warnings.append(f"MCP 配置文件 {mcp_path.name} 解析失败，已忽略：{exc}")
    # WorkBuddy marks OAuth servers in a vendor block the shared normalizer
    # drops (``x-workbuddy.auth.type: oauth``); without it Hermes would connect
    # without ever starting the sign-in flow.
    oauth_names: set[str] = set()
    raw_sources: List[Any] = []
    if plan.raw_manifest.get("mcpServers") is not None and not plan.manifest.mcp_manifest_paths:
        raw_sources.append(plan.raw_manifest["mcpServers"])
    for mcp_path in paths:
        try:
            raw_sources.append(json.loads(spec.read_pkg_text(mcp_path)))
        except (OSError, ValueError):
            pass
    for data in raw_sources:
        try:
            items = spec._mcp_manifest_items(data)
        except spec.PluginSpecError:
            continue
        for item in items:
            vendor = item.get("x-workbuddy") if isinstance(item, dict) else None
            auth = vendor.get("auth") if isinstance(vendor, dict) else None
            if isinstance(auth, dict) and str(auth.get("type") or "").lower() == "oauth":
                oauth_names.add(str(item.get("name") or ""))

    seen: set[str] = set()
    for server in servers:
        if server["name"] in seen:
            plan.warnings.append(f"MCP 服务 {server['name']!r} 声明了多次，只保留第一处。")
            continue
        seen.add(server["name"])
        if server["name"] in oauth_names:
            server["auth"] = "oauth"
        plan.mcp_servers.append(server)


def _is_lead(agent: spec.PluginAgentSpec, agent_name: str) -> bool:
    return agent.name == agent_name or Path(agent.source_file).stem == agent_name


def _classify(plan: Plan, agents: List[spec.PluginAgentSpec]) -> None:
    kind = plan.manifest.expert_type
    raw_kind = str(plan.raw_manifest.get("expertType") or "").strip()
    if kind == "agent":
        agent_name = (plan.manifest.agent_name or "").strip()
        lead = next((a for a in agents if _is_lead(a, agent_name)), None) if agent_name else None
        if not agent_name:
            plan.kind, plan.problem = "broken", "残包：写了 expertType: agent，但没有填写 agentName"
        elif lead is None:
            exists = (plan.root / "agents" / f"{agent_name}.md").is_file()
            plan.kind = "broken"
            plan.problem = (
                f"残包：主人格文件 agents/{agent_name}.md 缺少可解析的 frontmatter"
                if exists
                else f"残包：包里没有主人格文件 agents/{agent_name}.md"
            )
        elif not lead.system_prompt.strip():
            plan.kind, plan.problem = "broken", f"残包：主人格文件 agents/{agent_name}.md 正文为空"
        else:
            plan.kind, plan.lead = "expert", lead
        plan.agents = [a for a in agents if lead is None or not _is_lead(a, agent_name)]
    elif kind == "team":
        plan.kind, plan.agents = "team", agents
    else:
        if raw_kind:
            plan.warnings.append(f"expertType {raw_kind!r} 不是 agent / team，按普通套件处理。")
        plan.kind, plan.agents = "kit", agents


def build_plan(pristine: Path, work: Path, digest: str) -> Plan:
    """Classify the package in *work* and list what it contributes."""
    manifest_path = resolve_manifest(work)
    root = package_root_for(manifest_path)
    raw_text = spec.read_pkg_text(manifest_path)
    try:
        manifest = spec.parse_plugin_manifest(raw_text)
    except spec.PluginSpecError as exc:
        raise PackageError(f"清单不合法：{exc}") from exc
    raw = json.loads(raw_text)
    rel_root = root.relative_to(work)
    plan = Plan(
        pristine_root=pristine / rel_root,
        root=root,
        manifest=manifest,
        raw_manifest=raw if isinstance(raw, dict) else {},
        digest=digest,
        kind="kit",
    )
    plan.warnings.extend(w for w in manifest.warnings if "hooks" not in w)

    agents, agent_warnings = spec.parse_plugin_agents(root)
    plan.warnings.extend(agent_warnings)
    _classify(plan, agents)
    if plan.kind == "broken":
        return plan

    converted, cmd_warnings = spec.materialize_command_skills(root, plan.name)
    plan.commands_converted = converted
    plan.warnings.extend(cmd_warnings)
    _collect_skills(plan, set(converted))
    _collect_mcp(plan)

    from . import package_hooks

    declared = package_hooks.load_declared(root, plan.raw_manifest)
    if declared:
        plan.hooks = declared
    elif plan.raw_manifest.get("hooks"):
        plan.dropped.append("hooks（声明了但读不出来，没有接入）")
    for folder in _DROPPED_DIRS:
        d = root / folder
        if d.is_dir() and any(d.iterdir()) and not (folder == "hooks" and plan.raw_manifest.get("hooks")):
            count = sum(1 for p in d.rglob("*") if p.is_file())
            plan.dropped.append(f"{folder}/（{count} 个文件，不注入模型）")
    return plan


def root_skill_ignore(root: Path):
    """``copytree`` filter for a package whose root *is* its only skill.

    Drops the vendor / component folders at the package root only; a skill's
    own ``references/agents.md`` deeper down is kept.
    """
    root = Path(root).resolve()

    def _ignore(src: str, names: List[str]) -> List[str]:
        if Path(src).resolve() != root:
            return []
        return [n for n in names if n in _NON_SKILL_ROOT_ENTRIES]

    return _ignore
