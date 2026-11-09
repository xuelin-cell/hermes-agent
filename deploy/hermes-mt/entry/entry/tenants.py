"""租户生命周期：一用户一容器、一网络、一卷。

设计约束（照隔壁方案说明）：
- hermes 镜像**一个字节不改**。转发器是卷里的一段 python（seed/forward.py），
  由容器 CMD 以 ``sh -c 'python3 forward.py & exec hermes serve …'`` 拉起，
  hermes 仍绑 127.0.0.1:9120，鉴权门关着，ws 的对端是 127.0.0.1。
- 每个租户一个独立 bridge 网络，入口容器自己 connect 进去；租户之间没有共同网络，
  互相不可达。不用 ``enable_icc=false``（那会把入口也挡在外面）。
- 用户数据全在 named volume ``<prefix>-data-<uid>``；容器随时可删重建。
- 首次建卷时把 ``.env``（模型 key）和 ``config.yaml`` 放进去；镜像的 stage2 hook
  只在文件不存在时才 seed，所以我们放的文件不会被覆盖，之后会被 chown 给 hermes。
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import ipaddress
import json
import logging
import re
import socket
import sys
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlsplit

import aiohttp

from .config import Settings
from .cube_api import Cube, CubeError, SandboxGone, forwarder_unreachable
from .docker_api import Docker, DockerError
from .store import Store
from .langfuse_config import credential_lines, upload_url

log = logging.getLogger("entry.tenants")

SEED_DIR = Path(__file__).resolve().parent.parent / "seed"
# 平台给用户的默认人设（元景数字员工），代替 hermes 自带的「You are Hermes Agent, built by Nous Research」。
DEFAULT_SOUL_FILE = Path(__file__).resolve().parent / "default_soul.md"

# 平台正在删的实例：控制面还列得出来，但不能再当"在"用。
GONE_STATES = frozenset({"deleting", "terminating", "deleted"})


class RequestAbandoned(Exception):
    """排队等这个用户的实例时，发请求的浏览器已经断开了。"""

# 内置的元景 MCP 在 config.yaml 里叫这个名字，agent 看到的工具名是 mcp__yuanjing__<工具>。这一条归平台：
# 每次引导按平台的写（用户在界面里停用的保留停用），平台不提供时删掉。
YUANJING_MCP_NAME = "yuanjing"
# 元景 mcp-server 最慢的工具（文档翻译）要 10 分钟；hermes 默认一次工具调用最多等 300 秒。
YUANJING_MCP_TIMEOUT_S = 600
# 沙箱镜像自带的企业对接插件（deploy/hermes-mt/plugin）在 hermes 里的名字：企业模式下写进 plugins.enabled。
UNIWORK_PLUGIN_KEY = "uniwork-enterprise"

# 平台策略：每次引导都按这里写进用户的 config.yaml（seed/mtstate.py 的 apply_platform_block）。
# 只有普通版才有的平台策略（云盘、邮箱、分享、套件、消息平台）：企业模式不写。
PERSONAL_POLICY_KEYS = frozenset({"cloud_sharing", "cloud_drive", "cloud_mail", "cloud_kits",
                                  "cloud_messaging_delivery", "platforms"})
# 桌面插件（如联网搜索 unisearch）认的 MaaS key 变量名；和桌面一样就是 my-plan 给的套餐 key。
# 普通版在实例 .env 里按这个名字再写一份，插件不用改。企业模式的 key 是设备令牌，不写。
DESKTOP_MAAS_KEY_ENV = "DESKTOP_MT_MAAS_API_KEY"
# config.yaml.tmpl 里只有普通版才有的一段：企业模式由入口整段去掉（_render_user_files）。
_PERSONAL_TEMPLATE_BLOCK = re.compile(r"^# personal-begin.*?^# personal-end[^\n]*\n", re.M | re.S)
PLATFORM_POLICY = {
    # 在线模型目录（OpenRouter / Nous 的推荐清单）：集群里访问慢，超时会把模型下拉卡住；
    # 我们的模型清单来自套餐，用不上它。
    "model_catalog": {"enabled": False},
    "cloud_sharing": {"enabled": True},
    "cloud_drive": {"enabled": True},
    "cloud_mail": {"enabled": True},
    "cloud_kits": {"enabled": True},
    "cloud_messaging_delivery": {"enabled": True},
    "platforms": {name: {"enabled": True} for name in ("uniagentgate", "dingtalk", "feishu", "weixin", "wecom")},
    # 用到时才从 PyPI 装的依赖：页面一打开就会往每台实例的可写层下 392MB 语音依赖。
    "security": {"allow_lazy_installs": False},
    # 用户第一条消息时，hermes 默认让 agent 提出「建用户画像」（征得同意后联网查用户的公开信息、记进记忆）。
    # 平台不主动打听用户：关掉，第一条消息只附一句简短自我介绍的提示。
    "onboarding": {"profile_build": "off"},
}


def parse_reasoning_defaults(text: str) -> dict[str, str]:
    """「模型=强度,模型=强度」→ {模型: 强度}；写错的项跳过。"""
    out: dict[str, str] = {}
    for item in (text or "").split(","):
        model, sep, effort = item.partition("=")
        if sep and model.strip() and effort.strip():
            out[model.strip()] = effort.strip()
    return out


def cube_allow_out(settings: Settings) -> list[str]:
    """建实例时额外放行的出网地址段。沙箱默认挡所有私网地址，企业平台在内网时实例连不上它的 /v1 和元景中转，
    所以平台地址是私网 IP 就自动放行这一个地址；再加上 MT_CUBE_ALLOW_OUT 里写的。"""
    out: list[str] = []
    host = (urlsplit(settings.uniwork_server).hostname or "") if settings.enterprise else ""
    try:
        address = ipaddress.ip_address(host) if host else None
    except ValueError:
        address = None  # 域名：沙箱放行公网，内网域名要自己写进 MT_CUBE_ALLOW_OUT
    if address is not None and address.version == 4 and address.is_private and not address.is_loopback:
        out.append(f"{address}/32")
    for item in settings.cube_allow_out.split(","):
        item = item.strip()
        if item and item not in out:
            out.append(item)
    return out


def _mtstate():
    """seed/mtstate.py 里 config.yaml 平台块的写法。入口的 Docker 路径复用同一份，不再维护第二套按行改的代码。"""
    import importlib.util
    mod = sys.modules.get("mt_seed_mtstate")
    if mod is None:
        spec = importlib.util.spec_from_file_location("mt_seed_mtstate", SEED_DIR / "mtstate.py")
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules["mt_seed_mtstate"] = mod
        spec.loader.exec_module(mod)
    return mod
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")


def tenant_slug(user_id: str) -> str:
    """把上游 uid 变成能当容器名/卷名的确定性 id。"""
    lowered = user_id.strip().lower()
    if _SAFE_ID.match(lowered):
        return lowered
    return "u" + hashlib.sha1(user_id.encode()).hexdigest()[:12]


@dataclass
class Tenant:
    """一个已经就绪、可以转发的租户实例。

    ``origin`` 和 ``host_header`` 是两种后端唯一的分歧点，也是转发层唯一需要知道的差异：

    - **Docker 后端**：直连容器 IP，Host 由我们伪造成回环形式，
      这样容器里的 hermes 认为请求来自本机、鉴权门关着。
    - **沙箱后端**：连平台代理，Host 用平台的路由格式；
      平台再按每个实例配置的模板把它改写成回环形式，效果一样。

    转发层照着这两个字段发就行，不需要知道背后是哪种后端。
    """

    # ★ 前四个字段的顺序不能动：有调用方是按位置构造的，
    #   把 token 和 ip 换个位置会让它们静默地互相顶替。新字段一律往后加。
    user_id: str
    slug: str
    ip: str                 # 仅 Docker 后端有值，沙箱后端传空串
    token: str
    origin: str = ""        # "host:port"，转发目标
    host_header: str = ""   # 发给上游的 Host 头
    sandbox_id: str = ""    # 仅沙箱后端有值
    traffic_token: str = ""  # 仅沙箱后端、且实例限制了公开访问时有值：数据面请求头要带


def volume_not_ready(exc: CubeError) -> bool:
    """转发器报「卷不可写 / 卷没挂上」：这台实例的卷挂载没好。换一台实例就好，等它没用。"""
    message = exc.message or ""
    return exc.status == 500 and "卷" in message and ("不可写" in message or "没有挂在" in message)


def busy_reason(activity: dict | None, now: float, keepalive_s: float) -> str:
    """转发器回报的忙不忙 → 这轮回收为什么不暂停它；空串 = 不忙。

    过点超过 ``keepalive_s`` 还没跑的任务不再算：hermes 的调度线程一分钟转一轮，
    这么久没动它说明不会跑了，不能让它把实例一直挂着。
    """
    if not isinstance(activity, dict):
        return ""
    if activity.get("cron_running"):
        return "cron_running"
    if activity.get("turns"):
        return "turn_running"
    if activity.get("kits_running"):
        return "kits_running"
    if activity.get("connectors_running"):
        return "connector_running"
    due = activity.get("cron_next_at")
    if isinstance(due, (int, float)) and now - keepalive_s <= due <= now + keepalive_s:
        return "cron_due"
    return ""


class CredentialSyncError(RuntimeError):
    """平台模型凭据未能同步到用户 Hermes 容器。"""


def _stamp_bytes(endpoint: tuple[str, str], models: list[str] | None = None) -> bytes:
    """记录「这个卷当前用的是哪个端点、哪些模型」，下次比对用。

    模型清单也算进来：套餐加了一个模型而端点没变时，同样要把它同步进 config.yaml。
    """
    return ("\n".join([endpoint[0], endpoint[1], "models=" + ",".join(models or []), ""])).encode("utf-8")


def _tar_bytes(files: dict[str, bytes], mode: int = 0o644) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for rel, content in files.items():
            info = tarfile.TarInfo(name=rel)
            info.size = len(content)
            info.mode = mode
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


class TenantManager:
    """两种执行后端共用的门面。

    ``settings.backend`` 决定走哪条路：``docker`` 是我们自己建容器，
    ``cube`` 是让沙箱平台建实例。两条路的差异全部收敛在 ``_*_docker`` /
    ``_*_cube`` 这几对方法里，对 app.py 和 proxy.py 完全透明。

    Docker 与沙箱均由实例转发器管理 Hermes 和连接器的进程生命周期。
    """

    # 唤醒正常时转发器几秒内就应答（11-09 真机 2 秒）；这么久一直是平台代理替它回 502/503/504，就是没起来。
    # 判错了也只是多一次从归档重建（约 20 秒），不丢东西，所以宁短勿长。
    RESUME_UNREACHABLE_S = 10.0

    def __init__(
        self,
        settings: Settings,
        docker: Docker | None,
        store: Store,
        http: aiohttp.ClientSession,
        cube: "Cube | None" = None,
    ):
        self.s = settings
        self.docker = docker
        self.cube = cube
        self.store = store
        self.http = http
        self._locks: dict[str, asyncio.Lock] = {}
        self._synced_key_digests: dict[str, bytes] = {}
        self._self_container = settings.self_container or socket.gethostname()
        # 定时任务叫醒：谁刚被叫醒（单调时间，回收时留出等调度线程的时间）、叫不醒的重试次数、
        # 上一轮因为什么没回收（原因变了才打日志，免得每分钟一行）。
        self._cron_woken: dict[str, float] = {}
        self._wake_failures: dict[tuple[str, datetime], int] = {}
        self._busy_seen: dict[str, str] = {}
        # 每个用户实例里的 hermes 是用哪把 key 起的（sha256），省得每个请求都查库；以库里的为准
        self._hermes_keys: dict[str, str] = {}
        self._reload_tried: dict[str, float] = {}

    @property
    def use_cube(self) -> bool:
        return self.s.backend == "cube"

    def _backend_client(self):
        """取当前后端的客户端，没接上就当场报错。

        ★ 检查放在用到的时候，不放在构造函数里：有调用方只为了用其中一两个
          与后端无关的方法（比如凭据同步）而构造它，此时另一个客户端本来就该是空的。
        """
        client = self.cube if self.use_cube else self.docker
        if client is None:
            raise RuntimeError(f"MT_BACKEND={self.s.backend} 但对应的客户端没有接上")
        return client

    # ---- naming ------------------------------------------------------------------
    def container_name(self, slug: str) -> str:
        return f"{self.s.prefix}-t-{slug}"

    def network_name(self, slug: str) -> str:
        return f"{self.s.prefix}-net-{slug}"

    def volume_name(self, slug: str) -> str:
        return f"{self.s.prefix}-data-{slug}"

    def _lock(self, slug: str) -> asyncio.Lock:
        lock = self._locks.get(slug)
        if lock is None:
            lock = self._locks[slug] = asyncio.Lock()
        return lock

    @contextlib.asynccontextmanager
    async def _queued(self, slug: str, abandoned: Callable[[], bool] | None):
        """排队拿这个用户的锁；发请求的浏览器在排队时断开了就不再等（``RequestAbandoned``）。

        11-06 真机：实例起不来时每个请求在锁里等满 180 秒，页面一次发的几十个请求排了 3 个多小时，
        浏览器早走了，新请求还排在它们后面。只在排队时放弃，拿到锁以后照常做完：建实例做到一半不能停。
        等待的那一个不撤下来重排：asyncio.Lock 先来先得，撤了就排到队尾去了。
        """
        lock = self._lock(slug)
        if abandoned is None:
            async with lock:
                yield
            return
        waiter = asyncio.ensure_future(lock.acquire())
        try:
            while not (await asyncio.wait({waiter}, timeout=1.0))[0]:
                if abandoned():
                    raise RequestAbandoned()
        except BaseException:
            waiter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                if await waiter:  # 撤的同时正好轮到：锁已经拿到了，还回去
                    lock.release()
            raise
        try:
            yield
        finally:
            lock.release()

    def _pg_lock(self, user_id: str):
        """跨入口副本的互斥（PG 咨询锁）。只包住会变更实例的那一段；关掉时只剩进程内的锁。"""
        if self.s.pg_lock:
            return self.store.advisory_lock(user_id)
        return contextlib.nullcontext()

    def _register_token(self, rt) -> None:
        """PG 里记着的流量令牌登记到 Cube 客户端，之后对这台实例的数据面请求自动带上。"""
        if self.cube is not None and rt.sandbox_id and rt.traffic_token:
            self.cube.register_traffic_token(rt.sandbox_id, rt.traffic_token)

    # ---- seed files ------------------------------------------------------------
    def _model_limits(self, names: list[str], limits: dict[str, int] | None) -> dict[str, int]:
        """每个模型的上下文长度：套餐给的优先，没给的按 MT_DEFAULT_CONTEXT_WINDOW；兜底值设成 0 就不写。"""
        limits = limits or {}
        out: dict[str, int] = {}
        for name in names:
            value = limits.get(name) or self.s.default_context_window
            if value > 0:
                out[name] = value
        return out

    def _models_block(
        self,
        catalog: list[tuple[str, str]],
        fallback: str,
        limits: dict[str, int] | None = None,
        vision: dict[str, bool] | None = None,
    ) -> str:
        """渲染 providers.<key>.models 映射。空清单时至少放主模型，别产出空 mapping。

        ``vision`` 写成 supports_vision：不能看图也要写明 false，不写时 hermes 选看图模型会把它当成能看，
        切到文字模型后拿它"描述"历史图片（桌面 release 94af1c0124 同一个问题）。"""
        names = [n for n, _ in catalog] or [fallback]
        known = self._model_limits(names, limits)
        vision = vision or {}

        def options(name: str) -> str:
            parts = [f"context_length: {known[name]}"] if name in known else []
            if name in vision:
                parts.append(f"supports_vision: {'true' if vision[name] else 'false'}")
            return "{" + ", ".join(parts) + "}"

        return "\n".join(f"      {n}: {options(n)}" for n in names)

    def _reasoning_block(self) -> str:
        defaults = parse_reasoning_defaults(self.s.reasoning_defaults)
        if not defaults:
            return ""
        return "agent:\n  reasoning_overrides:\n" + "\n".join(f"    {m}: {e}" for m, e in defaults.items())

    def _render_user_files(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
        limits: dict[str, int] | None = None,
        vision: dict[str, bool] | None = None,
    ) -> dict[str, bytes]:
        """只渲染「属于这个用户」的三份文件：``config.yaml``、``.env`` 和默认人设 ``SOUL.md``。

        与 ``_render_seed`` 分开，是因为两种后端要的东西不一样：
        Docker 后端还要把转发器一并塞进卷，沙箱后端不要 —— 转发器已经烘进镜像了。
        混在一起会让沙箱路径凭空依赖 seed 目录里的一个它根本用不到的文件。

        endpoint = my-plan 给这个用户的 (base_url, model)；没有就退回环境变量里的默认值。

        ★ 优先用 my-plan 的值：套餐 key 只在它自己的 TokenPlan 专用路径上有效，
        用手写的通用网关地址会被回 1004「请使用 TokenPlan 专用路径」。
        """
        base_url, model_name = endpoint or ("", "")
        base_url = base_url or self.s.model_base_url
        model_name = model_name or self.s.model_name
        files: dict[str, bytes] = {}
        config_tmpl = (SEED_DIR / "config.yaml.tmpl").read_text(encoding="utf-8")
        if self.s.enterprise:
            config_tmpl = _PERSONAL_TEMPLATE_BLOCK.sub("", config_tmpl)
        config = (
            config_tmpl.replace("{{MODEL_NAME}}", model_name)
            .replace("{{MODEL_BASE_URL}}", base_url)
            .replace("{{PROVIDER_KEY}}", self.s.provider_key)
            .replace("{{KEY_ENV_NAME}}", self.s.key_env_name)
            .replace("{{FILES_ROOT}}", self.s.files_root)
            .replace("{{MODELS_BLOCK}}", self._models_block(catalog or [], model_name, limits, vision))
            .replace("{{REASONING_BLOCK}}", self._reasoning_block())
        )
        files["config.yaml"] = config.encode("utf-8")
        env_lines = [f"TERMINAL_ENV=local"]
        if api_key:
            env_lines.append(f"{self.s.key_env_name}={api_key}")
            if not self.s.enterprise:
                env_lines.append(f"{DESKTOP_MAAS_KEY_ENV}={api_key}")
        files[".env"] = ("\n".join(env_lines) + "\n").encode("utf-8")
        files["SOUL.md"] = DEFAULT_SOUL_FILE.read_bytes()
        return files

    def _render_seed(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
        limits: dict[str, int] | None = None,
        vision: dict[str, bool] | None = None,
    ) -> dict[str, bytes]:
        """Docker 后端要塞进卷的全部文件：用户那两份，外加转发器。

        沙箱后端不走这里 —— 它的转发器在镜像里，见 ``_cube_seed_files``。
        """
        files = self._render_user_files(api_key, endpoint, catalog, limits, vision)
        # 转发器要从自己所在目录导入状态管家和用户接口，三个文件一起放。
        for name in ("forward.py", "mtstate.py", "mtuser.py", "mtent.py", "mtexport.py", "mtfolders.py", "mtmessaging.py", "mtconnectors.py", "mtconnector_profile.py", "mtconnector_state.py"):
            files[f".mt/{name}"] = (SEED_DIR / name).read_bytes()
        for file in sorted((SEED_DIR.parent / '.connector-runtime').rglob('*')):
            if file.is_file():
                files['.mt/connectors/' + file.relative_to(SEED_DIR.parent / '.connector-runtime').as_posix()] = file.read_bytes()
        bundled = SEED_DIR.parent / '.kits-runtime/plugins/uniwork-kits/bundled'
        for file in sorted(bundled.rglob('*')):
            if file.is_file():
                files['.mt/bundled/' + file.relative_to(bundled).as_posix()] = file.read_bytes()
        return files

    # ---- 平台下发的模型配置：变了要同步到已有的卷 ------------------------------------
    @staticmethod
    def _from_tar(blob: bytes, name: str) -> bytes | None:
        with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
            for m in tar.getmembers():
                if m.isfile() and m.name.rsplit("/", 1)[-1] == name:
                    f = tar.extractfile(m)
                    return f.read() if f else None
        return None

    async def _sync_endpoint(
        self,
        cname: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None = None,
        limits: dict[str, int] | None = None,
        vision: dict[str, bool] | None = None,
    ) -> bool:
        """套餐给的端点变了就改写这个卷里的 config.yaml。返回 True 表示改过（需要重启容器）。

        ★ 为什么必须有这一步：模型端点是**平台下发**的，会变（换套餐、网关迁移、
        或者像 09-20 这样发现之前写的是错的通用路径）。只在首次建卷时写，已有用户
        就永远卡在旧地址上，症状是网关回 1004 而不是任何看得懂的错误。
        """
        base_url, model_name = endpoint or ("", "")
        names = [n for n, _ in (catalog or [])]
        try:
            cfg_tar = await self.docker.get_archive(cname, "/opt/data/config.yaml")
            if not cfg_tar:
                return False
            spec = self._config_patch_spec(endpoint, catalog, limits, vision=vision)
            want = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest().encode()
            stamp_tar = await self.docker.get_archive(cname, "/opt/data/.mt/endpoint.stamp")
            if stamp_tar and self._from_tar(stamp_tar, "endpoint.stamp") == want:
                return False
            raw = self._from_tar(cfg_tar, "config.yaml")
            if raw is None:
                return False
            patched, notes = _mtstate().patch_config_text(
                raw.decode("utf-8"), spec)
            files = {".mt/endpoint.stamp": want}
            if notes:
                files["config.yaml"] = patched.encode("utf-8")
                log.info(
                    "tenant %s: 套餐配置变了，已更新 config.yaml -> %s / %s / models=%s",
                    cname, base_url, model_name, ",".join(names) or "(仅主模型)",
                )
            await self.docker.put_archive(cname, "/opt/data", _tar_bytes(files))
            return "config.yaml" in files
        except DockerError as exc:
            log.warning("tenant %s: 同步套餐端点失败: %s", cname, exc)
            return False

    # ---- lifecycle -----------------------------------------------------------------
    async def ensure_running(self, user_id: str, *, touch: bool = True,
                             abandoned: Callable[[], bool] | None = None) -> Tenant:
        """保证这个用户有一个能用的实例，返回可直接转发的 ``Tenant``。

        ``touch=False`` 只给定时任务叫醒用：实例起来了但不算用户活动，跑完照常按空闲规则回收。
        ``abandoned`` 由带着浏览器请求的调用方给：排队等锁时它说「人走了」就抛 ``RequestAbandoned``。
        """
        self._backend_client()
        if self.use_cube:
            tenant = await self._ensure_running_cube(user_id, touch=touch, abandoned=abandoned)
        else:
            tenant = await self._ensure_running_docker(user_id, abandoned=abandoned)
        assert tenant is not None
        return tenant

    async def running_tenant(self, user_id: str) -> Tenant | None:
        """实例正在跑就返回它；停着的不叫醒，返回 None。给只在实例跑着时才有事做的后台轮询用。

        状态在拿到锁以后才看：轮询看到「在跑」到真去用之间，空闲回收可能刚把它暂停了。以前这里直接
        ``ensure_running``，回收一放锁就把刚暂停的实例叫醒，又不算活动，80 多秒后再被回收——绑了消息
        平台的用户一天被暂停、唤醒上千次，每次还全量归档（11-04～11-05 真机）。
        """
        self._backend_client()
        if self.use_cube:
            return await self._ensure_running_cube(user_id, touch=False, wake=False)
        return await self._ensure_running_docker(user_id, wake=False)

    async def _ensure_running_docker(
        self,
        user_id: str,
        *,
        wake: bool = True,
        abandoned: Callable[[], bool] | None = None,
    ) -> Tenant | None:
        slug = tenant_slug(user_id)
        async with self._queued(slug, abandoned):
            if not wake and (await self.store.get_runtime(user_id)).state != "running":
                return None
            token = await self.store.ensure_tenant_token(user_id)
            context = await self.store.get_tenant_context(user_id)
            api_key = context.api_key
            endpoint = context.endpoint
            catalog = context.catalog
            cname, nname, vname = self.container_name(slug), self.network_name(slug), self.volume_name(slug)
            labels = {"hermes.mt": "tenant", "hermes.mt.user": user_id, "hermes.mt.slug": slug}

            await self.docker.ensure_network(nname, labels)
            await self.docker.connect_network(nname, self._self_container)
            fresh_volume = await self.docker.ensure_volume(vname, labels)

            info = await self.docker.inspect_container(cname)
            if info is not None:
                # 镜像换了就重建（卷不动）
                if info.get("Config", {}).get("Image") != self.s.image:
                    log.info("tenant %s: image changed, recreating container", slug)
                    await self.docker.remove_container(cname)
                    info = None
            if info is None:
                await self._create(cname, nname, vname, labels, token,
                                   api_server=bool(getattr(context, "service", False)))
                seed = self._render_seed(api_key, endpoint, catalog, getattr(context, "limits", None),
                                         getattr(context, "vision", None))
                if persona := self._persona_of(context):
                    seed["SOUL.md"] = persona.encode("utf-8")
                if not fresh_volume:
                    # 卷已有数据：只刷新转发器，不碰用户的 .env / config.yaml
                    seed = {k: v for k, v in seed.items() if k.startswith(".mt/")}
                if endpoint and endpoint[0]:
                    seed[".mt/endpoint.stamp"] = _stamp_bytes(endpoint, [n for n, _ in (catalog or [])])
                await self.docker.put_archive(cname, "/opt/data", _tar_bytes(seed))
                info = await self.docker.inspect_container(cname)

            # 平台下发的端点若有变化，先改卷里的 config.yaml（hermes 只在启动时读一次）
            changed = await self._sync_endpoint(cname, endpoint, catalog, getattr(context, "limits", None),
                                                getattr(context, "vision", None))
            tracing_changed = await self._sync_langfuse(cname, user_id)
            changed = changed or tracing_changed
            if changed and (info or {}).get("State", {}).get("Running"):
                log.info("tenant %s: 端点已更新，重启容器让 hermes 重新读配置", slug)
                await self.docker.stop_container(cname)
                info = await self.docker.inspect_container(cname)

            state = (info or {}).get("State", {})
            needs_start = not state.get("Running")
            if needs_start:
                await self.store.set_tenant_state(user_id, "starting")
            try:
                if needs_start:
                    await self.store.write_audit(user_id, "tenant.start", {"container": cname})
                    await self.docker.start_container(cname)

                ip = await self.docker.container_ip(cname, nname)
                if not ip:
                    raise RuntimeError(f"容器 {cname} 没有拿到 {nname} 网络的 IP")
                await self._wait_ready(ip)
            except Exception:  # noqa: BLE001
                try:
                    await self.store.set_tenant_state(user_id, "stopped")
                except Exception as state_exc:  # noqa: BLE001
                    log.warning(
                        "tenant %s: 启动失败后回写 stopped 失败: %s",
                        cname,
                        type(state_exc).__name__,
                    )
                raise
            tenant = Tenant(
                user_id=user_id,
                slug=slug,
                token=token,
                ip=ip,
                origin=f"{ip}:{self.s.forward_port}",
                host_header=f"127.0.0.1:{self.s.hermes_port}",
            )
            await self.store.set_tenant_state(user_id, "running")
            await self.store.touch_tenant(user_id)
            await self._sync_api_key(tenant, api_key)
            return tenant

    # ---- 沙箱后端 ---------------------------------------------------------------

    def cube_volume_name(self, user_id: str) -> str:
        """用户的持久卷名。平台的 volumeID 与 name 相同，所以这就是卷 ID。

        ★ 不能复用 ``tenant_slug``：它做了小写归一化，是**多对一**的 ——
          ``Alice`` 和 ``alice`` 会算出同一个名字，等于两个用户共用一份数据。
          容器名多对一只是撞名，卷名多对一是数据串台，性质完全不同。
          这里一律走摘要，保证单射。
        """
        digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32]
        return f"{self.s.prefix}-u-{digest}"

    def _platform_policy(self) -> dict:
        """平台策略，加上默认推理强度（MT_DEFAULT_REASONING_EFFORT，空就不写）。
        转发器按「段 → 键」逐项写，用户在同一段里的其他设置不动（seed/mtstate.py 的 _apply_policy）。"""
        policy = PLATFORM_POLICY
        if self.s.enterprise:
            policy = {key: value for key, value in policy.items() if key not in PERSONAL_POLICY_KEYS}
        effort = self.s.default_reasoning_effort
        if not effort:
            return policy
        return {**policy, "agent": {"reasoning_effort": effort}}

    @staticmethod
    def _drive_mcp() -> dict:
        return {"Agent-Mail": {"url": "http://127.0.0.1:9120/api/plugins/cloud-mail/mcp", "timeout": 120, "enabled": False,
                 "uniwork_managed": "uniwork.cloud.mail.v1",
                 "headers": {"X-Hermes-Session-Token": "${HERMES_DASHBOARD_SESSION_TOKEN}"}},
                "UniWork-Drive": {"url": "http://127.0.0.1:9120/api/plugins/cloud-drive/mcp", "timeout": 720,
                 "execution_metadata": True, "strict_redirect_headers": True, "uniwork_managed": "uniwork.desktop.drive.v1",
                 "headers": {"X-Hermes-Session-Token": "${HERMES_DASHBOARD_SESSION_TOKEN}"}}}

    def _mcp_servers(self, api_key: str) -> dict:
        """平台内置的 MCP 服务，{名字: 配置}；配置为 None = 平台不提供，实例里有这一条就删掉。

        key 不写明文：地址里写 ``${<key 的变量名>}``，hermes 连接时从 .env 取 —— 就是 .env 里模型用的那把
        套餐 key，换 key 只动 .env。没有 key 的用户（没套餐）不给这一条：连上去只会 401。
        ``oss_mode`` 让工具给内网链接（用户的浏览器在内网），见 config.py。

        企业模式下 key 是设备令牌，地址换成平台的元景中转：平台验过成员身份和额度，换上企业的 key 再转给元景，
        用量记在企业账上。其余参数照旧。
        """
        url = self.s.yuanjing_mcp_url.strip()
        drive = {} if self.s.enterprise else self._drive_mcp()
        if not url or not api_key:
            return {**drive, YUANJING_MCP_NAME: None}
        if self.s.enterprise:
            url = f"{self.s.uniwork_server}/api/client/yj/app/mcp-server/mcp"
        params = [f"key=${{{self.s.key_env_name}}}"]
        if self.s.yuanjing_mcp_client_id:
            params.append("client_id=" + quote(self.s.yuanjing_mcp_client_id, safe=""))
        if self.s.yuanjing_mcp_oss_mode:
            params.append("oss_mode=" + quote(self.s.yuanjing_mcp_oss_mode, safe=""))
        sep = "&" if "?" in url else "?"
        return {**drive, YUANJING_MCP_NAME: {"url": url + sep + "&".join(params), "timeout": YUANJING_MCP_TIMEOUT_S}}

    def _config_patch_spec(
        self,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None,
        limits: dict[str, int] | None = None,
        api_key: str | None = None,
        vision: dict[str, bool] | None = None,
    ) -> dict:
        """patch-model 的内容：平台块四项 + 套餐清单 + 每个模型的上下文长度 + 平台策略 + 推理强度预设，
        外加一份渲染好的模板（文件坏到救不回来时按它重建）。见 seed/mtstate.py 的 apply_platform_block。

        给了 ``api_key``（沙箱路径的引导）才带内置 MCP；Docker 路径只维护实例本地云盘 MCP，不改元景 MCP。"""
        base_url, model_name = endpoint or ("", "")
        model = model_name or self.s.model_name
        names = [n for n, _ in (catalog or [])]
        spec = {
            "base_url": base_url or self.s.model_base_url,
            "model": model,
            "provider_key": self.s.provider_key,
            "key_env": self.s.key_env_name,
            "models": names,
            "limits": self._model_limits(names or [model], limits),
            "policy": self._platform_policy(),
            "reasoning_defaults": parse_reasoning_defaults(self.s.reasoning_defaults),
            "template": self._render_user_files("", endpoint, catalog, limits, vision)["config.yaml"].decode("utf-8"),
        }
        if vision:
            # 套餐写明了能不能看图的模型：转发器写成 supports_vision（seed/mtstate.py 的 _model_entry）
            spec["vision"] = {n: v for n, v in vision.items() if n in (names or [model])}
        if api_key is not None:
            spec["mcp_servers"] = self._mcp_servers(api_key)
        elif not self.s.enterprise:
            spec["mcp_servers"] = self._drive_mcp()
        if self.s.enterprise:
            # 企业对接插件：hermes 只加载 plugins.enabled 里有的。引导时在拉起 hermes 之前写，默认 profile 一启动就有；
            # Agent 的托管 profile 用这份当模板，也带上。停用靠实例里的 plugin.json（MT_UNIWORK_PLUGIN），这里照写。
            spec["plugins"] = {"enable": [UNIWORK_PLUGIN_KEY]}
        elif upload_url(self.s):
            spec["enabled_plugins"] = ["observability/langfuse"]
        return spec

    def _cube_seed_files(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None,
        limits: dict[str, int] | None = None,
        persona: str | None = None,
        tracing_lines: list[str] | None = None,
        settings: dict | None = None,
        vision: dict[str, bool] | None = None,
    ) -> list[dict]:
        """渲染引导接口要的种子文件。

        ``persona`` 只有平台的运行环境才给（平台策略的 agentProfile）：人设归平台管，每次都覆盖。
        ``settings`` 是入口库里记的用户设置（技能开关 skills、套件开关 kits），只有引导才给：恢复回来的
        归档可能比库旧，靠 patch-model 那条按库里的写回（老转发器不认识这些键，会原样忽略）。
        重新加载不用给，实例里已经是最新的。

        与 Docker 那边 ``_render_seed`` 的两点差异：

        1. **不含转发器**。它已经烘进镜像了，不再放在用户可写的数据目录里 ——
           放那儿意味着租户能替换掉自己的转发器。
        2. **``config.yaml`` 用 ``if-pristine``**。沙箱路径下镜像的首启引导比我们的
           引导先跑，会先种一份默认示例；直接 ``overwrite=False`` 会让我们的配置
           永远写不进去，直接 ``True`` 又会毁掉老用户自己改过的内容。
           ``if-pristine`` 的判据是与镜像里的示例逐字节比对，见 seed/forward.py。
        """
        rendered = self._render_user_files(api_key, endpoint, catalog, limits, vision)
        if tracing_lines:
            rendered[".env"] += ("\n".join(tracing_lines) + "\n").encode("utf-8")
        patch = self._config_patch_spec(endpoint, catalog, limits, api_key=api_key or "", vision=vision)
        for key in ("kits", "skills"):
            if (settings or {}).get(key):
                patch[key] = settings[key]
        return [
            {
                "path": "config.yaml",
                "content": rendered["config.yaml"].decode("utf-8"),
                "overwrite": "if-pristine",
            },
            {
                # 老用户恢复回来的 config.yaml 不是 pristine，上面那条写不进去；
                # 平台下发的端点和模型清单靠这条逐行改写，其余保持用户自己的。
                "path": "config.yaml",
                "content": json.dumps(patch, ensure_ascii=False),
                "overwrite": "patch-model",
            },
            {
                # 只改我们负责的两行；用户在界面里存的别的 key 不能被抹掉。
                "path": ".env",
                "content": rendered[".env"].decode("utf-8"),
                "overwrite": "upsert-lines",
            },
            {
                "path": "SOUL.md",
                "content": persona,
                "overwrite": True,
            } if persona else {
                # 默认人设：盘上那份还是镜像首启种的 hermes 默认人设才换成平台的；
                # 用户在「管理配置档案」里改过的不动（同样按镜像里的示例逐字节比对）。
                "path": "SOUL.md",
                "content": rendered["SOUL.md"].decode("utf-8"),
                "overwrite": "if-pristine",
            },
        ]

    @staticmethod
    def _persona_of(context) -> str | None:
        """平台的运行环境才有平台下发的人设；成员的人设归他自己。"""
        return (getattr(context, "persona", "") or None) if getattr(context, "service", False) else None

    def _template_id(self) -> str:
        """配置里的模板值只在它是 ID（tpl-…）时参与「模板不一致就重建」的比对；别名比不了。"""
        value = self.s.cube_template.strip()
        return value if value.startswith("tpl-") else ""

    async def _ensure_running_cube(self, user_id: str, touch: bool = True, *, wake: bool = True,
                                   abandoned: Callable[[], bool] | None = None) -> Tenant | None:
        assert self.cube is not None
        slug = tenant_slug(user_id)
        port = self.s.forward_port
        async with self._queued(slug, abandoned):
            if not wake and (await self.store.get_runtime(user_id)).state != "running":
                return None
            token = await self.store.ensure_tenant_token(user_id)
            context = await self.store.get_tenant_context(user_id)
            volume = self.cube_volume_name(user_id)

            # 卷先于实例存在，而且不随实例销毁。建过了就是幂等的一次查询。
            await self.cube.ensure_volume(volume, self.s.cube_volume_driver)

            # 快路径（不拿跨副本的锁）：实例在、模板对、引导过 ⇒ 只等 hermes 就绪。
            rt = await self.store.get_runtime(user_id)
            self._register_token(rt)
            sandbox_id = rt.sandbox_id
            sb = await self.cube.get_sandbox(sandbox_id) if sandbox_id else None
            was_paused = sb is not None and str(sb.get("state")) != "running"

            # 与 Docker 那条路同一条不变式：中途失败不能把状态留在 starting，
            # 否则这个用户会一直被当成"正在启动"，既不会被回收也不会被重试。
            try:
                if self._needs_change(rt, sb):
                    # 慢路径：要动实例了。先拿跨副本的锁，再重读一遍 ——
                    # 另一个副本可能刚处理过同一件事，不能按刚才看到的旧状态动手。
                    async with self._pg_lock(user_id):
                        rt = await self.store.get_runtime(user_id)
                        self._register_token(rt)
                        sb = await self.cube.get_sandbox(rt.sandbox_id) if rt.sandbox_id else None
                        was_paused = sb is not None and str(sb.get("state")) != "running"
                        sandbox_id = await self._settle_cube(user_id, slug, rt, sb, token, context)
                        if not sandbox_id:
                            sandbox_id = await self._create_cube(user_id, slug, volume, token, context)
                            was_paused = False

                # 实例可能是 paused —— 这个请求会把它自动唤醒，等就绪即可。
                # 唤醒后转发器起不来（11-09 真机：切回个人版每次白等满 180 秒才重建）：上次是先归档再暂停的，
                # 重建不丢东西，转发器连续 RESUME_UNREACHABLE_S 秒不应答就交给下面的 _discard_unresponsive。
                silent_limit = (self.RESUME_UNREACHABLE_S
                                if was_paused and await self.store.paused_after_archive(user_id) else None)
                try:
                    await self.cube.wait_hermes(sandbox_id, port, timeout_s=self.s.ready_timeout_s,
                                                unreachable_limit_s=silent_limit)
                except SandboxGone:
                    # 等就绪期间控制面确认实例没了（节点丢失、被手工删）。10-08 真机：删除是异步的，
                    # 刚删完控制面还说"在"，旧版等满 180 秒就绪超时才发现。现在当场重建，同一个请求里完成。
                    log.warning("tenant %s: 实例 %s 在等就绪时消失，立即重建", slug, sandbox_id[:12])
                    async with self._pg_lock(user_id):
                        rt = await self.store.get_runtime(user_id)
                        sb = await self.cube.get_sandbox(rt.sandbox_id) if rt.sandbox_id else None
                        sandbox_id = await self._settle_cube(user_id, slug, rt, sb, token, context)
                        if not sandbox_id:
                            sandbox_id = await self._create_cube(user_id, slug, volume, token, context)
                    was_paused = False
                    await self.cube.wait_hermes(sandbox_id, port, timeout_s=self.s.ready_timeout_s)
                except CubeError:
                    # 等不到 hermes：没引导过就补一次，窗口已关就删了重建；引导过的照常报错，
                    # 除非它是暂停后唤醒没起来的那种（见 _discard_unresponsive），那就从归档重建。
                    replaced = False
                    async with self._pg_lock(user_id):
                        sandbox_id, repaired = await self._repair_bootstrap(user_id, slug, sandbox_id, token, context)
                        if not repaired and await self._discard_unresponsive(user_id, slug, sandbox_id):
                            sandbox_id = await self._create_cube(user_id, slug, volume, token, context)
                            replaced = True
                    if replaced:
                        was_paused = False
                        await self.cube.wait_hermes(sandbox_id, port, timeout_s=self.s.ready_timeout_s)
                    elif not repaired:
                        raise
            except Exception:  # noqa: BLE001
                try:
                    await self.store.set_tenant_state(user_id, "stopped")
                except Exception as state_exc:  # noqa: BLE001
                    log.warning(
                        "tenant %s: 启动失败后回写 stopped 失败: %s",
                        slug,
                        type(state_exc).__name__,
                    )
                raise

            if was_paused:
                # 暂停的实例被这个请求唤醒了。平台不通知，只有这里能记一笔。
                await self.store.write_audit(user_id, "tenant.resume", {"sandbox": sandbox_id})

            tenant = Tenant(
                user_id=user_id,
                slug=slug,
                ip="",  # 沙箱后端不直连实例 IP，走平台代理
                token=token,
                sandbox_id=sandbox_id,
                origin=self.cube.proxy_base.split("://", 1)[-1],
                host_header=self.cube.host_for(sandbox_id, port),
                traffic_token=self.cube.traffic_token(sandbox_id),
            )
            await self.store.set_tenant_state(user_id, "running")
            await self.store.mark_served(user_id)
            if touch:
                await self.store.touch_tenant(user_id)
            await self._reload_if_key_changed(user_id, slug, sandbox_id, token, context)
            await self._sync_api_key(tenant, context.api_key)
            return tenant

    def _needs_change(self, rt, sb: dict | None) -> bool:
        """这次请求要不要动实例（没实例 / 实例没了 / 模板变了 / 引导没完成）。"""
        if not rt.sandbox_id or sb is None or str(sb.get("state")) in GONE_STATES:
            return True
        if rt.lifecycle in {"draining", "drained", "deleting"}:
            return True
        want = self._template_id()
        have = str(sb.get("templateID") or rt.template_id or "")
        if want and have and have != want:
            return True
        return rt.state_owner != rt.sandbox_id

    async def _settle_cube(self, user_id: str, slug: str, rt, sb: dict | None, token: str, context) -> str:
        """在跨副本的锁里处理「实例没了 / 模板变了 / 引导没完成」，返回还能用的 sandbox_id，空串 = 要新建。"""
        assert self.cube is not None
        sandbox_id = rt.sandbox_id
        if not sandbox_id:
            return ""
        if sb is not None and str(sb.get("state")) in GONE_STATES:
            # 平台正在删它（异步删除的收尾）：等它真没了再按"没了"处理，免得新实例和它抢卷。
            log.info("tenant %s: 实例 %s 正在被平台删除（%s），等它消失", slug, sandbox_id[:12], sb.get("state"))
            if not await self.cube.wait_gone(sandbox_id):
                raise CubeError(503, "旧实例尚未删除完成，请稍后重试")
            sb = None
        if sb is None:
            # 平台侧已经没了（节点维护、被手工删掉…）。数据在卷上，重建即可。
            log.info("tenant %s: 实例 %s 已不存在，重建", slug, sandbox_id[:12])
            await self.store.mark_sandbox_deleted(sandbox_id, "gone")
            await self.store.set_sandbox_id(user_id, None)
            self.cube.forget_traffic_token(sandbox_id)
            return ""
        if rt.lifecycle in {"draining", "drained", "deleting"}:
            if rt.state_owner != sandbox_id and str(sb.get("state")) == "running":
                st = await self.cube.status(sandbox_id, self.s.forward_port)
                # A failed first bootstrap has no state manager to resume. A
                # leftover drain marker must not prevent normal bootstrap repair.
                if st.get("bootstrapped") is False and st.get("state") is None and not st.get("draining"):
                    repaired_id, repaired = await self._repair_bootstrap(user_id, slug, sandbox_id, token, context)
                    if not repaired_id or repaired:
                        await self.store.set_lifecycle(user_id, "")
                        return repaired_id
            try:
                await self._resume_after_drain(user_id, sandbox_id, token)
            except CubeError:
                # 上一次排空失败、恢复也失败留下的标记（转发器不应答，11-06 真机）：每个请求都走到这里、
                # 都失败。能放心从归档重建就换掉，空串让调用方新建；不能就照常报错。
                if not await self._discard_unresponsive(user_id, slug, sandbox_id):
                    raise
                await self.store.set_lifecycle(user_id, "")
                return ""
            return sandbox_id
        want = self._template_id()
        have = str(sb.get("templateID") or rt.template_id or "")
        if want and have and have != want:
            # 模板换了（升级镜像）：先排空再删，再由调用方新建；排空失败就这次不升级。
            if await self._drain_and_delete(user_id, sandbox_id, token, f"template {have[:12]} -> {want[:12]}"):
                return ""
            log.warning("tenant %s: 排空失败，本次不升级，继续用旧实例", slug)
            return sandbox_id
        if rt.state_owner != sandbox_id:
            # 实例建了、ID 也落库了，但引导从没完成（上次种子文件出错、超时…）。
            # 不能每个请求都重新引导（多两次往返，还重发 key），只在这种情况下问一句转发器。
            sandbox_id, _ = await self._repair_bootstrap(user_id, slug, sandbox_id, token, context)
        return sandbox_id

    def _state_block(self, sandbox_id: str, epoch: int, restore_from: str) -> dict:
        return {
            "vol": self.s.cube_volume_mount,
            "owner": sandbox_id,
            "epoch": epoch,
            "restore_from": restore_from,
            "force": self.s.state_force,
            "archive_interval_s": self.s.archive_interval_s,
        }

    async def _create_cube(self, user_id: str, slug: str, volume: str, token: str, context) -> str:
        """建一台实例并引导：先落库，再让状态管家从上一代恢复，再拉 hermes。返回 sandbox_id。

        引导时转发器报「卷不可写」= 这台实例挂到了还没卸干净的旧挂载点，等多久都没用：
        删掉它、歇一下、再建一台，最多换一次。
        """
        assert self.cube is not None
        port = self.s.forward_port
        rt = await self.store.get_runtime(user_id)
        await self.store.set_tenant_state(user_id, "starting")
        allow_out = cube_allow_out(self.s)
        for attempt in (1, 2):
            epoch = await self.store.next_epoch(user_id)
            sandbox_id = await self.cube.create_sandbox(
                volume_name=volume,
                workspace_path=self.s.cube_volume_mount,
                metadata={"hermes.mt": "tenant", "hermes.mt.slug": slug},
                private_traffic=self.s.cube_private_traffic,
                **({"allow_out": allow_out} if allow_out else {}),
            )
            # ★ 先落库再引导：引导可能超时，但实例已经真实存在了。
            #   不先记下来的话，下一次请求会再建一个，旧的成为没人管的孤儿。
            #   流量令牌一起落库：平台只在创建时给一次，入口重启后只能从 PG 拿回来。
            await self.store.record_sandbox(user_id, sandbox_id, self._template_id(), epoch,
                                            traffic_token=self.cube.traffic_token(sandbox_id))
            await self.store.write_audit(
                user_id, "tenant.start",
                {"sandbox": sandbox_id, "epoch": epoch, "restore_from": rt.state_owner},
            )
            await self.cube.wait_forwarder(sandbox_id, port)
            try:
                await self._bootstrap_cube(user_id, slug, sandbox_id, token, context, epoch, rt.state_owner)
                return sandbox_id
            except CubeError as exc:
                if attempt == 2 or not volume_not_ready(exc):
                    raise
                log.warning("tenant %s: 实例 %s 的卷没挂好（%s），删掉换一台", slug, sandbox_id[:12], exc.message[:80])
                await self._discard_unbootstrapped(user_id, sandbox_id, "volume_not_ready")
        raise AssertionError("unreachable")

    async def _discard_unbootstrapped(self, user_id: str, sandbox_id: str, reason: str) -> None:
        """引导没成的实例：删掉、记进历史、清掉绑定，再给节点一点卸载卷的时间。"""
        assert self.cube is not None
        try:
            await self.cube.remove_sandbox(sandbox_id)
            await self.cube.wait_gone(sandbox_id)
        except CubeError as exc:
            log.warning("删引导失败的实例 %s 失败: %s", sandbox_id[:12], exc)
        await self.store.mark_sandbox_deleted(sandbox_id, reason)
        await self.store.set_sandbox_id(user_id, None)
        if self.s.volume_detach_grace_s > 0:
            await asyncio.sleep(self.s.volume_detach_grace_s)

    async def _connector_states(self, user_id: str) -> list[dict]:
        """入口库里各配置档的连接器状态，引导时送回实例（见 seed/mtconnector_state.py）。

        引导请求整个不能超过转发器的 4 MB：默认配置档排最前，装不下的配置档不送，
        实例就沿用归档里那份。"""
        if self.s.enterprise:
            return []
        states = sorted(await self.store.connector_states(user_id), key=lambda item: item["profile"] != "default")
        kept, size = [], 0
        for item in states:
            size += len(json.dumps(item))
            if size > 3 * 1024 * 1024:
                log.warning("tenant %s: 连接器状态太大，%d 个配置档改用归档里的", tenant_slug(user_id), len(states) - len(kept))
                break
            kept.append(item)
        return kept

    async def _bootstrap_cube(self, user_id: str, slug: str, sandbox_id: str, token: str, context,
                              epoch: int, restore_from: str) -> None:
        assert self.cube is not None
        body = await self.cube.bootstrap(
            sandbox_id,
            self.s.forward_port,
            token=token,
            files=self._cube_seed_files(
                context.api_key, context.endpoint, context.catalog, getattr(context, "limits", None),
                persona=self._persona_of(context), vision=getattr(context, "vision", None),
                tracing_lines=await credential_lines(self.s, self.store, user_id),
                settings=await self.store.get_profile_settings(user_id)),
            ready_timeout_s=self.s.ready_timeout_s,
            state=self._state_block(sandbox_id, epoch, restore_from),
            # 平台的运行环境才另开 API 服务；成员实例的引导请求不变
            **({"api_server": True} if getattr(context, "service", False) else {}),
            # 企业模式用不上普通版的连接器和崩溃恢复，转发器不起它们（见 seed/forward.py）
            **({"enterprise": True} if self.s.enterprise else {}),
            **({"connectors": connectors} if (connectors := await self._connector_states(user_id)) else {}),
        )
        if body.get("already"):
            await self._adopt_bootstrapped(user_id, slug, sandbox_id)
            return
        report = body.get("state") or {}
        # 恢复完成：这台实例成为当前主人。它用了哪份归档、行数多少，一并记下。
        await self.store.set_state_owner(
            user_id, sandbox_id, str(report.get("archive") or ""),
            {"restored_from": report.get("restored_from", ""), "counts": report.get("counts") or {}},
        )
        await self._remember_hermes_key(user_id, sandbox_id, context.api_key)
        await self.store.write_audit(user_id, "tenant.restore", {
            "sandbox": sandbox_id,
            "restored_from": report.get("restored_from", ""),
            "archive": report.get("archive", ""),
            "notes": report.get("notes", []),
            "migration": report.get("migration", ""),
        })
        log.info("tenant %s: 实例 %s 引导完成，恢复自 %s / %s", slug, sandbox_id[:12],
                 (report.get("restored_from") or "-")[:12], report.get("archive") or "-")

    async def _adopt_bootstrapped(self, user_id: str, slug: str, sandbox_id: str, st: dict | None = None) -> None:
        """实例早已引导完成，库里记的数据主人却还不是它：上一次引导其实做成了、回包没回来（被代理挡回、
        超时），或别的请求抢先引导了。问它的状态管家，主人是它自己就补记。不补也不丢数据（下一代会优先从卷上
        记的主人恢复，见 mtstate.prepare），但在那之前每个请求都会因为「主人 ≠ 实例」走一遍慢路径。"""
        assert self.cube is not None
        rt = await self.store.get_runtime(user_id)
        if rt.state_owner == sandbox_id:
            return
        if st is None:
            try:
                st = await self.cube.status(sandbox_id, self.s.forward_port)
            except CubeError:
                return
        state = st.get("state")
        if not st.get("bootstrapped") or not isinstance(state, dict) or state.get("owner") != sandbox_id:
            return
        restored_from = str(state.get("restored_from") or "")
        await self.store.set_state_owner(user_id, sandbox_id, "", {"restored_from": restored_from})
        log.info("tenant %s: 实例 %s 早已引导完成，补记为数据主人（恢复自 %s）", slug, sandbox_id[:12],
                 restored_from[:12] or "-")

    async def _repair_bootstrap(self, user_id: str, slug: str, sandbox_id: str, token: str, context) -> tuple[str, bool]:
        """问转发器这台实例引导过没有：没引导过就补引导；窗口已关就删掉让调用方重建。

        返回 ``(还能用的 sandbox_id 或空串, 这次有没有补引导成功)``。
        引导过、或问不到转发器时原样返回，由调用方按正常路径继续或报错。
        """
        assert self.cube is not None
        port = self.s.forward_port
        try:
            st = await self.cube.status(sandbox_id, port)
        except CubeError:
            return sandbox_id, False
        if st.get("bootstrapped"):
            if (st.get("state") or {}).get("phase") in {"drained", "drain_failed"}:
                await self._resume_after_drain(user_id, sandbox_id, token)
                return sandbox_id, True
            await self._adopt_bootstrapped(user_id, slug, sandbox_id, st)
            return sandbox_id, False
        rt = await self.store.get_runtime(user_id)
        if st.get("boot_window_left_s", 0) > 30:
            log.warning("tenant %s: 实例 %s 未引导（上次引导没成），补引导", slug, sandbox_id[:12])
            try:
                await self._bootstrap_cube(user_id, slug, sandbox_id, token, context, rt.state_epoch, rt.state_owner)
            except CubeError as exc:
                if not volume_not_ready(exc):
                    raise
                # 卷没挂好的实例补多少次引导都一样，不等窗口关：删掉让调用方重建
                log.warning("tenant %s: 实例 %s 的卷没挂好（%s），删掉重建", slug, sandbox_id[:12], exc.message[:80])
                await self._discard_unbootstrapped(user_id, sandbox_id, "volume_not_ready")
                return "", False
            await self.cube.wait_hermes(sandbox_id, port, timeout_s=self.s.ready_timeout_s)
            return sandbox_id, True
        log.warning("tenant %s: 实例 %s 未引导且窗口已关，删掉重建", slug, sandbox_id[:12])
        await self.cube.remove_sandbox(sandbox_id)
        if not await self.cube.wait_gone(sandbox_id):
            raise CubeError(503, "未引导的旧实例尚未删除完成，请稍后重试")
        await self.store.mark_sandbox_deleted(sandbox_id, "unbootstrapped")
        await self.store.set_sandbox_id(user_id, None)
        return "", False

    async def _discard_unresponsive(self, user_id: str, slug: str, sandbox_id: str) -> bool:
        """平台说实例在跑，转发器却一直不应答（平台代理替它回 502/503/504）：删掉，调用方从归档重建。

        11-06 真机：一台被反复暂停、唤醒上千次的实例，最后一次唤醒后里面什么都没起来；入口每个请求等满
        180 秒报错，自己好不了，只能人工删。删实例连可写层一起删，所以只在不丢东西时删：这台实例上次是
        先归档、再暂停的，之后再没成功跑起来过（``Store.paused_after_archive``）。正在用的实例遇上平台代理
        一时不通，不在此列，照常报错。调用方持有这个用户的锁。
        """
        assert self.cube is not None
        if not sandbox_id or not await self.store.paused_after_archive(user_id):
            return False
        sb = await self.cube.get_sandbox(sandbox_id)
        if sb is None or str(sb.get("state")) != "running":
            return False
        try:
            await self.cube.status(sandbox_id, self.s.forward_port)
            return False  # 转发器答得上来，不是这种坏法
        except CubeError as exc:
            if not forwarder_unreachable(exc):
                return False
            log.warning("tenant %s: 实例 %s 在跑但转发器不应答（%s），删掉从归档重建", slug, sandbox_id[:12],
                        (exc.message or str(exc.status))[:80])
        await self.cube.remove_sandbox(sandbox_id)
        if not await self.cube.wait_gone(sandbox_id):
            raise CubeError(503, "无响应的旧实例尚未删除完成，请稍后重试")
        await self.store.mark_sandbox_deleted(sandbox_id, "unresponsive")
        await self.store.set_sandbox_id(user_id, None)
        await self.store.write_audit(user_id, "tenant.delete", {"sandbox": sandbox_id, "reason": "unresponsive"})
        # 同 _drain_and_delete：节点上卷的卸载可能还在收尾，立刻建新实例会挂到空的挂载点。
        if self.s.volume_detach_grace_s > 0:
            await asyncio.sleep(self.s.volume_detach_grace_s)
        return True

    async def _resume_after_drain(self, user_id: str, sandbox_id: str, token: str) -> None:
        """Recover the existing owner only; never create a second volume writer."""
        sb = await self.cube.get_sandbox(sandbox_id)
        if sb is None or str(sb.get("state")) in GONE_STATES:
            raise SandboxGone(404, "实例已消失或正在删除，请重试以恢复")
        if str(sb.get("state")) == "paused":
            # A recovery marker may outlive the process that drained the sandbox.
            # Wake it explicitly before inspecting its in-instance lifecycle state.
            await self.cube.resume_sandbox(sandbox_id)
            await self.cube.wait_forwarder(sandbox_id, self.s.forward_port)
        status = await self.cube.status(sandbox_id, self.s.forward_port)
        phase = (status.get("state") or {}).get("phase")
        if phase in {"drained", "drain_failed"}:
            await self.cube.resume(sandbox_id, self.s.forward_port, token)
            await self.cube.wait_hermes(sandbox_id, self.s.forward_port, timeout_s=self.s.ready_timeout_s)
        elif phase in {"draining", "fenced"} or status.get("draining") or status.get("hermes") is False:
            raise CubeError(503, "实例仍在排空或已失去所有权，请稍后重试")
        await self.store.set_tenant_state(user_id, "running")
        await self.store.mark_served(user_id)
        await self.store.set_lifecycle(user_id, "")
        await self.store.write_audit(user_id, "tenant.drain.resume", {"sandbox": sandbox_id})

    async def _drain_and_delete(self, user_id: str, sandbox_id: str, token: str, reason: str) -> bool:
        """停 hermes → 最终归档 → 记进 PG → 删实例 → 确认已消失。任何一步失败都不删。

        调用方必须持有这个用户的锁。返回 True 表示实例已删、sandbox_id 已清。
        """
        assert self.cube is not None
        port = self.s.forward_port
        slug = tenant_slug(user_id)
        await self.store.set_lifecycle(user_id, "draining")
        try:
            body = await self.cube.drain(sandbox_id, port, token)
        except CubeError as exc:
            log.warning("tenant %s: 排空实例 %s 失败: %s", slug, sandbox_id[:12], exc)
            # 转发器根本不应答时，「恢复旧实例」也要问它，只会接着失败，还把实例留在「排空中」：之后每个请求
            # 都走恢复、都失败（换模板时撞上暂停后唤醒没起来的实例）。暂停前的归档已经是全部数据，就直接换掉。
            if await self._discard_unresponsive(user_id, slug, sandbox_id):
                await self.store.set_lifecycle(user_id, "")
                return True
            await self._resume_after_drain(user_id, sandbox_id, token)
            return False
        summary = body.get("archive") or {}
        await self.store.set_state_archive(user_id, str(summary.get("archive") or ""), summary)
        await self._note_cron(user_id, body.get("activity"))
        await self.store.set_lifecycle(user_id, "drained")
        await self.store.write_audit(user_id, "tenant.drain", {"sandbox": sandbox_id, "archive": summary.get("archive", ""), "reason": reason})
        await self.store.set_lifecycle(user_id, "deleting")
        try:
            await self.cube.remove_sandbox(sandbox_id)
            gone = await self.cube.wait_gone(sandbox_id)
        except CubeError as exc:
            log.warning("tenant %s: 删实例 %s 失败: %s", slug, sandbox_id[:12], exc)
            gone = False
        if not gone:
            # Deletion failed: restore the existing owner, retaining its identity.
            # If removal is still in progress, recovery refuses to start another writer.
            await self._resume_after_drain(user_id, sandbox_id, token)
            return False
        await self.store.mark_sandbox_deleted(sandbox_id, reason)
        await self.store.set_sandbox_id(user_id, None)
        await self.store.set_lifecycle(user_id, "")
        await self.store.write_audit(user_id, "tenant.delete", {"sandbox": sandbox_id, "reason": reason})
        # 控制面说实例没了，节点上卷的卸载可能还在收尾；立刻建新实例会挂到空的挂载点（10-08 真机撞过）。
        if self.s.volume_detach_grace_s > 0:
            await asyncio.sleep(self.s.volume_detach_grace_s)
        return True

    async def _messaging_busy(self, user_id):
        if not self.s.channels_key:
            return False
        async with self.store.database.acquire() as db:
            return bool(await db.fetchval("SELECT 1 FROM messaging_inbox i JOIN messaging_bindings b ON b.id=i.binding_id WHERE i.user_id=$1 AND b.enabled AND b.deleted_at IS NULL AND b.revision=i.binding_revision AND i.lease_until>now() LIMIT 1",user_id))

    async def _stop_cube(self, user_id: str, reason: str) -> None:
        """空闲回收 = 暂停，不是销毁；暂停前先让状态管家归档一次。

        ★ 销毁会连同实例可写层一起删掉，而对话库就在可写层上。暂停把整机状态冻结存盘，
          下次请求 0.4 秒左右唤醒，数据完好；先归档是为了节点在暂停期间坏掉时也有得恢复。
        """
        assert self.cube is not None
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            async with self._pg_lock(user_id):
                if await self._messaging_busy(user_id):
                    return
                rt = await self.store.get_runtime(user_id)
                self._register_token(rt)
                sandbox_id = rt.sandbox_id
                if sandbox_id:
                    archived = False
                    try:
                        token = await self.store.ensure_tenant_token(user_id)
                        body = await self.cube.sync_state(sandbox_id, self.s.forward_port, token)
                        summary = body.get("archive") or {}
                        archived = bool(summary.get("archive"))
                        await self.store.set_state_archive(user_id, str(summary.get("archive") or ""), summary)
                        await self._note_cron(user_id, body.get("activity"))
                    except CubeError as exc:
                        log.warning("tenant %s: 暂停前归档失败（照样暂停）: %s", slug, exc)
                        # 归档失败不等于问不到：下一个定时任务的时间照样要记，否则停着就叫不醒了。
                        await self._note_cron(user_id, await self._status_activity(sandbox_id))
                    try:
                        await self.cube.pause_sandbox(sandbox_id)
                    except CubeError as exc:
                        log.warning("暂停 %s 的实例失败: %s", slug, exc)
                    else:
                        if archived:
                            # 这份归档就是全部数据：之后它要是醒来却起不来，可以放心从归档重建。
                            await self.store.mark_paused_clean(user_id)
                await self.store.set_tenant_state(user_id, "stopped")
                await self.store.write_audit(user_id, "tenant.stop", {"reason": reason})

    # ---- 定时任务：停着的实例按时叫醒，忙着的实例不回收 ------------------------------
    #
    # hermes 的定时任务由它自己的调度线程跑（转发器给 hermes 设了 HERMES_DESKTOP=1），
    # 实例在跑就不用入口管。入口只管实例停着的时候：
    #   暂停 / 删实例时，转发器在 sync / drain 的回包里报最早的下次执行时间 → 记进 PG；
    #   到点前 cron_wake_lead_s 秒，走用户访问的同一条路把实例叫起来（暂停的唤醒、删了的从归档重建），
    #   但不算用户活动；回收前再问一次转发器忙不忙，跑完照常按空闲规则回收。

    async def _status_activity(self, sandbox_id: str) -> dict | None:
        """问转发器忙不忙；问不到返回 None（调用方照旧处理）。"""
        assert self.cube is not None
        try:
            st = await self.cube.status(sandbox_id, self.s.forward_port)
        except CubeError as exc:
            log.warning("问实例 %s 忙不忙失败: %s", sandbox_id[:12], exc)
            return None
        activity = st.get("activity")
        return activity if isinstance(activity, dict) else None

    async def _note_cron(self, user_id: str, activity: dict | None) -> None:
        """把转发器报的最早下次执行时间记进 PG。老转发器不报、或这次没读出来，就不动原来记的。"""
        if not isinstance(activity, dict) or "cron_next_at" not in activity:
            return
        due = activity.get("cron_next_at")
        when = datetime.fromtimestamp(float(due), tz=timezone.utc) if isinstance(due, (int, float)) else None
        await self.store.set_next_cron(user_id, when)

    async def _busy_reason(self, user_id: str) -> str:
        """回收前问一句：这台实例为什么现在不能暂停。空串 = 可以暂停（问不到也按可以，照旧回收）。"""
        if not self.use_cube:
            if self.docker is None:
                return ""
            slug = tenant_slug(user_id)
            name = self.container_name(slug)
            info = await self.docker.inspect_container(name)
            if not (info or {}).get('State', {}).get('Running'):
                return ""
            ip = await self.docker.container_ip(name, self.network_name(slug))
            token = await self.store.ensure_tenant_token(user_id)
            try:
                async with self.http.get(f'http://{ip}:{self.s.forward_port}/__mt/status',
                        headers={'X-Mt-Token': token}, timeout=aiohttp.ClientTimeout(total=3)) as response:
                    if response.status == 200:
                        return busy_reason((await response.json()).get('activity'), time.time(), self.s.cron_keepalive_s)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                log.warning('Docker activity probe failed for %s', slug)
            return ""
        if self.cube is None:
            return ""
        woke = self._cron_woken.get(user_id)
        if woke is not None and time.monotonic() - woke < self.s.cron_keepalive_s:
            return "cron_wake"
        rt = await self.store.get_runtime(user_id)
        if not rt.sandbox_id:
            return ""
        self._register_token(rt)
        activity = await self._status_activity(rt.sandbox_id)
        return busy_reason(activity, time.time(), self.s.cron_keepalive_s)

    async def wake_due_cron(self) -> None:
        """实例停着而定时任务快到点：把它叫起来。同一个时间点只叫一次；叫不醒重试两次后放弃。"""
        if not self.use_cube or self.s.cron_wake_lead_s <= 0:
            return
        due = await self.store.cron_due_tenants(self.s.cron_wake_lead_s)
        if not due:
            return
        gate = asyncio.Semaphore(8)  # 很多人同一时刻到点（比如每天九点）时别一个个排着叫

        async def wake(user_id: str, due_at: datetime) -> None:
            async with gate:
                await self._wake_for_cron(user_id, due_at)

        await asyncio.gather(*(wake(user_id, due_at) for user_id, due_at in due))

    async def _wake_for_cron(self, user_id: str, due_at: datetime) -> None:
        slug = tenant_slug(user_id)
        key = (user_id, due_at)
        try:
            tenant = await self.ensure_running(user_id, touch=False)
        except Exception as exc:  # noqa: BLE001
            tries = self._wake_failures[key] = self._wake_failures.get(key, 0) + 1
            log.warning("cron wake: 叫醒 %s 失败（第 %d 次）: %s", slug, tries, exc)
            if tries < 3:
                return
            self._wake_failures.pop(key, None)
            await self.store.mark_cron_woken(user_id, due_at)
            await self.store.write_audit(user_id, "tenant.wake_cron_failed",
                                         {"due_at": due_at.isoformat(), "error": f"{type(exc).__name__}: {exc}"[:300]})
            return
        self._wake_failures.pop(key, None)
        self._cron_woken[user_id] = time.monotonic()
        await self.store.mark_cron_woken(user_id, due_at)
        await self.store.write_audit(user_id, "tenant.wake_cron",
                                     {"due_at": due_at.isoformat(), "sandbox": tenant.sandbox_id})
        log.info("cron wake: %s 的定时任务 %s 到点，已叫起实例 %s", slug, due_at.isoformat(), tenant.sandbox_id[:12])

    async def reap_long_idle(self) -> None:
        """暂停很久的实例：排空后删掉。下次登录从卷上的归档恢复。

        为什么要删：平台默认让暂停的实例继续占调度配额，暂停快照还占节点磁盘；
        几百上千个用户时不可能人人留一台暂停实例。
        """
        if not self.use_cube or self.s.idle_delete_hours <= 0:
            return
        for user_id in await self.store.long_idle_tenants(self.s.idle_delete_hours * 3600):
            slug = tenant_slug(user_id)
            async with self._lock(slug):
                async with self._pg_lock(user_id):
                    if await self._messaging_busy(user_id):
                        continue
                    rt = await self.store.get_runtime(user_id)
                    if not rt.sandbox_id or rt.state != "stopped":
                        continue
                    self._register_token(rt)
                    token = await self.store.ensure_tenant_token(user_id)
                    log.info("long idle: 排空并删除 %s 的实例 %s", slug, rt.sandbox_id[:12])
                    try:
                        await self._drain_and_delete(user_id, rt.sandbox_id, token, f"idle>{self.s.idle_delete_hours}h")
                    except Exception:  # noqa: BLE001
                        log.exception("long idle delete failed for %s", slug)

    async def _reconcile_cube(self) -> None:
        """入口启动时按平台上的实际状态校正运行态，**不动平台上的实例**。

        与 Docker 那条路的区别：那边入口重启后容器状态未知，一律停掉重来；
        这边实例是平台在管的，暂停/恢复都很便宜，而且实例里可能还挂着别人的
        长连接（多个入口副本共用一个集群）。
        ★ 不能一律改成 stopped：还在跑的实例会被记成已停，而空闲回收只挑 running，
          这些实例就永远不会被暂停、也不会被升级。
        """
        assert self.cube is not None
        rows = await self.store.tenants_with_sandbox()
        fixed = 0
        for user_id, sandbox_id, state in rows:
            try:
                sb = await self.cube.get_sandbox(sandbox_id)
            except CubeError as exc:
                log.warning("reconcile(cube): 查实例 %s 失败: %s", sandbox_id[:12], exc)
                continue
            if sb is None:
                await self.store.mark_sandbox_deleted(sandbox_id, "gone")
                await self.store.set_sandbox_id(user_id, None)
                want = "stopped"
            elif str(sb.get("state")) == "running":
                want = "running"
            else:
                want = "stopped"
            if want != state:
                await self.store.set_tenant_state(user_id, want)
                fixed += 1
        # 没有实例记录的用户不可能在跑
        for user_id, state, _ in await self.store.all_tenant_states():
            if state in ("running", "starting") and not (await self.store.get_runtime(user_id)).sandbox_id:
                await self.store.set_tenant_state(user_id, "stopped")
                fixed += 1
        log.info("reconcile(cube): %d 个有实例的用户，校正 %d 条，平台实例未动", len(rows), fixed)

    # ---- 换了 key 要重启 hermes ----------------------------------------------------
    #
    # 企业模式每次登录都会换设备令牌（平台对同一设备只留一个有效令牌，旧的吊销）。_sync_api_key 经 /api/env
    # 换掉的环境变量，模型调用每次现读，够用；元景 MCP 不够：hermes 连接时把地址里的 ${KEY} 展开成了当时的
    # 令牌，旧令牌一吊销，元景工具全部 401。所以 key 变了就让转发器重写配置、重启 hermes（/__mt/reload）。

    RELOAD_RETRY_S = 30.0

    async def _remember_hermes_key(self, user_id: str, sandbox_id: str, api_key: str) -> None:
        if not api_key:
            return
        digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        await self.store.set_hermes_key(user_id, sandbox_id, digest)
        self._hermes_keys[user_id] = digest

    async def _reload_if_key_changed(self, user_id: str, slug: str, sandbox_id: str, token: str, context) -> None:
        """实例里的 hermes 是用旧 key 起的：让转发器重写配置并重启 hermes。

        对话回合、定时任务正在跑就这次不动，过 RELOAD_RETRY_S 秒后下一个请求再看。
        不知道它是用哪把 key 起的（入口升级前建的实例）就不动；重新加载失败只记日志，不影响这次请求。
        """
        assert self.cube is not None
        api_key = context.api_key
        if not api_key:
            return
        want = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        unknown = f"?{sandbox_id}"  # 这台实例记不得是用哪把 key 起的：之后的请求也不用再查库
        if self._hermes_keys.get(user_id) in (want, unknown):
            return
        rt = await self.store.get_runtime(user_id)
        if rt.sandbox_id != sandbox_id:
            return
        if not rt.hermes_key_sha256:
            self._hermes_keys[user_id] = unknown
            return
        if rt.hermes_key_sha256 == want:
            self._hermes_keys[user_id] = want
            return
        now = time.monotonic()
        if now - self._reload_tried.get(user_id, -1e9) < self.RELOAD_RETRY_S:
            return
        self._reload_tried[user_id] = now
        reason = busy_reason(await self._status_activity(sandbox_id), time.time(), 0)
        if reason:
            log.info("tenant %s: 模型 key 换了，但实例在忙（%s），稍后再重新加载", slug, reason)
            return
        try:
            body = await self.cube.reload(
                sandbox_id, self.s.forward_port, token,
                files=self._cube_seed_files(api_key, context.endpoint, context.catalog,
                                            getattr(context, "limits", None), persona=self._persona_of(context),
                                            vision=getattr(context, "vision", None)),
                ready_timeout_s=self.s.ready_timeout_s,
            )
        except CubeError as exc:
            log.warning("tenant %s: 重新加载实例 %s 失败: %s", slug, sandbox_id[:12], exc)
            return
        await self._remember_hermes_key(user_id, sandbox_id, api_key)
        self._reload_tried.pop(user_id, None)
        # 新的 .env 已经写进去、hermes 已经按它重启：不用再经 /api/env 送一遍
        self._synced_key_digests[user_id] = hashlib.sha256(api_key.encode("utf-8")).digest()
        await self.store.write_audit(user_id, "tenant.reload",
                                     {"sandbox": sandbox_id, "reason": "model_key", "written": body.get("written", [])})
        log.info("tenant %s: 模型 key 换了，实例 %s 已重新加载（hermes 已重启）", slug, sandbox_id[:12])

    async def _sync_langfuse(self, cname: str, user_id: str) -> bool:
        lines = await credential_lines(self.s, self.store, user_id)
        if not lines:
            return False
        archive = await self.docker.get_archive(cname, "/opt/data/.env")
        raw = self._from_tar(archive, ".env") if archive else None
        text = raw.decode("utf-8") if raw is not None else ""
        updated = _mtstate().env_upsert_text(text, lines)
        if updated == text:
            return False
        await self.docker.put_archive(cname, "/opt/data", _tar_bytes({".env": updated.encode("utf-8")}))
        return True

    async def _sync_api_key(self, tenant: Tenant, api_key: str) -> None:
        """通过 Hermes 既有接口更新 Key；只有成功后才记录内存摘要。"""
        if not api_key:
            return
        digest = hashlib.sha256(api_key.encode("utf-8")).digest()
        if self._synced_key_digests.get(tenant.user_id) == digest:
            return
        origin = tenant.origin or f"{tenant.ip}:{self.s.forward_port}"
        url = f"http://{origin}/api/env"
        headers = {
            "Host": tenant.host_header or f"127.0.0.1:{self.s.hermes_port}",
            "X-Hermes-Session-Token": tenant.token,
        }
        names = [self.s.key_env_name] + ([] if self.s.enterprise else [DESKTOP_MAAS_KEY_ENV])
        try:
            for name in names:
                async with self.http.put(
                    url,
                    headers=headers,
                    json={"key": name, "value": api_key},
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as response:
                    if response.status < 200 or response.status >= 300:
                        await response.text()
                        raise CredentialSyncError(f"Hermes 凭据接口返回 HTTP {response.status}")
        except CredentialSyncError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise CredentialSyncError(f"Hermes 凭据接口不可达: {type(exc).__name__}") from exc
        self._synced_key_digests[tenant.user_id] = digest

    async def _create(self, cname: str, nname: str, vname: str, labels: dict, token: str,
                      api_server: bool = False) -> None:
        # 平台的运行环境：转发器另起 gateway 的 API 服务（沙箱路径靠引导载荷，这里靠环境变量）
        extra_env = ["MT_API_SERVER=1"] if api_server else []
        if self.s.enterprise:
            extra_env.append("MT_ENTERPRISE=1")
        spec = {
            "Image": self.s.image,
            "Env": [
                "HERMES_HOME=/opt/data",
                f"HERMES_DASHBOARD_SESSION_TOKEN={token}",
                "HERMES_UID=10000",
                "HERMES_GID=10000",
                f"TZ={self.s.tz}",
                "TERMINAL_ENV=local",
                f"HERMES_DASHBOARD_FILES_ROOT={self.s.files_root}",
                f"MT_FWD_PORT={self.s.forward_port}",
                f"MT_HERMES_PORT={self.s.hermes_port}",
                *extra_env,
            ],
            "Cmd": ["python3", "/opt/data/.mt/forward.py"],
            "Labels": labels,
            "HostConfig": {
                "Binds": [f"{vname}:/opt/data"],
                "Memory": self.s.memory_bytes,
                "MemorySwap": self.s.memory_bytes,
                "NanoCpus": self.s.nano_cpus,
                "PidsLimit": self.s.pids_limit,
                "SecurityOpt": ["no-new-privileges"],
                "RestartPolicy": {"Name": "no"},
                "NetworkMode": nname,
                "LogConfig": {"Type": "json-file", "Config": {"max-size": "20m", "max-file": "3"}},
            },
        }
        await self.docker.create_container(cname, spec)

    async def _wait_ready(self, ip: str) -> None:
        """轮询 /api/health。注意 Host 头必须是 loopback 名，否则被 hermes 的 Host 门拒掉。"""
        url = f"http://{ip}:{self.s.forward_port}/api/health"
        headers = {"Host": f"127.0.0.1:{self.s.hermes_port}"}
        deadline = time.monotonic() + self.s.ready_timeout_s
        last_err = ""
        while time.monotonic() < deadline:
            try:
                async with self.http.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                    if resp.status == 200:
                        return
                    last_err = f"HTTP {resp.status}"
            except Exception as exc:  # noqa: BLE001
                last_err = type(exc).__name__
            await asyncio.sleep(1.0)
        raise TimeoutError(f"租户容器 {self.s.ready_timeout_s}s 内没就绪: {last_err}")

    # ---- 平台的运行环境（svc: 用户，docs/企业版对接/15） ------------------------------------------

    def service_digest(self, context) -> str:
        """实例里该生效的人设 + 模型；Docker 路径连令牌一起算（沙箱路径换令牌由 _reload_if_key_changed 管）。"""
        h = hashlib.sha256()
        for part in (context.persona, json.dumps(context.endpoint), json.dumps(context.catalog),
                     json.dumps(getattr(context, "limits", None) or {}, sort_keys=True),
                     json.dumps(getattr(context, "vision", None) or {}, sort_keys=True)):
            h.update(part.encode("utf-8"))
            h.update(b"\0")
        if not self.use_cube:
            h.update(context.api_key.encode("utf-8"))
        return h.hexdigest()

    async def apply_service_spec(self, user_id: str, applied_sha256: str) -> bool:
        """平台改了运行环境的人设或模型：重写实例里的文件并重启 hermes 和 gateway。返回 True 表示重新加载过。

        调用前实例要已经由 ensure_running 拉起来；正在跑运行时由调用方决定不调。
        """
        context = await self.store.get_tenant_context(user_id)
        want = self.service_digest(context)
        if want == applied_sha256:
            return False
        slug = tenant_slug(user_id)
        if self.use_cube:
            assert self.cube is not None
            rt = await self.store.get_runtime(user_id)
            token = await self.store.ensure_tenant_token(user_id)
            await self.cube.reload(
                rt.sandbox_id, self.s.forward_port, token,
                files=self._cube_seed_files(context.api_key, context.endpoint, context.catalog,
                                            getattr(context, "limits", None), persona=self._persona_of(context),
                                            vision=getattr(context, "vision", None)),
                ready_timeout_s=self.s.ready_timeout_s,
            )
            await self._remember_hermes_key(user_id, rt.sandbox_id, context.api_key)
            self._synced_key_digests[user_id] = hashlib.sha256(context.api_key.encode("utf-8")).digest()
        else:
            # Docker 路径：卷是这个运行环境专用的，三份文件整份重写，重启容器让 hermes 和 gateway 都重读
            files = self._render_user_files(context.api_key, context.endpoint, context.catalog,
                                            getattr(context, "limits", None), getattr(context, "vision", None))
            if persona := self._persona_of(context):
                files["SOUL.md"] = persona.encode("utf-8")
            cname = self.container_name(slug)
            async with self._lock(slug):
                await self.docker.put_archive(cname, "/opt/data", _tar_bytes(files))
                await self.docker.stop_container(cname)
            await self.ensure_running(user_id)
        await self.store.set_service_spec(user_id, want)
        await self.store.write_audit(user_id, "service.reload", {"reason": "spec"})
        log.info("service %s: 平台改了人设或模型，实例已重新加载", slug)
        return True

    async def restart_service(self, user_id: str) -> None:
        """平台的「重启」：不删卷，重写配置后重启 hermes 和 gateway。"""
        slug = tenant_slug(user_id)
        if self.use_cube:
            assert self.cube is not None
            await self.ensure_running(user_id)
            context = await self.store.get_tenant_context(user_id)
            rt = await self.store.get_runtime(user_id)
            token = await self.store.ensure_tenant_token(user_id)
            await self.cube.reload(
                rt.sandbox_id, self.s.forward_port, token,
                files=self._cube_seed_files(context.api_key, context.endpoint, context.catalog,
                                            getattr(context, "limits", None), persona=self._persona_of(context),
                                            vision=getattr(context, "vision", None)),
                ready_timeout_s=self.s.ready_timeout_s,
            )
        else:
            async with self._lock(slug):
                info = await self.docker.inspect_container(self.container_name(slug))
                if info and info.get("State", {}).get("Running"):
                    await self.docker.stop_container(self.container_name(slug))
            await self.ensure_running(user_id)
        await self.store.write_audit(user_id, "service.restart", {})

    async def restart_container(self, user_id: str) -> Tenant:
        """Docker 路径：重启这个用户的容器（hermes 是容器的主进程，转发器重启不了它），等它重新就绪。

        企业资源第一次装出 Agent 的 profile、或 MCP 变了时用：hermes 要重新启动才按托管多个 profile 启动、重连 MCP。"""
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            info = await self.docker.inspect_container(self.container_name(slug))
            if info and info.get("State", {}).get("Running"):
                await self.docker.stop_container(self.container_name(slug))
        return await self.ensure_running(user_id)

    async def delete_service(self, user_id: str) -> None:
        """平台删了 Agent：删实例和卷，再删入口里的记录。实例删不掉就抛出，记录留着下次再删。"""
        slug = tenant_slug(user_id)
        if self.use_cube:
            assert self.cube is not None
            async with self._lock(slug):
                async with self._pg_lock(user_id):
                    rt = await self.store.get_runtime(user_id)
                    if rt.sandbox_id:
                        token = await self.store.ensure_tenant_token(user_id)
                        if not await self._drain_and_delete(user_id, rt.sandbox_id, token, "service_delete"):
                            raise RuntimeError("实例没能删除")
                    await self.cube.remove_volume(self.cube_volume_name(user_id))
        else:
            async with self._lock(slug):
                await self.docker.remove_container(self.container_name(slug))
                await self.docker.remove_volume(self.volume_name(slug))
                try:
                    await self.docker.remove_network(self.network_name(slug))
                except DockerError as exc:  # 入口自己还连在这张网上时删不掉，留着不影响什么
                    log.info("service %s: 网络没删掉（%s），留着", slug, exc)
        self._hermes_keys.pop(user_id, None)
        self._synced_key_digests.pop(user_id, None)
        await self.store.delete_user(user_id)
        log.info("service %s: 运行环境已删除（实例和卷）", slug)

    async def stop(self, user_id: str, reason: str = "") -> None:
        if self.use_cube:
            await self._stop_cube(user_id, reason)
            return
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            cname = self.container_name(slug)
            info = await self.docker.inspect_container(cname)
            if info and info.get("State", {}).get("Running"):
                await self.docker.stop_container(cname)
            await self.store.set_tenant_state(user_id, "stopped")
            await self.store.write_audit(user_id, "tenant.stop", {"reason": reason})

    async def reconcile(self) -> None:
        """入口启动时：把所有租户容器停掉，运行态清成 stopped，之后按需再起。

        ★ 必须在后台跑，不能挡住入口开始监听：停一个容器要一秒多，几十个租户就是
        几十秒的 502 窗口（实测 6 个容器 6.8s，期间 nginx 全部 connection refused）。
        ★ 每个租户都走 ``ensure_running`` 用的同一把锁，否则后台停容器会和这段时间里
        进来的用户请求打架——刚拉起来的容器被 reconcile 一巴掌停掉。
        """
        if self.use_cube:
            await self._reconcile_cube()
            return
        containers = await self.docker.list_containers("hermes.mt=tenant")
        for c in containers:
            name = (c.get("Names") or ["?"])[0].lstrip("/")
            slug = (c.get("Labels") or {}).get("hermes.mt.slug", "")
            user_id = (c.get("Labels") or {}).get("hermes.mt.user", "")
            async with self._lock(slug or name):
                if c.get("State") == "running":
                    try:
                        await self.docker.stop_container(name)
                    except DockerError as exc:
                        log.warning("reconcile stop %s failed: %s", name, exc)
                if user_id:
                    await self.store.set_tenant_state(user_id, "stopped")
        log.info("reconcile: %d tenant container(s) reset", len(containers))

    async def reap_idle(self, keep: set[str] | None = None) -> None:
        """``keep`` = 此刻还挂着 ws 连接的用户，一律不回收。

        沙箱后端暂停前再问转发器一句忙不忙（定时任务在跑 / 快到点、对话回合在跑）：忙就这轮不动，
        下一轮再问。原因变了才打日志。
        """
        for user_id in await self.store.idle_tenants(self.s.idle_minutes * 60, exclude=keep):
            try:
                reason = await self._busy_reason(user_id)
                if reason:
                    if self._busy_seen.get(user_id) != reason:
                        log.info("idle reap: %s 空闲但在忙（%s），这轮不暂停", user_id, reason)
                    self._busy_seen[user_id] = reason
                    continue
                self._busy_seen.pop(user_id, None)
                self._cron_woken.pop(user_id, None)
                log.info("idle reap: stopping tenant of %s", user_id)
                await self.stop(user_id, reason=f"idle>{self.s.idle_minutes}m")
            except Exception:  # noqa: BLE001
                log.exception("idle reap failed for %s", user_id)
        await self.reap_long_idle()
