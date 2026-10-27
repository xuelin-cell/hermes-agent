"""企业资源：平台下发的 Agent、技能、连接器和企业经验，按入口给的清单装进实例。

转发器的 ``POST /__mt/enterprise`` 调这里（入口带实例令牌送来清单，清单怎么算见 entry/entry/enterprise.py）。
清单只说「要什么」，这里负责「怎么装」：

- **默认 profile**（HERMES_HOME 本身）：清单 ``default`` 段里的企业技能、专家包、企业经验装进
  ``skills/_org/<企业>/``；企业连接器写进 config.yaml 的 ``mcp_servers``（名字带 ``uniwork-ent-`` 前缀，
  用户在界面里停用了的保持停用）。员工实例的默认 profile 只有全员可见的那些；平台的运行环境整份都在这里。
- **每个 Agent 一个托管 profile** ``profiles/uw-<id>/``：人设和企业事实（SOUL.md）、模型（请求头带
  ``X-Uniwork-Agent``，平台据此放行这个 Agent 的模型）、确认方式、记忆开关，以及它自己的技能、专家包、
  连接器和企业经验。托管 profile 归平台：每次按清单整份重写，员工在里面的会话和记忆归员工。
- **下架**：托管 profile 整个移到 ``profiles/.uw-retired/``，会话和记忆都在；重新发布时移回来。
- 技能包、专家包从平台下载（设备令牌），校验 sha256，解压时挡住越界路径、链接和超大包；
  下载过的包按 sha256 缓存在 ``.cache/uniwork-enterprise/``（不进归档）。

设备令牌在默认 profile 的 .env 里（入口告诉我们变量名）。托管 profile 各有一份 .env，每次安装、
以及转发器定时检查时，都按默认 profile 的值同步（:func:`sync_tokens`），换令牌后托管 profile 不会掉队。
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import shutil
import stat
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable

import mtstate

SPEC_VERSION = 1
MANAGED_PREFIX = "uw-"
MANAGED_MARK = ".uw-managed.json"
RETIRED_DIR = ".uw-retired"
ENT_MCP_PREFIX = "uniwork-ent-"
PLUGIN_MCP_PREFIX = "uniwork-plugin-"
KNOWLEDGE_MCP = "uniwork-knowledge"
AGENT_HEADER = "X-Uniwork-Agent"
# 状态和下载缓存放 .cache/ 下：不进归档（mtstate.EXCLUDE_TOP），hermes 的用户也写得了
# （Docker 路径的转发器以 hermes 的用户跑，写不了入口以 root 放进来的 .mt/）
STATE_FILE = ".cache/uniwork-enterprise/state.json"
CACHE_DIR = ".cache/uniwork-enterprise/packages"

MAX_PACKAGE_BYTES = 20 * 1024 * 1024
MAX_EXTRACTED_BYTES = 80 * 1024 * 1024
MAX_PACKAGE_FILES = 2000
FETCH_TIMEOUT_S = 60

_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SLUG_RE = re.compile(r"[^a-z0-9_-]+")

Fetch = Callable[[str, str], bytes]


class EnterpriseError(RuntimeError):
    """一项资源装不上（下载失败、校验不过、包不合法）。记进报告，不影响其他项。"""


# ---------------------------------------------------------------- 小工具

def _slug(text: str, fallback: str = "x", limit: int = 48) -> str:
    """目录名用的写法：小写字母、数字、_ 和 -；改写过或太长就补一段摘要，保证不同的输入不会撞名。"""
    raw = str(text or "").strip()
    slug = _SLUG_RE.sub("-", raw.lower()).strip("-_") or fallback
    if slug != raw or len(slug) > limit:
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
        slug = f"{slug[:limit - 9].rstrip('-_') or fallback}-{digest}"
    return slug


def profile_name(agent_id: str) -> str:
    """Agent 的托管 profile 名：``uw-<id>``，满足 hermes 的 profile 名规则（见 hermes_constants）。"""
    name = MANAGED_PREFIX + _slug(agent_id, "agent", 64 - len(MANAGED_PREFIX))
    return name if _PROFILE_NAME_RE.match(name) else MANAGED_PREFIX + hashlib.sha256(agent_id.encode()).hexdigest()[:16]


def _owner_of(home: Path) -> tuple[int, int] | None:
    """转发器以 root 跑时，新建的文件要交给 hermes 的用户（HERMES_HOME 的主人），不然 hermes 写不了。"""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return None
    try:
        st = home.stat()
    except OSError:
        return None
    return st.st_uid, st.st_gid


def _chown_tree(path: Path, owner: tuple[int, int] | None) -> None:
    if owner is None or not path.exists():
        return
    targets = [path]
    if path.is_dir() and not path.is_symlink():
        targets += [Path(root) / name for root, dirs, files in os.walk(path) for name in dirs + files]
    for target in targets:
        try:
            os.chown(target, *owner, follow_symlinks=False)
        except OSError:
            pass


def _mkdirs(path: Path, stop: Path, owner: tuple[int, int] | None) -> None:
    """建目录，新建的那几层都交给 hermes 的用户。"""
    missing = []
    probe = path
    while not probe.exists() and probe != stop and probe != probe.parent:
        missing.append(probe)
        probe = probe.parent
    path.mkdir(parents=True, exist_ok=True)
    for made in missing:
        _chown_tree(made, owner)


def _write(path: Path, data: bytes, home: Path, owner: tuple[int, int] | None, mode: int = 0o644) -> bool:
    """内容变了才写（原子写），返回写没写。"""
    try:
        if path.read_bytes() == data:
            return False
    except OSError:
        pass
    _mkdirs(path.parent, home, owner)
    mtstate._write_atomic(path, data)  # noqa: SLF001 —— 同一套原子写
    try:
        path.chmod(mode)
    except OSError:
        pass
    _chown_tree(path, owner)
    return True


def env_value(env_path: Path, name: str) -> str:
    """读 .env 里一个变量的值（只认 ``KEY=VALUE`` 行）。没有就是空串。"""
    if not name:
        return ""
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    value = ""
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key, val = line.split("=", 1)
            if key.strip() == name:
                value = val.strip()
    return value


# ---------------------------------------------------------------- 下载和解包

def make_fetch(token: str) -> Fetch:
    """按设备令牌下载平台上的文件；超过上限就不读了。"""
    def fetch(url: str, _what: str) -> bytes:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:  # noqa: S310 —— 地址已核对过前缀
                data = resp.read(MAX_PACKAGE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise EnterpriseError(f"下载失败：平台返回 HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise EnterpriseError(f"下载失败：{type(exc).__name__}") from exc
        if len(data) > MAX_PACKAGE_BYTES:
            raise EnterpriseError(f"包超过 {MAX_PACKAGE_BYTES // (1024 * 1024)}MB")
        return data
    return fetch


def _package_bytes(home: Path, item: dict, server: str, fetch: Fetch) -> bytes:
    """一个包的内容：先看缓存（按 sha256），没有再下载并校验。"""
    url = str(item.get("url") or "")
    want = str(item.get("sha256") or "").lower()
    if not server or not url.startswith(server.rstrip("/") + "/"):
        raise EnterpriseError("下载地址不在企业管理平台上")
    cache = home / CACHE_DIR / f"{want}.zip" if re.fullmatch(r"[0-9a-f]{64}", want) else None
    if cache is not None and cache.is_file():
        data = cache.read_bytes()
        if hashlib.sha256(data).hexdigest() == want:
            return data
    data = fetch(url, str(item.get("name") or item.get("id") or ""))
    got = hashlib.sha256(data).hexdigest()
    if want and got != want:
        raise EnterpriseError("包的 sha256 和平台给的不一致")
    if cache is not None:
        try:
            _mkdirs(cache.parent, home, _owner_of(home))
            mtstate._write_atomic(cache, data)  # noqa: SLF001
        except OSError:
            pass  # 缓存写不了只是下次再下载
    return data


def _members(data: bytes) -> list[tuple[zipfile.ZipInfo, PurePosixPath]]:
    """zip 里可以解出来的文件：挡掉绝对路径、越界、链接，限制个数和解压后的大小。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise EnterpriseError("不是合法的 zip 包") from exc
    infos = archive.infolist()
    if len(infos) > MAX_PACKAGE_FILES:
        raise EnterpriseError(f"包里的文件超过 {MAX_PACKAGE_FILES} 个")
    out = []
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if info.is_dir() or name.endswith("/"):
            continue
        rel = PurePosixPath(name)
        if rel.is_absolute() or ".." in rel.parts or ":" in rel.parts[0]:
            raise EnterpriseError(f"包里有越界路径：{name}")
        kind = (info.external_attr >> 16) & 0o170000
        if kind == stat.S_IFLNK:
            continue  # 链接不解
        if "__MACOSX" in rel.parts:
            continue
        total += info.file_size
        if total > MAX_EXTRACTED_BYTES:
            raise EnterpriseError(f"包解压后超过 {MAX_EXTRACTED_BYTES // (1024 * 1024)}MB")
        out.append((info, rel))
    return out


def _skill_roots(members: list[tuple[zipfile.ZipInfo, PurePosixPath]]) -> list[PurePosixPath]:
    """包里每个技能的根目录：放着 SKILL.md 的那一层（技能里面再套的 SKILL.md 不算新技能）。"""
    found = sorted({rel.parent for _, rel in members if rel.name == "SKILL.md"}, key=lambda p: (len(p.parts), str(p)))
    roots: list[PurePosixPath] = []
    for candidate in found:
        if not any(candidate == root or root in candidate.parents for root in roots):
            roots.append(candidate)
    return roots


def _extract_skills(data: bytes, dest: Path, fallback_name: str) -> list[str]:
    """把包里的技能解到 ``dest/<技能目录>/``，返回装了哪些目录。包本身就是一个技能（SKILL.md 在最外层）时用 fallback_name。"""
    members = _members(data)
    roots = _skill_roots(members)
    if not roots:
        raise EnterpriseError("包里没有 SKILL.md")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names: list[str] = []
        for root in roots:
            dirname = _slug(root.name if root.parts else fallback_name, "skill")
            if dirname in names:
                continue
            target = dest / dirname
            for info, rel in members:
                if root.parts and root not in rel.parents:
                    continue
                if not root.parts and any(other.parts and other in rel.parents for other in roots if other != root):
                    continue
                inner = rel.relative_to(root) if root.parts else rel
                out = target.joinpath(*inner.parts)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(archive.read(info))
                executable = ((info.external_attr >> 16) & 0o111) or inner.parts[0] in ("scripts", "bin")
                out.chmod(0o755 if executable and out.suffix in ("", ".py", ".sh") else 0o644)
            names.append(dirname)
    return names


def _plugin_mcp(data: bytes) -> dict:
    """专家包里声明的 HTTP MCP 服务（``.mcp.json`` 的 mcpServers，或 plugin.json 里的 mcpServers）。

    要本地起进程的 stdio 服务不装：实例里没有包的运行环境，装了也起不来。"""
    servers: dict = {}
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return servers
    with archive:
        for info in archive.infolist():
            name = PurePosixPath(info.filename.replace("\\", "/"))
            if name.name not in (".mcp.json", "plugin.json") or len(name.parts) > 3:
                continue
            try:
                doc = json.loads(archive.read(info).decode("utf-8-sig"))
            except (ValueError, UnicodeDecodeError):
                continue
            block = doc.get("mcpServers") if isinstance(doc, dict) else None
            if not isinstance(block, dict):
                continue
            for key, conf in block.items():
                url = conf.get("url") if isinstance(conf, dict) else None
                if isinstance(url, str) and url.startswith(("http://", "https://")) and "${" not in url:
                    entry = {"url": url}
                    if str(conf.get("type") or conf.get("transport") or "").lower() == "sse":
                        entry["transport"] = "sse"
                    servers[str(key)] = entry
    return servers


# ---------------------------------------------------------------- 技能目录

def _install_category(home: Path, profile_home: Path, tenant: str, category: str, items: list[dict], server: str,
                      fetch: Fetch, owner, report: dict, *, plugin_mcp: dict | None = None) -> None:
    """把一组包装进 ``<profile>/skills/_org/<企业>/<category>/``。

    包的集合（按 sha256）没变就不动；变了就在旁边解一份新的再整体换上，换的过程中旧的一直可用。
    ``plugin_mcp`` 不是 None 时，顺带收集包里声明的 HTTP MCP 服务（专家包用）。
    """
    org_root = profile_home / "skills" / "_org" / tenant
    target = org_root / category
    stamp = target / ".uw-packages.json"
    want = sorted(f"{i.get('sha256', '')}:{i.get('id', '')}" for i in items)
    try:
        have = json.loads(stamp.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        have = None
    if not items:
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            report["removed"].append(str(target.relative_to(home)))
        return

    def collect_mcp(item: dict, data: bytes) -> None:
        if plugin_mcp is None:
            return
        prefix = f"{PLUGIN_MCP_PREFIX}{_slug(str(item.get('name') or item.get('id')), 'plugin', 24)}-"
        for key, conf in _plugin_mcp(data).items():
            plugin_mcp[prefix + _slug(key, "mcp", 24)] = conf

    if have == want:
        for item in items if plugin_mcp is not None else []:
            try:
                collect_mcp(item, _package_bytes(home, item, server, fetch))
            except EnterpriseError as exc:
                report["errors"].append(f"{item.get('displayName') or item.get('name') or category}：{exc}")
        return
    _mkdirs(org_root, home, owner)
    staging = org_root / f".{category}.new"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    installed: list[str] = []
    complete = True
    for item in items:
        label = str(item.get("displayName") or item.get("name") or item.get("id") or "")
        try:
            data = _package_bytes(home, item, server, fetch)
            installed += _extract_skills(data, staging, str(item.get("name") or item.get("id") or "skill"))
            collect_mcp(item, data)
        except EnterpriseError as exc:
            report["errors"].append(f"{label or category}：{exc}")
            complete = False
    # 装得不全时记一个永远对不上的包集合：下次同步再试，这个目录也仍然认得出是我们装的
    (staging / ".uw-packages.json").write_text(json.dumps(want if complete else ["!incomplete"]), encoding="utf-8")
    old = org_root / f".{category}.old"
    shutil.rmtree(old, ignore_errors=True)
    if target.exists():
        target.rename(old)
    staging.rename(target)
    shutil.rmtree(old, ignore_errors=True)
    _chown_tree(target, owner)
    report["installed"].append(f"{target.relative_to(home)}：{', '.join(installed) or '（无）'}")


def _set_active_org(home: Path, profile_home: Path, tenant: str, owner) -> None:
    """``skills/_org/.active_org``：hermes 只加载这个企业的组织技能（agent/skill_utils.read_active_org_id）。
    没有企业（解绑了）就删掉标记，组织技能不再加载。"""
    marker = profile_home / "skills" / "_org" / ".active_org"
    if tenant:
        _write(marker, tenant.encode("utf-8"), home, owner)
    elif marker.exists():
        marker.unlink()


def _prune_categories(profile_home: Path, tenant: str, keep: set[str]) -> list[str]:
    """``_org/<企业>/`` 下我们装过、这次清单里没有的分类目录，删掉。别人放的（没有我们的标记）不碰。"""
    root = profile_home / "skills" / "_org" / tenant
    removed = []
    try:
        entries = list(root.iterdir())
    except OSError:
        return removed
    for entry in entries:
        if entry.is_dir() and entry.name not in keep and (entry / ".uw-packages.json").exists():
            shutil.rmtree(entry, ignore_errors=True)
            removed.append(entry.name)
    return removed


# ---------------------------------------------------------------- MCP 和配置

def _connector_mcp(item: dict, token_env: str) -> dict:
    """企业连接器的 MCP 配置：有平台中转（relay）就走中转，用设备令牌鉴权；没有才连上游地址。"""
    relay = str(item.get("relay") or "")
    if relay:
        entry: dict = {"url": relay, "headers": {"Authorization": f"Bearer ${{{token_env}}}"}}
    else:
        entry = {"url": str(item.get("url") or "")}
        if str(item.get("transport") or "").lower() == "sse":
            entry["transport"] = "sse"
    timeout = item.get("timeout")
    if isinstance(timeout, int) and not isinstance(timeout, bool) and timeout > 0:
        entry["timeout"] = timeout
    return entry


def _knowledge_mcp(layers: list[dict], token_env: str) -> dict:
    """事实太多（没有 inline）时，企业知识检索 MCP；多个经验层时只取第一个有检索地址的。"""
    for layer in layers:
        facts = layer.get("facts") or {}
        url = str((layer.get("knowledgeMcp") or {}).get("url") or "")
        if url and facts.get("count") and not facts.get("inline"):
            return {KNOWLEDGE_MCP: {"url": url, "headers": {"Authorization": f"Bearer ${{{token_env}}}"}}}
    return {}


def _merge_mcp(cfg, desired: dict, prefixes: tuple[str, ...]) -> None:
    """把 ``desired`` 写进 mcp_servers；名字以 prefixes 开头、清单里没有的删掉。用户停用过的保持停用。"""
    servers = cfg.get("mcp_servers")
    if not isinstance(servers, dict):
        if not desired:
            return
        servers = mtstate._section(cfg, "mcp_servers")  # noqa: SLF001
    for name in [n for n in list(servers) if str(n).startswith(prefixes) and n not in desired]:
        del servers[name]
    for name, conf in desired.items():
        entry = servers.get(name)
        enabled = entry.get("enabled") if isinstance(entry, dict) else None
        fresh = dict(conf)
        if enabled is False:
            fresh["enabled"] = False
        servers[name] = fresh


def _patch_default_config(home: Path, connectors: dict, token_env: str, report: dict) -> None:
    """默认 profile 的 config.yaml：只动企业连接器、专家包 MCP、企业知识检索这几条，别的设置不碰。"""
    path = home / "config.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    load, dump = mtstate._yaml_io()  # noqa: SLF001
    try:
        cfg = load(text) or {}
    except Exception as exc:  # noqa: BLE001
        report["errors"].append(f"默认 profile 的 config.yaml 解析不了，企业连接器没写进去：{type(exc).__name__}")
        return
    if not isinstance(cfg, dict):
        return
    before = json.dumps(cfg.get("mcp_servers"), sort_keys=True, default=str)
    _merge_mcp(cfg, connectors, (ENT_MCP_PREFIX, PLUGIN_MCP_PREFIX, KNOWLEDGE_MCP))
    if json.dumps(cfg.get("mcp_servers"), sort_keys=True, default=str) == before:
        return
    new_text = dump(cfg)
    mtstate._check_parses(new_text)  # noqa: SLF001
    mtstate._write_atomic(path, new_text.encode("utf-8"))  # noqa: SLF001
    report["mcp_changed"].append("default")


def _agent_config(spec: dict, agent: dict, mcp: dict) -> str:
    """托管 profile 的 config.yaml：入口给的模板（和员工默认 profile 同一份），换上这个 Agent 的模型、
    请求头、确认方式、记忆开关和 MCP。整份由我们生成，不保留任何人的手改。"""
    config = copy.deepcopy(spec.get("config") or {})
    template = str(config.get("template") or "")
    if not template.strip():
        raise EnterpriseError("入口没给配置模板")
    load, dump = mtstate._yaml_io()  # noqa: SLF001
    cfg = load(template)
    model = str(agent.get("model") or config.get("model") or "")
    names = [str(n) for n in (agent.get("models") or config.get("models") or []) if str(n)]
    if model and model not in names:
        names = [model] + names
    limits = dict(config.get("limits") or {})
    limits.update(agent.get("limits") or {})  # Agent 的模型员工自己的套餐里可能没有：上下文长度由平台策略给
    config.update(model=model, models=names, limits=limits, mcp_servers={})
    mtstate.apply_platform_block(cfg, config)
    model_section = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    model_section["default"] = model or model_section.get("default")
    key = str(config.get("provider_key") or "")
    providers = cfg.get("providers") if isinstance(cfg.get("providers"), dict) else {}
    if key and isinstance(providers.get(key), dict):
        providers[key]["extra_headers"] = {AGENT_HEADER: str(agent.get("id") or "")}
    approvals = mtstate._section(cfg, "approvals")  # noqa: SLF001
    approvals["mode"] = agent.get("approval") if agent.get("approval") in ("smart", "manual", "off") else "smart"
    memory = mtstate._section(cfg, "memory")  # noqa: SLF001
    remember = agent.get("memory") != "session"
    memory["memory_enabled"] = remember
    memory["user_profile_enabled"] = remember
    servers = {}
    servers.update({k: v for k, v in (config.get("builtin_mcp") or {}).items() if isinstance(v, dict)})
    servers.update(mcp)
    cfg["mcp_servers"] = servers
    text = dump(cfg)
    mtstate._check_parses(text)  # noqa: SLF001
    return text


def _soul(agent: dict, layers: list[dict]) -> str:
    """托管 profile 的人设：Agent 的角色与指令，加上企业经验里 inline 的事实（回答时必须遵守）。"""
    name = str(agent.get("name") or agent.get("id") or "").strip()
    parts = [f"# {name}", str(agent.get("instructions") or "").strip()]
    facts = [f for layer in layers for f in ((layer.get("facts") or {}).get("items") or []) if isinstance(f, dict)]
    if facts:
        lines = ["## 企业事实", "以下是企业统一的口径、规则和术语，经企业审核发布。回答相关问题时必须遵守："]
        lines += [f"- **{str(f.get('title') or f.get('name') or '').strip()}**：{str(f.get('content') or '').strip()}"
                  for f in facts]
        parts.append("\n".join(lines))
    return "\n\n".join(p for p in parts if p) + "\n"


def _profile_meta(agent: dict, existing: str = "") -> str:
    """profile.yaml：显示名、描述、Bot Mode 列表的标题（列表按这几项显示），以及我们的托管标记 ``ui_meta.uniwork``
    （前端据此收起编辑、复制、删除）。Bot Mode 自己往 ``ui_meta['hermes-bots']`` 里记的置顶、分组、头像颜色，
    以及 hermes 写的别的字段，都原样保留。"""
    load, dump = mtstate._yaml_io()  # noqa: SLF001
    name = str(agent.get("name") or agent.get("id") or "")
    try:
        doc = load(existing) if existing.strip() else None
    except Exception:  # noqa: BLE001 —— 坏了就重写
        doc = None
    if not isinstance(doc, dict):
        doc = load("{}") or {}
    doc["display_name"] = name
    doc["description"] = str(agent.get("description") or "")
    ui_meta = doc.get("ui_meta") if isinstance(doc.get("ui_meta"), dict) else {}
    bots = ui_meta.get("hermes-bots") if isinstance(ui_meta.get("hermes-bots"), dict) else {}
    bots["title"] = name
    ui_meta["hermes-bots"] = bots
    ui_meta["uniwork"] = {"managed": True, "agent": str(agent.get("id") or ""), "kind": "agent"}
    doc["ui_meta"] = ui_meta
    return dump(doc)


# ---------------------------------------------------------------- 托管 profile

def managed_profiles(home: Path) -> dict[str, dict]:
    """现有的托管 profile：{profile 名: 标记内容}（不含已下架的）。"""
    out: dict[str, dict] = {}
    root = home / "profiles"
    try:
        entries = list(root.iterdir())
    except OSError:
        return out
    for entry in entries:
        mark = entry / MANAGED_MARK
        if entry.is_dir() and _PROFILE_NAME_RE.match(entry.name) and mark.is_file():
            try:
                out[entry.name] = json.loads(mark.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                out[entry.name] = {}
    return out


def _retire(home: Path, name: str, report: dict) -> None:
    """下架：整个 profile 移到 profiles/.uw-retired/，会话和记忆都留着。"""
    src = home / "profiles" / name
    dst_root = home / "profiles" / RETIRED_DIR
    dst = dst_root / name
    dst_root.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    src.rename(dst)
    report["retired"].append(name)


def _restore_retired(home: Path, name: str, report: dict) -> None:
    """重新发布：下架时留着的 profile 移回来，接着用原来的会话和记忆。"""
    src = home / "profiles" / RETIRED_DIR / name
    dst = home / "profiles" / name
    if src.is_dir() and not dst.exists():
        src.rename(dst)
        report["restored"].append(name)


def _apply_agent(home: Path, spec: dict, agent: dict, fetch: Fetch, owner, token: str, report: dict) -> None:
    agent_id = str(agent.get("id") or "")
    name = profile_name(agent_id)
    profile = home / "profiles" / name
    mark = profile / MANAGED_MARK
    if profile.exists() and not mark.exists():
        report["errors"].append(f"Agent「{agent.get('name')}」：profile {name} 已被占用，没有覆盖")
        return
    _restore_retired(home, name, report)
    fresh = not profile.exists()
    _mkdirs(profile, home, owner)
    if fresh:
        # 先打上托管标记：后面哪一步出错留下半个目录，下次同步也认得出是自己的，接着装
        _write(mark, json.dumps({"agent": agent_id}).encode("utf-8"), home, owner)
    tenant = str(spec.get("tenant") or "")
    server = str(spec.get("server") or "")
    token_env = str(spec.get("token_env") or "")
    layers = [layer for layer in agent.get("layers") or [] if isinstance(layer, dict)]

    _set_active_org(home, profile, tenant, owner)
    keep = {"enterprise", "experience"}
    _install_category(home, profile, tenant, "enterprise", list(agent.get("skills") or []), server, fetch, owner, report)
    plugin_mcp: dict = {}
    for plugin in agent.get("plugins") or []:
        category = "plugin-" + _slug(str(plugin.get("name") or plugin.get("id") or ""), "plugin", 40)
        keep.add(category)
        _install_category(home, profile, tenant, category, [plugin], server, fetch, owner, report, plugin_mcp=plugin_mcp)
    layer_skills = [s for layer in layers for s in layer.get("skills") or [] if isinstance(s, dict)]
    _install_category(home, profile, tenant, "experience", layer_skills, server, fetch, owner, report)
    _prune_categories(profile, tenant, keep)

    mcp = {f"{ENT_MCP_PREFIX}{_slug(str(c.get('id') or ''), 'connector', 40)}": _connector_mcp(c, token_env)
           for c in agent.get("connectors") or [] if isinstance(c, dict) and (c.get("relay") or c.get("url"))}
    mcp.update(plugin_mcp)
    mcp.update(_knowledge_mcp(layers, token_env))
    try:
        config_text = _agent_config(spec, agent, mcp)
    except EnterpriseError as exc:
        report["errors"].append(f"Agent「{agent.get('name')}」：{exc}")
        return
    changed = []
    if _write(profile / "config.yaml", config_text.encode("utf-8"), home, owner):
        changed.append("config.yaml")
    env_lines = ["TERMINAL_ENV=local"] + ([f"{token_env}={token}"] if token_env and token else [])
    env_path = profile / ".env"
    if fresh or not env_path.exists():
        _write(env_path, ("\n".join(env_lines) + "\n").encode("utf-8"), home, owner, 0o600)
    else:
        mtstate.env_upsert(env_path, env_lines)
        _chown_tree(env_path, owner)
    if _write(profile / "SOUL.md", _soul(agent, layers).encode("utf-8"), home, owner):
        changed.append("SOUL.md")
    meta_path = profile / "profile.yaml"
    existing_meta = meta_path.read_text(encoding="utf-8") if meta_path.is_file() else ""
    if _write(meta_path, _profile_meta(agent, existing_meta).encode("utf-8"), home, owner):
        changed.append("profile.yaml")
    try:
        previous = json.loads(mark.read_text(encoding="utf-8")) if mark.is_file() else {}
    except (OSError, ValueError):
        previous = {}
    mcp_sig = hashlib.sha256(json.dumps(mcp, sort_keys=True, default=str).encode()).hexdigest()[:16]
    marker = {"tenant": tenant, "agent": agent_id, "key": str(agent.get("key") or ""),
              "revision": str(agent.get("revision") or ""), "mcp": mcp_sig,
              "layers": {str(layer.get("key") or ""): str(layer.get("version") or "") for layer in layers}}
    _write(mark, json.dumps(marker, ensure_ascii=False, sort_keys=True).encode("utf-8"), home, owner)
    if changed:
        report["profiles"][name] = changed
    if previous.get("mcp") != mcp_sig:
        report["mcp_changed"].append(name)  # hermes 只在启动时连 MCP


def sync_tokens(home: Path, token_env: str) -> list[str]:
    """把默认 profile .env 里的设备令牌同步到其他 profile：托管 profile 一律同步；员工自建的机器人
    （``profiles.create`` 建时复制了默认 profile 的 .env）只在它本来就有这个变量时同步。返回改过的 profile 名。"""
    token = env_value(home / ".env", token_env)
    if not token_env or not token:
        return []
    changed = []
    owner = _owner_of(home)
    managed = managed_profiles(home)
    for profile in mtstate.hermes_homes(home)[1:]:
        env_path = profile / ".env"
        have = env_value(env_path, token_env)
        if have == token or (profile.name not in managed and not have):
            continue
        mtstate.env_upsert(env_path, [f"{token_env}={token}"])
        _chown_tree(env_path, owner)
        changed.append(profile.name)
    return changed


def token_env_of(home: Path) -> str:
    """上一次清单里的令牌变量名（转发器定时同步令牌时用）。"""
    try:
        return str(json.loads((home / STATE_FILE).read_text(encoding="utf-8")).get("token_env") or "")
    except (OSError, ValueError):
        return ""


# ---------------------------------------------------------------- 入口

def apply(home: Path, spec: dict, fetch: Fetch | None = None) -> dict:
    """按清单装企业资源，返回报告：

    ``{"ok", "profiles": {名: [改了的文件]}, "installed", "removed", "retired", "restored",
    "mcp_changed": [默认 profile 写成 "default"], "errors"}``。一项装不上记进 errors，不影响其他项。
    """
    if int(spec.get("v") or 0) != SPEC_VERSION:
        raise EnterpriseError(f"清单版本不对：{spec.get('v')!r}")
    report: dict = {"profiles": {}, "installed": [], "removed": [], "retired": [], "restored": [],
                    "mcp_changed": [], "errors": []}
    owner = _owner_of(home)
    tenant = str(spec.get("tenant") or "")
    if tenant and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", tenant):
        raise EnterpriseError("企业 ID 不合法")
    server = str(spec.get("server") or "")
    token_env = str(spec.get("token_env") or "")
    token = env_value(home / ".env", token_env)
    fetch = fetch or make_fetch(token)

    # 默认 profile
    default = spec.get("default") or {}
    _set_active_org(home, home, tenant, owner)
    if tenant:
        keep = {"enterprise", "experience"}
        _install_category(home, home, tenant, "enterprise", list(default.get("skills") or []), server, fetch, owner,
                          report)
        plugin_mcp: dict = {}
        for plugin in default.get("plugins") or []:
            category = "plugin-" + _slug(str(plugin.get("name") or plugin.get("id") or ""), "plugin", 40)
            keep.add(category)
            _install_category(home, home, tenant, category, [plugin], server, fetch, owner, report,
                              plugin_mcp=plugin_mcp)
        layers = [layer for layer in default.get("layers") or [] if isinstance(layer, dict)]
        _install_category(home, home, tenant, "experience",
                          [s for layer in layers for s in layer.get("skills") or [] if isinstance(s, dict)],
                          server, fetch, owner, report)
        _prune_categories(home, tenant, keep)
        mcp = {f"{ENT_MCP_PREFIX}{_slug(str(c.get('id') or ''), 'connector', 40)}": _connector_mcp(c, token_env)
               for c in default.get("connectors") or [] if isinstance(c, dict) and (c.get("relay") or c.get("url"))}
        mcp.update(plugin_mcp)
        mcp.update(_knowledge_mcp(layers, token_env))
        _patch_default_config(home, mcp, token_env, report)
    else:
        _patch_default_config(home, {}, token_env, report)

    # 托管 profile
    wanted = {profile_name(str(a.get("id") or "")): a for a in spec.get("agents") or []
              if isinstance(a, dict) and a.get("id")}
    if wanted:
        _mkdirs(home / "profiles", home, owner)
    for name, agent in wanted.items():
        try:
            _apply_agent(home, spec, agent, fetch, owner, token, report)
        except (OSError, ValueError, EnterpriseError) as exc:
            report["errors"].append(f"Agent「{agent.get('name')}」：{type(exc).__name__}: {exc}")
    for name in managed_profiles(home):
        if name not in wanted:
            try:
                _retire(home, name, report)
            except OSError as exc:
                report["errors"].append(f"下架 {name} 失败：{exc}")

    _write(home / STATE_FILE, json.dumps({"token_env": token_env, "tenant": tenant,
                                          "revision": str(spec.get("revision") or "")}).encode("utf-8"),
           home, owner, 0o600)
    report["ok"] = not report["errors"]
    return report
