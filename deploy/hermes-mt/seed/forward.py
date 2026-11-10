"""租户容器内的转发器（Docker 路径）＋ 引导器与状态管家宿主（沙箱路径）：0.0.0.0:9121 -> 127.0.0.1:9120。

为什么存在：hermes 的 dashboard 绑非 loopback 地址就会强制开鉴权门（``--insecure`` 已失效），
门开后 ws 只认 30 秒单次票据，而浏览器版前端不会去要票据。所以 hermes 继续绑 127.0.0.1，
入口服务从外部连到这个转发器，hermes 看到的对端仍然是 127.0.0.1，门关着。

两种运行方式，同一个文件：

1. **Docker 路径（现状，不变）** —— 容器 CMD 同时起本文件和 hermes，入口在启动容器前已经
   把 ``config.yaml`` / ``.env`` 塞进卷。本文件只做透明转发，``/__mt/*`` 那几个接口没人调。

2. **沙箱路径** —— 平台没有「往未启动的容器里塞文件」这个能力，而创建时传入的环境变量是在
   **容器进程已经起来之后**才下发的（Cubelet 的顺序是 起容器 → 探针 → 创建后处理 → 下发变量）。
   hermes 缺了会话令牌会直接退出，进程一死探针永远不通，沙箱根本建不起来。
   所以 CMD 只起本文件：它秒级就绪让探针过，再由入口调一次 ``POST /__mt/bootstrap``
   把令牌和种子文件送进来，然后本文件才把 hermes 拉起来。

   引导载荷若带 ``state`` 段，就先由状态管家（mtstate.py）把上一代实例留在卷上的归档恢复到
   本地盘、校验、写主人标记、建目录链接，再拉起 hermes；之后定时把本地状态归档回卷。
   入口在暂停前调 ``/__mt/sync``、删实例前调 ``/__mt/drain``；模型 key 换了（企业模式每次登录都换）
   就调 ``/__mt/reload``：重写配置并重启 hermes。这些接口要带实例令牌。
   这两个接口和 ``/__mt/status`` 都附带「忙不忙」（定时任务、对话回合，见 mtstate.activity）：
   入口据此决定这轮回收要不要暂停，并在实例停着时按下一个定时任务的时间把它叫起来。

服务实例（平台调用云端运行智能体，见 docs/企业版对接/15）另外起一个 ``hermes gateway``，只开它的 API 服务
（``/v1/runs`` 只在 gateway 里有，``hermes serve`` 没有），只听实例内回环。沙箱路径由引导载荷的
``api_server`` 打开，Docker 路径由容器环境变量 ``MT_API_SERVER=1`` 打开。入口经 ``/__mt/api/*`` 访问它：要实例令牌，
转发时换成实例里随机生成的 API key，事件流照样逐字节对拷。

企业模式下，入口按企业管理平台的策略算一份「企业资源清单」，经 ``POST /__mt/enterprise`` 送进来（两条路径都用，
要实例令牌）：平台定义的 Agent 各装成一个托管 profile，企业技能、专家包、连接器、企业经验按清单装进对应的 profile，
细节见 mtent.py。托管 profile 的设备令牌由这里定时跟上默认 profile（换令牌后最多晚一个周期）。

``/__mt_user/*`` 是给用户用的（命令行通道、回收站、重命名、Office 文件预览：转 PDF、幻灯片按页出图，见 mtuser.py）：浏览器经入口的
``/__hermes_backend/__mt_user/…`` 转进来，带的是和 hermes 一样的会话令牌。入口照常校验登录后放行；
``/__mt/*`` 这组管理接口入口不放行，用户碰不到。

其余请求原样转发，读完请求头就退化成裸字节对拷，因此 WebSocket 不受影响。转发器只看每条连接的
第一个请求，所以转给 hermes 的普通请求一律改成 ``Connection: close``：hermes 回完就关，客户端的下一个
请求只能新开连接、重新经过这里分流。平台代理本来就不复用到实例的连接（CubeProxy 关了 upstream keepalive），
但入口直接连到容器的 Docker 路径、本机的复现台都会复用——不改的话，同一条连接上后面的 ``/__mt_user/…``
会被当成普通请求整段转给 hermes（10-09 本机实测撞过）。

由容器 CMD 以 hermes 用户启动，连接器管理复用镜像内已有的 aiohttp 和 PyYAML。
hermes 意外退出时由本文件带退避拉起。
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import signal
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mtent  # noqa: E402
import mtstate  # noqa: E402
import mtuser
import mtfolders
import mtmessaging
import mtconnectors
import mtexport  # noqa: E402

LISTEN_PORT = int(os.environ.get("MT_FWD_PORT", "9121"))
TARGET_PORT = int(os.environ.get("MT_HERMES_PORT", "9120"))
API_PORT = int(os.environ.get("MT_API_PORT", "8642"))  # 服务实例里 gateway 的 API 服务（只听回环）
API_PREFIX = "/__mt/api/"
HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
# 文件面板的根（沙箱镜像里是 /opt/data/workspace，指向卷上的工作区）。回收站和重命名只动这里面的东西。
WORKSPACE = Path(os.environ.get("HERMES_DASHBOARD_FILES_ROOT") or HERMES_HOME / "workspace")
USER_PREFIX = "/__mt_user/"
TRASH_PURGE_INTERVAL_S = 3600
CHUNK = 64 * 1024

# 引导窗口：容器启动后多少秒内允许 bootstrap。入口在创建沙箱后立刻调用，
# 留这个窗口是为了缩小「别人抢先引导」的时间面（见下方 _bootstrap 的说明）。
BOOTSTRAP_WINDOW_S = int(os.environ.get("MT_BOOTSTRAP_WINDOW_S", "600"))
# 定时归档间隔（秒）；入口可在 state 段里覆盖。
ARCHIVE_INTERVAL_S = int(os.environ.get("MT_ARCHIVE_INTERVAL_S", "300"))

MAX_HEAD = 64 * 1024  # 请求头上限，超过就当坏请求
MAX_BODY = 4 * 1024 * 1024  # 引导载荷上限

# 自带技能的同步用 hermes 自己的 Python 跑 hermes 的同步函数（见 _sync_bundled_skills）。
HERMES_PYTHON = os.environ.get("MT_HERMES_PYTHON", "/opt/hermes/.venv/bin/python")
_messaging_gateway = mtmessaging.Gateway(HERMES_HOME,HERMES_PYTHON)
_connectors = mtconnectors.Connectors(HERMES_HOME, HERMES_PYTHON, backend_port=TARGET_PORT, profile_token=os.environ.get('HERMES_DASHBOARD_SESSION_TOKEN', ''))
HERMES_INSTALL = Path(os.environ.get("MT_HERMES_INSTALL", "/opt/hermes"))
# 联网搜索插件自带的配置脚本（Dockerfile.cube 把插件放进内置插件目录）。
UNISEARCH_CONFIGURE = HERMES_INSTALL / "plugins/unisearch/configure.py"
UNISEARCH_CONFIGURE_TIMEOUT_S = 30.0
SKILLS_SYNC_TIMEOUT_S = 60.0
# 引导时就装企业资源（见 _apply_at_boot）：单个包最多等 15 秒，下载总共最多 30 秒，超了的留给启动后那次送清单补装。
BOOT_FETCH_TIMEOUT_S = 15.0
BOOT_FETCH_BUDGET_S = 30.0
# 回包只要名字和计数：删掉了哪些、归档了哪些（用户改过的）、新发了哪些。
SKILLS_SYNC_SCRIPT = (
    "import json, sys; sys.path.insert(0, '.'); from tools.skills_sync import sync_skills; "
    "r = sync_skills(quiet=True); "
    "print(json.dumps({k: r.get(k) for k in ('copied', 'updated', 'user_modified', 'retired_pristine', "
    "'retired_modified', 'total_bundled')}, ensure_ascii=False, default=str))"
)

_START_TS = time.monotonic()
_hermes_proc: asyncio.subprocess.Process | None = None
_hermes_token: str = ""
_hermes_env: dict[str, str] = {}
_bootstrapped = False
# 企业模式（入口配了 MT_UNIWORK_SERVER）：普通版的崩溃恢复用不上，不起；连接器看入口开没开（_connectors_on）。
# 沙箱路径由引导载荷打开，Docker 路径靠环境变量。
_enterprise_mode = os.environ.get("MT_ENTERPRISE") == "1"
# 企业版开放的个人版功能：入口按 MT_CLIENT_FEATURES 算好的清单（空 = 都不开）。沙箱路径来自引导载荷的 features。
_enterprise_features = {item for item in os.environ.get("MT_ENTERPRISE_FEATURES", "").split(",") if item}


def _connectors_on() -> bool:
    """普通版一直起连接器运行时；企业版要入口开了 connectors。"""
    return not _enterprise_mode or "connectors" in _enterprise_features
_boot_lock: asyncio.Lock | None = None
_state: mtstate.StateManager | None = None
_state_lock: asyncio.Lock | None = None
_archiver_task: asyncio.Task | None = None
_supervisor_task: asyncio.Task | None = None
_draining = False
_drained: dict | None = None
_hermes_restarts = 0
_reloading = False  # /__mt/reload 正在重启 hermes：守护循环别跟着拉起
_reload_lock: asyncio.Lock | None = None
_api_enabled = False  # 服务实例：另起 gateway 的 API 服务
_api_key = ""  # 只在这台实例里用，每次启动重新生成；不进日志
_gateway_proc: asyncio.subprocess.Process | None = None
_gateway_task: asyncio.Task | None = None
_enterprise_lock: asyncio.Lock | None = None
# 托管 profile 跟上默认 profile 的设备令牌（见 mtent.sync_tokens）：每 2 秒看一眼默认 profile 的 .env 变没变，
# 变了马上同步（重新登录后紧接着就会用 Agent 聊天）；另外每分钟兜底同步一次
TOKEN_WATCH_INTERVAL_S = 2
TOKEN_SYNC_INTERVAL_S = 60
# hermes 启动时数过的 profile home 个数：两个以上它才按「一个进程托管多个 profile」启动
# （tui_gateway/launch_profile_policy.activate_multi_profile_hosting_eagerly），MCP 也只在启动时连。
_boot_homes = 0
_restart_pending = False  # 企业资源要重启 hermes 才完全生效，但上次赶上它在忙：下次送清单时再重启


# ---------------------------------------------------------------- 工具

class _Timing:
    """一次引导、重启或排空里各段花了多久（秒，一位小数），以及哪些进程没有自己退出、等满时限被强杀。

    放进回包的 ``timing``，入口记进审计：准备慢、打开页面慢时按它查卡在哪一段。11-10 真机重启一次 hermes
    从 15 秒变成 38～41 秒，没有分段就说不清是停得慢还是起得慢。"""

    def __init__(self) -> None:
        self.steps: dict[str, float] = {}
        self.killed: list[str] = []
        self._mark = time.monotonic()

    def lap(self, step: str) -> None:
        now = time.monotonic()
        self.steps[step] = round(self.steps.get(step, 0.0) + now - self._mark, 1)
        self._mark = now

    def merge(self, part: dict | None) -> None:
        """并进 _stop_hermes、_stop_gateway、_spawn_hermes 自己记的分段，计时起点挪到现在。"""
        for step, seconds in ((part or {}).get("steps") or {}).items():
            self.steps[step] = round(self.steps.get(step, 0.0) + seconds, 1)
        self.killed += [name for name in (part or {}).get("killed") or [] if name not in self.killed]
        self._mark = time.monotonic()

    def as_dict(self) -> dict:
        return {"steps": dict(self.steps), **({"killed": list(self.killed)} if self.killed else {})}


async def _port_alive(port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=1.0
        )
    except Exception:  # noqa: BLE001
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:  # noqa: BLE001
        pass
    return True


async def _hermes_alive() -> bool:
    """hermes 端口能不能连上。"""
    return await _port_alive(TARGET_PORT)


async def _ready() -> bool:
    """hermes 起来了；服务实例还要 gateway 的 API 服务也起来。"""
    return await _hermes_alive() and (not _api_enabled or await _port_alive(API_PORT))


def _reply(writer: asyncio.StreamWriter, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    reason = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
              405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
              415: "Unsupported Media Type", 422: "Unprocessable Entity",
              500: "Internal Server Error", 501: "Not Implemented",
              503: "Service Unavailable", 504: "Gateway Timeout"}.get(status, "Error")
    head = (
        f"HTTP/1.1 {status} {reason}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    try:
        writer.write(head + body)
    except Exception:  # noqa: BLE001
        pass


def _log(msg: str) -> None:
    print(f"[forward] {msg}", flush=True)


# ---------------------------------------------------------------- 引导

# 镜像的 stage2 引导（docker/stage2-hook.sh 的 seed_one）在首次启动时会把这些示例
# 文件拷进 HERMES_HOME。两条路径的顺序是反的：
#   Docker 路径 —— 入口先把种子塞进卷，容器再启动，stage2 看到文件已存在就不动；
#   沙箱路径 —— 容器先启动，stage2 先种了示例，我们的引导才到。
# 于是沙箱下 ``overwrite=False`` 会让入口渲染的 config.yaml 永远写不进去，
# 用户拿到的是 hermes 那份十万字节的默认示例，等于没有模型配置。
# 这张表让判断可以做到精确而不是拍脑袋：盘上的文件与镜像里的示例**逐字节相同**，
# 就说明是 stage2 种的、没人碰过，可以安全覆盖；只要有一个字节不同，
# 就是用户或 hermes 自己写过的，绝不能盖。
_PRISTINE_REF = {
    "config.yaml": "/opt/hermes/cli-config.yaml.example",
    ".env": "/opt/hermes/.env.example",
    "SOUL.md": "/opt/hermes/docker/SOUL.md",
}


def _is_pristine(rel: str, dest: Path) -> bool:
    """盘上这份是不是 stage2 刚种下、还没被任何人改过的示例。"""
    ref = _PRISTINE_REF.get(rel)
    if ref is None:
        return False
    try:
        ref_path = Path(ref)
        if not ref_path.is_file():
            return False
        return dest.read_bytes() == ref_path.read_bytes()
    except OSError:
        return False


def _write_seed(files: list[dict]) -> list[str]:
    """把入口送来的种子文件落到 HERMES_HOME 下。返回实际写了哪些。

    每项的 ``overwrite`` 有四种取值：

    - ``True`` —— 总是写。
    - ``False`` —— 文件已存在就跳过。老用户卷里属于他自己的东西用这个。
    - ``"if-pristine"`` —— 文件不存在就写；已存在则仅当它与镜像里的示例逐字节相同
      时才写。这是 ``config.yaml`` 该用的：既能盖掉 stage2 种的默认示例，
      又不会碰用户或 hermes 自己写过的内容。
    - ``"upsert-lines"`` —— 只改 content 里那几行 ``KEY=VALUE``，其余保持用户自己的。
      这是 ``.env`` 该用的：用户在界面里存的别的 key 不能被抹掉。
    - ``"patch-model"`` —— content 是 JSON ``{base_url, model, provider_key, key_env, models, template, …}``：
      整份解析 config.yaml，只改平台块（端点、provider、key 来源、模型清单、平台策略、内置 MCP），用户自己的设置不碰；
      解析不了的先剔残行，再不行就按 template 重建。见 mtstate.patch_config_text。
    """
    written: list[str] = []
    for item in files:
        rel = str(item.get("path", "")).strip().lstrip("/")
        if not rel or ".." in Path(rel).parts:
            raise ValueError(f"非法路径: {rel!r}")
        dest = HERMES_HOME / rel
        mode = item.get("overwrite", False)
        content = item.get("content", "")
        if mode == "upsert-lines":
            dest.parent.mkdir(parents=True, exist_ok=True)
            mtstate.env_upsert(dest, str(content).splitlines())
            written.append(rel)
            continue
        if mode == "patch-model":
            try:
                spec = json.loads(content) if isinstance(content, str) else dict(content)
            except (ValueError, TypeError) as exc:
                raise ValueError(f"patch-model 的内容不是合法 JSON: {exc}") from exc
            if mtstate.patch_config_file(dest, spec):
                written.append(rel)
            continue
        if dest.exists():
            if mode == "if-pristine":
                if not _is_pristine(rel, dest):
                    continue
            elif not mode:
                continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(str(content), encoding="utf-8")
        try:
            dest.chmod(0o600 if rel.endswith(".env") else 0o644)
        except OSError:
            pass
        written.append(rel)
    return written


async def _sync_bundled_skills() -> dict:
    """恢复用户目录之后、拉起 hermes 之前，按 hermes 自己的规则同步一遍自带技能。

    规则在 hermes 里（tools/skills_sync.py，skills/UNIWORK_BUNDLED_ONLY）：只发 UniWork 的内置技能；
    用户手里已经不再发行的，没改过的删掉、改过的移进 .retired-hermes/。容器启动时那一遍早于恢复，
    hermes serve 启动时又不同步，不在这里补一遍，归档里带回来的旧技能会原样留下。
    失败不挡 hermes 启动（技能只是锦上添花）：记日志，结果放进引导回包。"""
    env = dict(os.environ)
    env.update(_hermes_env)
    env["HERMES_HOME"] = str(HERMES_HOME)
    try:
        proc = await asyncio.create_subprocess_exec(
            HERMES_PYTHON, "-c", SKILLS_SYNC_SCRIPT,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(HERMES_INSTALL), env=env,
        )
    except OSError as exc:
        _log(f"技能同步没跑起来: {exc}")
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=SKILLS_SYNC_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        _log(f"技能同步超过 {int(SKILLS_SYNC_TIMEOUT_S)} 秒")
        return {"ok": False, "error": "timeout"}
    lines = out.decode("utf-8", "replace").strip().splitlines()
    try:
        report = json.loads(lines[-1]) if lines else {}
    except ValueError:
        report = {}
    if not isinstance(report, dict):
        report = {}
    if proc.returncode != 0:
        report.setdefault("error", err.decode("utf-8", "replace").strip()[-300:] or f"退出码 {proc.returncode}")
        _log(f"技能同步失败: {report['error']}")
    return {"ok": proc.returncode == 0, **report}


async def _configure_unisearch(env: dict[str, str]) -> None:
    """联网搜索的默认配置，和桌面每次启动时一样（apps/desktop/electron/entry_local/unisearch.ts）：
    只补用户没设过的项（搜索交给 unisearch、正文抓取用 builtin_parse），用户自己选的后端和停用都保留。
    失败不挡启动，沿用原有的搜索设置。Docker 后端的镜像没有这个插件，跳过。"""
    if not UNISEARCH_CONFIGURE.is_file():
        return
    # -c 让 /opt/hermes（cwd）进 sys.path，脚本才 import 得到 hermes；argv 和桌面调用时一样是「脚本 + HERMES_HOME」。
    proc = await asyncio.create_subprocess_exec(
        HERMES_PYTHON, "-c",
        "import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')",
        str(UNISEARCH_CONFIGURE), str(HERMES_HOME),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        cwd=str(HERMES_INSTALL), env={**env, "HERMES_HOME": str(HERMES_HOME)},
    )
    try:
        # null = 没有平台下发的搜索配置，只补默认值
        _, err = await asyncio.wait_for(proc.communicate(b"null"), timeout=UNISEARCH_CONFIGURE_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        _log(f"联网搜索配置超过 {int(UNISEARCH_CONFIGURE_TIMEOUT_S)} 秒，沿用现有设置")
        return
    if proc.returncode != 0:
        _log(f"联网搜索配置没写上，沿用现有设置: {err.decode('utf-8', 'replace').strip()[-300:]}")


async def _spawn_hermes(token: str) -> dict:
    """拉起 hermes，不等它就绪。返回各段用时（见 _Timing）。"""
    global _hermes_proc
    timing = _Timing()
    _connectors.profile_token = token
    if _connectors_on():
        try:
            await _connectors.restore()
        except (OSError, RuntimeError, ValueError):
            _log('连接器尚未恢复，后台将重试；其他实例功能继续启动。')
        timing.lap("connectors_start")
    env = dict(os.environ)
    env.update(_hermes_env)
    env["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    # hermes serve 只在桌面模式下自己起定时任务的调度线程（web_server.py 的
    # _start_desktop_cron_ticker）；实例里没有单独的 gateway 进程，不设它，用户建的定时任务
    # 永远停在「已排期」。它的其余作用逐个核过：清理桌面遗留的随机端口 serve（我们是固定端口，
    # 碰不到）、父进程看门狗（要 HERMES_PARENT_PID，我们不设）、新会话的来源记为 desktop。
    env["HERMES_DESKTOP"] = "1"
    if not _enterprise_mode:
        await _configure_unisearch(env)
        timing.lap("unisearch")
        recovery = await asyncio.create_subprocess_exec(
            HERMES_PYTHON, '-c',
            "import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1])['claim_all'](Path(sys.argv[2]))",
            str(HERMES_INSTALL / 'plugins/uniwork-kits/cloud_recovery.py'), str(HERMES_HOME),
            cwd=str(HERMES_INSTALL), env=env,
        )
        if await recovery.wait() != 0:
            raise RuntimeError('Cloud crash recovery preparation failed')
        timing.lap("recovery")
    _note_boot_homes()
    _hermes_proc = await asyncio.create_subprocess_exec(
        "hermes", "serve",
        "--host", "127.0.0.1",
        "--port", str(TARGET_PORT),
        "--skip-build",
        env=env,
    )
    timing.lap("hermes_exec")
    return timing.as_dict()


async def _stop_hermes(grace_s: float = 30.0) -> dict:
    """先 SIGTERM 等它自己退，超时再 SIGKILL。返回各段用时（见 _Timing），等满被强杀的记进 killed。"""
    timing = _Timing()
    await _messaging_gateway.stop()
    timing.lap("messaging_stop")
    await _connectors.close()
    timing.lap("connectors_stop")
    proc = _hermes_proc
    if proc is None or proc.returncode is not None:
        return timing.as_dict()
    try:
        proc.send_signal(signal.SIGTERM)
    except ProcessLookupError:
        return timing.as_dict()
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_s)
    except asyncio.TimeoutError:
        timing.killed.append("hermes")
        try:
            proc.kill()
        except ProcessLookupError:
            timing.lap("hermes_stop")
            return timing.as_dict()
        await proc.wait()
    timing.lap("hermes_stop")
    return timing.as_dict()


async def _supervise() -> None:
    """hermes 意外退出就带退避拉起来；drain 期间不管。"""
    global _hermes_restarts
    backoff = 1.0
    while True:
        proc = _hermes_proc
        if proc is None:
            await asyncio.sleep(1.0)
            continue
        started = time.monotonic()
        await proc.wait()
        if _draining:
            return
        if _reloading or proc is not _hermes_proc:
            # /__mt/reload 停掉了它，新进程由 _reload 自己拉起；等它换上来再接着看
            await asyncio.sleep(0.5)
            continue
        if time.monotonic() - started > 60:
            backoff = 1.0  # 稳定跑过一分钟，退避从头算
        _hermes_restarts += 1
        _log(f"hermes 退出（码 {proc.returncode}），{backoff:.0f}s 后第 {_hermes_restarts} 次拉起")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)
        if _draining:
            return
        try:
            await _spawn_hermes(_hermes_token)
        except Exception as exc:  # noqa: BLE001
            _log(f"拉起 hermes 失败: {type(exc).__name__}: {exc}")
            await asyncio.sleep(backoff)


def _enable_api_server() -> None:
    """服务实例才开：API key 写进 ``.env``。

    gateway 跑起来以后读平台密钥走 profile 的 secret scope，只认 ``HERMES_HOME/.env``，
    不认进程环境变量（10-27 实测：只放环境变量会报 No messaging platforms enabled）。
    """
    global _api_enabled, _api_key
    if not _api_key:
        _api_key = secrets.token_hex(32)
    env_file = HERMES_HOME / ".env"
    mtstate.env_upsert(env_file, [
        f"API_SERVER_KEY={_api_key}", "API_SERVER_HOST=127.0.0.1", f"API_SERVER_PORT={API_PORT}",
    ])
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        # Docker 路径转发器可能是 root：.env 要还给 hermes 的用户，不然它读不了自己的模型 key
        home = HERMES_HOME.stat()
        os.chown(env_file, home.st_uid, home.st_gid)
    _api_enabled = True


async def _spawn_gateway() -> None:
    global _gateway_proc
    env = dict(os.environ)
    env.update(_hermes_env)
    # 镜像带 s6：不加这个，gateway run 会把自己交给 s6 托管后立刻退出，这里的守护循环就会反复拉起、打断运行
    env["HERMES_GATEWAY_NO_SUPERVISE"] = "1"
    _gateway_proc = await asyncio.create_subprocess_exec("hermes", "gateway", "run", env=env)


async def _stop_gateway(grace_s: float = 30.0) -> dict:
    """同 _stop_hermes：先 SIGTERM，等满再 SIGKILL。返回用时，等满被强杀的记进 killed。"""
    timing = _Timing()
    proc = _gateway_proc
    if proc is None or proc.returncode is not None:
        return timing.as_dict()
    try:
        proc.send_signal(signal.SIGTERM)
    except ProcessLookupError:
        return timing.as_dict()
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_s)
    except asyncio.TimeoutError:
        timing.killed.append("gateway")
        try:
            proc.kill()
        except ProcessLookupError:
            timing.lap("gateway_stop")
            return timing.as_dict()
        await proc.wait()
    timing.lap("gateway_stop")
    return timing.as_dict()


async def _supervise_gateway() -> None:
    """服务实例里的 gateway 意外退出就带退避拉起来；drain 期间不管，reload 由 _reload 自己拉起。"""
    backoff = 1.0
    while True:
        proc = _gateway_proc
        if proc is None:
            await asyncio.sleep(1.0)
            continue
        started = time.monotonic()
        await proc.wait()
        if _draining:
            return
        if _reloading or proc is not _gateway_proc:
            await asyncio.sleep(0.5)
            continue
        if time.monotonic() - started > 60:
            backoff = 1.0
        _log(f"gateway 退出（码 {proc.returncode}），{backoff:.0f}s 后拉起")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)
        if _draining:
            return
        try:
            await _spawn_gateway()
        except Exception as exc:  # noqa: BLE001
            _log(f"拉起 gateway 失败: {type(exc).__name__}: {exc}")
            await asyncio.sleep(backoff)


async def _start_api_server() -> None:
    """打开 API 服务并拉起 gateway（重复调用只补拉没在跑的那部分）。"""
    global _gateway_task
    if not _api_enabled:
        _enable_api_server()
    if _gateway_proc is None or _gateway_proc.returncode is not None:
        await _spawn_gateway()
    if _gateway_task is None or _gateway_task.done():
        _gateway_task = asyncio.create_task(_supervise_gateway())


async def _archiver(interval_s: int) -> None:
    """定时归档循环。真正的打包在线程里跑，不占转发流量的事件循环。"""
    await asyncio.sleep(min(60, interval_s))  # 等 hermes 把技能同步、首次建库做完
    while True:
        try:
            await _do_archive(force=False)
        except mtstate.OwnerLost as exc:
            _log(f"{exc}；本实例已被接管，停止归档并停掉 hermes")
            await _fence()
            return
        except Exception as exc:  # noqa: BLE001
            _log(f"定时归档失败: {type(exc).__name__}: {exc}")
        await asyncio.sleep(interval_s)


async def _do_archive(force: bool) -> dict | None:
    assert _state is not None and _state_lock is not None
    async with _state_lock:
        manifest = await asyncio.to_thread(_state.archive, force)
    return manifest.summary() if manifest else None


async def _fence() -> None:
    """卷上的主人不是自己了：停 hermes、停归档，只留转发器应答状态。"""
    global _draining
    _draining = True
    _connectors.draining(True)
    await mtuser.close_all_terminals()
    await _stop_hermes()
    await _stop_gateway()


def _check_token(headers: dict[str, str]) -> bool:
    return bool(_hermes_token) and headers.get("x-mt-token", "") == _hermes_token


def _session_token() -> str:
    """给用户接口核对的令牌：沙箱路径是引导时送进来的；Docker 路径没有引导，容器环境变量里就有。"""
    return _hermes_token or os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")


def _user_authorized(headers: dict[str, str], query: dict[str, list[str]]) -> bool:
    """入口转发时带上的会话令牌：REST 在请求头里，WebSocket 在 ?token= 里（和 hermes 一样）。"""
    expected = _session_token()
    given = headers.get("x-hermes-session-token") or (query.get("token") or [""])[0]
    return bool(expected) and hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))


async def _activity() -> dict:
    """定时任务与对话回合忙不忙（见 mtstate.activity）。读文件和库放线程里；读不了不影响应答。

    读失败时没有 ``cron_next_at`` 这个键，入口就不改它记着的下次执行时间。
    """
    try:
        result = await asyncio.to_thread(mtstate.activity, HERMES_HOME)
    except Exception as exc:  # noqa: BLE001
        result = {"errors": [f"{type(exc).__name__}: {exc}"]}
    result['connectors_running'] = _connectors.busy()
    return result


async def _apply_at_boot(spec: dict) -> dict:
    """引导时、起 hermes 之前，按入口一起送来的清单装企业资源。和 /__mt/enterprise 装的一样，只是不用重启：
    hermes 还没起。

    下载限时（BOOT_FETCH_TIMEOUT_S、BOOT_FETCH_BUDGET_S）：平台不通也只多等几十秒，没装上的记进 errors，
    入口在启动后再送一次补上。返回给入口的摘要 ``{"ok", "errors", "changed"}``：``ok`` 为真，入口才把这份清单
    记成这台实例已装，启动后不再送。"""
    global _enterprise_lock
    if _enterprise_lock is None:
        _enterprise_lock = asyncio.Lock()
    async with _enterprise_lock:
        try:
            report = await asyncio.to_thread(mtent.apply, HERMES_HOME, spec, None,
                                             fetch_timeout_s=BOOT_FETCH_TIMEOUT_S, fetch_budget_s=BOOT_FETCH_BUDGET_S)
        except Exception as exc:  # noqa: BLE001 —— 装不上不挡启动
            error = str(exc) if isinstance(exc, mtent.EnterpriseError) else f"{type(exc).__name__}: {exc}"
            _log(f"引导时没装上企业资源，启动后再装：{error[:300]}")
            return {"ok": False, "errors": [error[:300]]}
    errors = [str(item) for item in report.get("errors") or []]
    if errors:
        _log(f"引导时企业资源有 {len(errors)} 项没装上，启动后再装：{'; '.join(errors)[:500]}")
    changed = {key: report[key] for key in ("profiles", "installed", "removed", "retired", "restored") if report.get(key)}
    return {"ok": not errors, "errors": errors[:20], "changed": changed}


async def _bootstrap(writer: asyncio.StreamWriter, body: bytes) -> None:
    """``POST /__mt/bootstrap`` —— 收令牌、种子文件和状态段，恢复、落盘、拉起 hermes。

    只认第一次，且只在启动后的窗口期内。沙箱只能经平台代理按 sandboxId 访问，
    而 sandboxId 只有入口知道（存在入口自己的库里），再加上这两道限制，
    「别人抢先引导」需要同时猜中 ID 并在几秒内赢得竞争。
    TODO: 平台若支持创建时注入一次性密钥，改成校验密钥，去掉这个时间窗。

    ``state`` 段（沙箱路径才有）::

        {"vol": "/mnt/u", "owner": "<本实例ID>", "epoch": 7, "restore_from": "<上一代实例ID或空>",
         "force": false, "archive_interval_s": 300}

    恢复失败**不算引导成功**：hermes 不会被拉起，``_bootstrapped`` 保持 False，入口可以
    带 force 重试，或者判定这台实例不可用。

    ``enterprise_spec``（企业版，入口手里有这个人的清单时才带）：起 hermes 之前装好企业资源，见 _apply_at_boot，
    结果放在回包的 ``enterprise``。回包的 ``timing`` 是各段用时（恢复、写种子、同步技能、装企业资源、起进程、等就绪）。
    """
    global _bootstrapped, _boot_lock, _state, _state_lock, _archiver_task, _supervisor_task, _hermes_token, _enterprise_mode
    global _enterprise_features
    if _boot_lock is None:
        _boot_lock = asyncio.Lock()
        _state_lock = asyncio.Lock()

    async with _boot_lock:
        if _bootstrapped:
            _reply(writer, 409, {"ok": False, "error": "已经引导过了"})
            return
        if time.monotonic() - _START_TS > BOOTSTRAP_WINDOW_S:
            _reply(writer, 403, {"ok": False, "error": "引导窗口已关闭"})
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 400, {"ok": False, "error": f"载荷不是合法 JSON: {exc}"})
            return

        token = str(payload.get("token", "")).strip()
        if not token:
            _reply(writer, 400, {"ok": False, "error": "缺少 token"})
            return

        timing = _Timing()
        report: dict = {}
        state = payload.get("state") or None
        if state:
            try:
                vol = Path(str(state.get("vol", "/mnt/u")))
                owner = str(state.get("owner", "")).strip()
                epoch = int(state.get("epoch", 0))
                if not owner or epoch <= 0:
                    raise ValueError("state 段缺 owner 或 epoch")
                mgr = mtstate.StateManager(HERMES_HOME, vol, owner, epoch,
                                           vol_wait_s=float(os.environ.get("MT_VOL_WAIT_S", "90")))
                # 顺序：恢复上一代的归档 → 配置迁移 → 目录链接 → 主人标记；
                # 种子文件在这之后由 _write_seed 按顺序落：config.yaml(if-pristine) →
                # 平台行 patch → .env 逐行 upsert。恢复回来的用户配置因此不会被整份覆盖。
                rep = await asyncio.to_thread(
                    mgr.prepare,
                    str(state.get("restore_from", "") or ""),
                    bool(state.get("force", False)),
                    None,
                    None,
                    None,
                    bool(state.get("migrate", True)),
                )
                report = rep.as_dict()
                _state = mgr
                _hermes_env["HERMES_WRITE_SAFE_ROOT"] = f"{HERMES_HOME}{os.pathsep}{vol / 'workspace'}"
                timing.lap("restore")
            except mtstate.RefuseStart as exc:
                _reply(writer, 409, {"ok": False, "error": str(exc), "refused": True})
                return
            except Exception as exc:  # noqa: BLE001
                _reply(writer, 500, {"ok": False, "error": f"恢复失败: {type(exc).__name__}: {exc}"})
                return

        try:
            written = _write_seed(list(payload.get("files") or []))
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 400, {"ok": False, "error": f"写种子文件失败: {exc}"})
            return

        # 企业版开放的个人版功能，连接器要用：先记下来（老入口不送这一项，企业版就当都没开）
        if isinstance(payload.get("features"), list):
            _enterprise_features = {str(item) for item in payload["features"] if item}
        enterprise = _enterprise_mode or bool(payload.get("enterprise"))

        # 连接器状态以入口库里那份为准（见 mtconnector_state）：运行时还没起，先把它装回去。
        # 装不上就沿用归档恢复出来的那份，不挡启动。
        if payload.get("connectors") and (not enterprise or "connectors" in _enterprise_features):
            try:
                adopted = _connectors.adopt(list(payload["connectors"]))
                if adopted:
                    _log(f"连接器状态按入口库恢复: {', '.join(adopted)}")
            except (KeyError, TypeError, ValueError, OSError, sqlite3.Error) as exc:
                _log(f"连接器状态没装上，沿用归档里的: {type(exc).__name__}")
        timing.lap("seed")

        # 用户目录已经从上一代恢复：这时再按发行规则同步自带技能，见 _sync_bundled_skills。
        skills = await _sync_bundled_skills()
        timing.lap("skills")

        # 企业资源（Agent 档案、技能、连接器、知识检索、工具开关）在起 hermes 之前装好：hermes 只在启动时连 MCP、
        # 决定托管几个 profile，装在启动之后就得再重启一次（11-10 真机：平台运行环境重建一次多 38 秒）。
        # 装不上不挡启动，照常起 hermes；入口看回包里的 enterprise，没装全就启动后再送一次。老入口不送这一项。
        boot_enterprise = None
        if isinstance(payload.get("enterprise_spec"), dict):
            boot_enterprise = await _apply_at_boot(payload["enterprise_spec"])
            timing.lap("enterprise")

        _hermes_token = token
        _enterprise_mode = _enterprise_mode or bool(payload.get("enterprise"))
        try:
            timing.merge(await _spawn_hermes(token))
            if payload.get("api_server"):
                await _start_api_server()
                timing.lap("gateway_start")
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 500,
                   {"ok": False, "error": f"拉起 hermes 失败: {type(exc).__name__}: {exc}"})
            return

        _bootstrapped = True
        _supervisor_task = asyncio.create_task(_supervise())
        if _state is not None:
            interval = int((state or {}).get("archive_interval_s") or ARCHIVE_INTERVAL_S)
            _archiver_task = asyncio.create_task(_archiver(max(30, interval)))

    # 等 hermes 真正开始监听，好让入口一收到 200 就能直接转发。
    deadline = time.monotonic() + float(payload.get("ready_timeout_s", 180))
    extra = {"enterprise": boot_enterprise} if boot_enterprise is not None else {}
    while time.monotonic() < deadline:
        if await _ready():
            timing.lap("ready")
            reply = {"ok": True, "hermes": True, "written": written, "state": report, **extra,
                     "timing": timing.as_dict()}
            if _api_enabled:
                reply["api"] = True
            if skills is not None:
                reply["skills"] = skills
            _reply(writer, 200, reply)
            return
        if _hermes_proc is not None and _hermes_proc.returncode is not None:
            timing.lap("ready")
            _reply(writer, 500, {
                "ok": False,
                "error": f"hermes 启动后立刻退出，退出码 {_hermes_proc.returncode}",
                "written": written,
                "state": report,
                "timing": timing.as_dict(),
            })
            return
        await asyncio.sleep(0.5)
    timing.lap("ready")
    _reply(writer, 503, {"ok": False, "error": "hermes 未在超时内就绪", "written": written, "state": report,
                         "timing": timing.as_dict()})


async def _sync(writer: asyncio.StreamWriter) -> None:
    """``POST /__mt/sync`` —— 立即归档一次。入口在暂停前调。"""
    if _state is None:
        _reply(writer, 400, {"ok": False, "error": "这台实例没有状态管家（没有 state 段引导）"})
        return
    try:
        summary = await _do_archive(force=True)
    except mtstate.OwnerLost as exc:
        await _fence()
        _reply(writer, 409, {"ok": False, "error": str(exc), "fenced": True})
        return
    except Exception as exc:  # noqa: BLE001
        _reply(writer, 500, {"ok": False, "error": f"归档失败: {type(exc).__name__}: {exc}"})
        return
    _reply(writer, 200, {"ok": True, "archive": summary, "activity": await _activity()})


async def _drain(writer: asyncio.StreamWriter) -> None:
    """``POST /__mt/drain`` —— 停 hermes → 最终归档 → 停后台任务。之后这台实例可以删。

    可以重复调：已经排空就把上次的结果再返回一遍。
    """
    global _draining, _drained
    if _state is None:
        _reply(writer, 400, {"ok": False, "error": "这台实例没有状态管家（没有 state 段引导）"})
        return
    if _drained is not None:
        _reply(writer, 200, dict(_drained, already=True))
        return
    _connectors.draining(True)
    if _connectors.busy() or mtstate.kits_activity(HERMES_HOME):
        _connectors.draining(False)
        _reply(writer, 409, {"ok": False, "error": "套件安装或连接器调用正在进行，请等待完成后重试排空。"})
        return
    _draining = True
    _state.phase = "draining"
    if _archiver_task is not None:
        _archiver_task.cancel()
    timing = _Timing()
    await mtuser.close_all_terminals()
    timing.lap("terminals")
    timing.merge(await _stop_hermes())
    timing.merge(await _stop_gateway())
    try:
        summary = await _do_archive(force=True)
    except mtstate.OwnerLost as exc:
        _state.phase = "fenced"
        _reply(writer, 409, {"ok": False, "error": str(exc), "fenced": True})
        return
    except Exception as exc:  # noqa: BLE001
        _state.phase = "drain_failed"
        timing.lap("archive")
        _reply(writer, 500, {"ok": False, "error": f"最终归档失败: {type(exc).__name__}: {exc}",
                             "hermes_stopped": True, "timing": timing.as_dict()})
        return
    timing.lap("archive")
    _state.phase = "drained"
    # hermes 已停，jobs.json 不会再变：这里报的下次执行时间就是入口叫醒下一台实例的依据。
    _drained = {"ok": True, "archive": summary, "activity": await _activity(), "timing": timing.as_dict()}
    _reply(writer, 200, _drained)


async def _reload(writer: asyncio.StreamWriter, body: bytes) -> None:
    """``POST /__mt/reload`` —— 按入口送来的种子文件重写配置，再重启 hermes。

    hermes 只在启动时读 config.yaml，连 MCP 时把地址里的 ``${KEY}`` 展开成当时的值：换了 key
    （企业模式每次登录都换设备令牌）或平台下发的模型、MCP 变了，只改文件、只换环境变量都不够，
    要重启 hermes 才生效。种子文件和引导时同一种格式（见 _write_seed）。
    对话回合、定时任务在跑时要不要等，由入口先问 /__mt/status 再决定；这里不判断。
    """
    global _reloading, _reload_lock
    if not _bootstrapped or _draining:
        _reply(writer, 409, {"ok": False, "error": "实例没有引导过，或正在排空"})
        return
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
        files = list(payload.get("files") or [])
    except Exception as exc:  # noqa: BLE001
        _reply(writer, 400, {"ok": False, "error": f"载荷不是合法 JSON: {exc}"})
        return
    if _reload_lock is None:
        _reload_lock = asyncio.Lock()
    async with _reload_lock:
        timing = _Timing()
        try:
            written = _write_seed(files)
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 400, {"ok": False, "error": f"写种子文件失败: {exc}"})
            return
        timing.lap("seed")
        # 换了设备令牌：Agent 的托管 profile 也一起换（它们各有一份 .env）
        await asyncio.to_thread(_sync_tokens_quietly)
        timing.lap("tokens")
        _reloading = True
        try:
            timing.merge(await _stop_hermes())
            timing.merge(await _stop_gateway())
            timing.merge(await _spawn_hermes(_hermes_token))
            if _api_enabled:
                await _spawn_gateway()
                timing.lap("gateway_start")
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 500, {"ok": False, "error": f"重启 hermes 失败: {type(exc).__name__}: {exc}",
                                 "written": written, "timing": timing.as_dict()})
            return
        finally:
            _reloading = False
    _log(f"按入口的要求重新加载：写了 {written or '（无变化）'}，hermes 已重启")
    deadline = time.monotonic() + float(payload.get("ready_timeout_s", 120))
    while time.monotonic() < deadline:
        if await _ready():
            timing.lap("ready")
            _reply(writer, 200, {"ok": True, "hermes": True, "written": written,
                                 **({"api": True} if _api_enabled else {}), "timing": timing.as_dict()})
            return
        if _hermes_proc is not None and _hermes_proc.returncode is not None:
            timing.lap("ready")
            _reply(writer, 500, {"ok": False, "error": f"hermes 重启后立刻退出，退出码 {_hermes_proc.returncode}",
                                 "written": written, "timing": timing.as_dict()})
            return
        await asyncio.sleep(0.5)
    timing.lap("ready")
    _reply(writer, 503, {"ok": False, "error": "hermes 未在超时内就绪", "written": written,
                         "timing": timing.as_dict()})


def _note_boot_homes() -> None:
    global _boot_homes
    try:
        _boot_homes = len(mtstate.hermes_homes(HERMES_HOME))
    except Exception:  # noqa: BLE001
        _boot_homes = 0


def _sync_tokens_quietly() -> list[str]:
    try:
        return mtent.sync_tokens(HERMES_HOME, mtent.token_env_of(HERMES_HOME))
    except Exception as exc:  # noqa: BLE001
        _log(f"同步托管 profile 的令牌失败: {type(exc).__name__}: {exc}")
        return []


def _sync_plugins_quietly() -> list[str]:
    try:
        return mtent.sync_plugins(HERMES_HOME)
    except Exception as exc:  # noqa: BLE001
        _log(f"检查企业对接插件的启用失败: {type(exc).__name__}: {exc}")
        return []


def _env_mtime() -> float:
    try:
        return (HERMES_HOME / ".env").stat().st_mtime
    except OSError:
        return 0.0


async def _token_follower() -> None:
    """把默认 profile 的设备令牌同步给其他 profile（Agent 的托管 profile、员工自建的机器人）。

    Docker 路径换令牌走 hermes 的 /api/env，只改默认 profile 的 .env；沙箱路径换令牌走 /__mt/reload，那里会当场同步。
    这里看着默认 profile 的 .env：一变就同步，重新登录后紧接着用 Agent 聊天也不会拿旧令牌；另外每分钟兜底一次。
    兜底时顺带检查各 profile 都启用了企业对接插件（mtent.sync_plugins）。"""
    seen = _env_mtime()
    since_full = 0.0
    while True:
        await asyncio.sleep(TOKEN_WATCH_INTERVAL_S)
        since_full += TOKEN_WATCH_INTERVAL_S
        mtime = _env_mtime()
        if mtime == seen and since_full < TOKEN_SYNC_INTERVAL_S:
            continue
        seen, since_full = mtime, 0.0
        changed = await asyncio.to_thread(_sync_tokens_quietly)
        if changed:
            _log(f"其他 profile 的设备令牌已跟上：{', '.join(changed)}")
        enabled = await asyncio.to_thread(_sync_plugins_quietly)
        if enabled:
            _log(f"企业对接插件已在这些 profile 启用，hermes 下次重启后加载：{', '.join(enabled)}")


async def _enterprise(writer: asyncio.StreamWriter, body: bytes) -> None:
    """``POST /__mt/enterprise`` —— 按入口算好的清单装企业资源（Agent 的托管 profile、技能、连接器、企业经验）。

    载荷 ``{"spec": {...}, "restart": bool}``，格式见 mtent.apply。要下载的包由这里用设备令牌从企业管理平台取。
    人设、技能、模型这些 hermes 下一轮对话就会读到；有两种情况要重启 hermes 才完全生效：
    第一次装出 Agent 的 profile（hermes 启动时只有一个 profile，没按托管多个 profile 启动），以及 MCP 变了（只在启动时连）。
    ``restart`` 为真、实例又不忙（没有对话回合、定时任务在跑）时，沙箱路径就地重启；忙就记下，下次送清单时再重启。
    Docker 路径的 hermes 是容器的主进程，这里重启不了，回 ``restart_needed`` 由入口重启容器。
    """
    global _enterprise_lock, _restart_pending, _reloading
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
        spec = payload.get("spec")
        if not isinstance(spec, dict):
            raise ValueError("缺少 spec")
    except Exception as exc:  # noqa: BLE001
        _reply(writer, 400, {"ok": False, "error": f"载荷不合法: {exc}"})
        return
    if _enterprise_lock is None:
        _enterprise_lock = asyncio.Lock()
    async with _enterprise_lock:
        timing = _Timing()
        try:
            report = await asyncio.to_thread(mtent.apply, HERMES_HOME, spec)
        except mtent.EnterpriseError as exc:
            _reply(writer, 400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 500, {"ok": False, "error": f"安装企业资源失败: {type(exc).__name__}: {exc}"})
            return
        timing.lap("apply")
        homes = len(await asyncio.to_thread(mtstate.hermes_homes, HERMES_HOME))
        if report.get("mcp_changed") or (homes >= 2 and _boot_homes < 2):
            _restart_pending = True
        activity = await _activity()
        busy = bool(activity.get("turns") or activity.get("cron_running"))
        restarted = False
        if _restart_pending and payload.get("restart") and not busy and _bootstrapped and not _draining:
            _reloading = True
            try:
                timing.merge(await _stop_hermes())
                timing.merge(await _stop_gateway())
                timing.merge(await _spawn_hermes(_hermes_token))
                if _api_enabled:
                    await _spawn_gateway()
                    timing.lap("gateway_start")
            finally:
                _reloading = False
            _restart_pending = False
            restarted = True
            _log("企业资源有变化，hermes 已重启")
    if report.get("errors"):
        _log(f"企业资源有 {len(report['errors'])} 项没装上：{'; '.join(report['errors'])[:500]}")
    if restarted:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not await _ready():
            await asyncio.sleep(0.5)
        timing.lap("ready")
    _reply(writer, 200, {"ok": True, "report": report, "restarted": restarted, "busy": busy,
                         "restart_needed": _restart_pending, "timing": timing.as_dict()})


async def _resume(writer: asyncio.StreamWriter) -> None:
    """``POST /__mt/resume`` —— 撤回 drain：重新拉起 hermes 和归档循环。"""
    global _draining, _drained, _archiver_task, _supervisor_task
    if _state is None or not _bootstrapped:
        _reply(writer, 400, {"ok": False, "error": "没有可撤回的 drain"})
        return
    if _state.phase == "fenced":
        _reply(writer, 409, {"ok": False, "error": "本实例已被新实例接管，不能重新启动"})
        return
    _draining = False
    _drained = None
    if _hermes_proc is None or _hermes_proc.returncode is not None:
        try:
            await _spawn_hermes(_hermes_token)
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 500, {"ok": False, "error": f"拉起 hermes 失败: {type(exc).__name__}: {exc}"})
            return
    if _api_enabled:
        try:
            await _start_api_server()
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 500, {"ok": False, "error": f"拉起 gateway 失败: {type(exc).__name__}: {exc}"})
            return
    if _supervisor_task is None or _supervisor_task.done():
        _supervisor_task = asyncio.create_task(_supervise())
    if _archiver_task is None or _archiver_task.done():
        _archiver_task = asyncio.create_task(_archiver(ARCHIVE_INTERVAL_S))
    _connectors.draining(False)
    _state.phase = "ready"
    _reply(writer, 200, {"ok": True})


# ---------------------------------------------------------------- 请求分发

async def _read_head(reader: asyncio.StreamReader) -> bytes | None:
    """读到空行为止，返回含空行的全部字节；超限或断开返回 None。"""
    buf = bytearray()
    while b"\r\n\r\n" not in buf:
        if len(buf) > MAX_HEAD:
            return None
        try:
            chunk = await reader.read(CHUNK)
        except Exception:  # noqa: BLE001
            return None
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _close_after(head: bytes) -> bytes:
    """把请求头里的 Connection / Keep-Alive 换成 ``Connection: close``，已经读进来的请求体原样接在后面。"""
    raw_head, _, rest = head.partition(b"\r\n\r\n")
    lines = raw_head.split(b"\r\n")
    kept = [lines[0]] + [
        line for line in lines[1:]
        if line.split(b":", 1)[0].strip().lower() not in (b"connection", b"keep-alive")
    ]
    kept.append(b"Connection: close")
    return b"\r\n".join(kept) + b"\r\n\r\n" + rest


def _parse(head: bytes) -> tuple[str, str, dict[str, str], bytes]:
    raw_head, _, rest = head.partition(b"\r\n\r\n")
    lines = raw_head.split(b"\r\n")
    parts = lines[0].decode("latin-1").split(" ")
    method = parts[0] if parts else ""
    path = parts[1] if len(parts) > 1 else ""
    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, sep, value = line.decode("latin-1").partition(":")
        if sep:
            headers[name.strip().lower()] = value.strip()
    return method, path, headers, rest


async def _read_body(headers: dict[str, str], rest: bytes, reader: asyncio.StreamReader,
                     max_bytes: int = MAX_BODY) -> bytes | None:
    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        return None
    if length < 0 or length > max_bytes or len(rest) > length:
        return None
    body = bytearray(rest)
    while len(body) < length:
        chunk = await reader.read(min(CHUNK, length - len(body)))
        if not chunk:
            break
        body.extend(chunk)
    return bytes(body)


async def _handle_mt(
    method: str, path: str, headers: dict[str, str],
    rest: bytes, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
) -> None:
    route = path.split("?", 1)[0]

    if route == '/__mt/refresh-plan':
        if method != 'POST' or not _check_token(headers) or _draining:
            _reply(writer,403,{'ok':False})
            return
        try:
            data = json.loads(await _read_body(headers,rest,reader))
            spec = data['spec']
            if not isinstance(spec,dict): raise ValueError()
            mtstate.patch_config_file(HERMES_HOME / 'config.yaml', spec)
            _reply(writer,200,{'ok':True})
        except (ValueError,KeyError,OSError):
            _reply(writer,400,{'ok':False,'error':'Invalid plan update'})
        return

    if route == '/__mt/connectors':
        if method != 'POST' or not _user_authorized(headers, {}) or _draining:
            _reply(writer, 403, {'error': 'Connector management unavailable'})
            return
        try:
            raw = await asyncio.wait_for(_read_body(headers, rest, reader, 32768), 15)
            result = await _connectors.request(json.loads(raw))
            _reply(writer, 200, result)
        except (ValueError, TypeError, OSError, RuntimeError, asyncio.TimeoutError):
            _reply(writer, 409, {'error': '连接器请求失败，请检查配置和状态后重试。'})
        return

    if route == '/__mt/messaging/relay':
        if method != 'GET' or headers.get('upgrade','').lower() != 'websocket' or not _check_token(headers) or _draining or not _messaging_gateway.settings:
            _reply(writer,403,{'ok':False})
            return
        target_r, target_w = await asyncio.open_connection('127.0.0.1',_messaging_gateway.port)
        # Fixed target only. Cookie/session-token access cannot enter this management path.
        head = f'GET /__mt/messaging/relay HTTP/1.1\r\n' + ''.join(
            f'{key}: {value}\r\n' for key,value in headers.items()
            if key not in {'x-mt-token','cookie','host'}) + f'Host: 127.0.0.1:{_messaging_gateway.port}\r\n\r\n'
        target_w.write(head.encode()+rest)
        await target_w.drain()
        await asyncio.gather(_pipe(reader,target_w),_pipe(target_r,writer))
        return

    if route == '/__mt/messaging/start':
        if method != 'POST' or not _check_token(headers) or _draining:
            _reply(writer,403,{'ok':False})
            return
        try:
            data = json.loads(await _read_body(headers,rest,reader))
            required = ('user_id','instance_epoch','upgrade_secret','bot_id','revision','platform','binding_id','transport')
            if not isinstance(data,dict) or not set(required).issubset(data) or set(data)-set(required) or data['transport']!='entry-forward-relay-v1': raise ValueError()
            env = dict(os.environ)
            env.update(_hermes_env)
            env['HERMES_HOME'] = str(HERMES_HOME)
            env['HERMES_DASHBOARD_SESSION_TOKEN'] = _hermes_token
            result = await _messaging_gateway.start(data,env)
            _reply(writer,200,result)
        except (ValueError,TypeError,RuntimeError,OSError,asyncio.TimeoutError):
            _reply(writer,409,{'ok':False,'error':'relay gateway start failed'})
        return

    if route == "/__mt/health":
        # 平台的就绪探针打这里。转发器活着就算就绪 —— 不等 hermes，
        # 这样模板快照能早做、冷启动更快。
        _reply(writer, 200, {"ok": True, "hermes": await _hermes_alive(),
                             "bootstrapped": _bootstrapped})
        return

    if route == "/__mt/status":
        left = BOOTSTRAP_WINDOW_S - (time.monotonic() - _START_TS)
        _reply(writer, 200, {
            "ok": True,
            "hermes": await _hermes_alive(),
            "api": (await _port_alive(API_PORT)) if _api_enabled else None,
            "bootstrapped": _bootstrapped,
            "draining": _draining,
            "hermes_restarts": _hermes_restarts,
            "uptime_s": round(time.monotonic() - _START_TS, 1),
            "boot_window_left_s": max(0, round(left)),
            "state": _state.status() if _state is not None else None,
            "activity": await _activity() if _bootstrapped else None,
        })
        return

    if route == "/__mt/bootstrap":
        if method != "POST":
            _reply(writer, 400, {"ok": False, "error": "只接受 POST"})
            return
        body = await _read_body(headers, rest, reader)
        if body is None:
            _reply(writer, 400, {"ok": False, "error": "Content-Length 非法或载荷过大"})
            return
        await _bootstrap(writer, body)
        return

    if route == "/__mt/reload":
        if method != "POST":
            _reply(writer, 400, {"ok": False, "error": "只接受 POST"})
            return
        if not _check_token(headers):
            _reply(writer, 403, {"ok": False, "error": "缺少或错误的实例令牌"})
            return
        body = await _read_body(headers, rest, reader)
        if body is None:
            _reply(writer, 400, {"ok": False, "error": "Content-Length 非法或载荷过大"})
            return
        await _reload(writer, body)
        return

    if route == "/__mt/enterprise":
        # 两条路径都要能用：沙箱路径的令牌是引导时送来的，Docker 路径没有引导，令牌在容器环境变量里
        expected = _session_token()
        given = headers.get("x-mt-token", "")
        if method != "POST":
            _reply(writer, 400, {"ok": False, "error": "只接受 POST"})
            return
        if not expected or not hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8")):
            _reply(writer, 403, {"ok": False, "error": "缺少或错误的实例令牌"})
            return
        if _draining:
            _reply(writer, 409, {"ok": False, "error": "实例正在排空"})
            return
        body = await _read_body(headers, rest, reader)
        if body is None:
            _reply(writer, 400, {"ok": False, "error": "Content-Length 非法或载荷过大"})
            return
        await _enterprise(writer, body)
        return

    if route in ("/__mt/sync", "/__mt/drain", "/__mt/resume"):
        if method != "POST":
            _reply(writer, 400, {"ok": False, "error": "只接受 POST"})
            return
        if not _check_token(headers):
            _reply(writer, 403, {"ok": False, "error": "缺少或错误的实例令牌"})
            return
        await _read_body(headers, rest, reader)
        if route == "/__mt/sync":
            await _sync(writer)
        elif route == "/__mt/drain":
            await _drain(writer)
        else:
            await _resume(writer)
        return

    _reply(writer, 400, {"ok": False, "error": f"未知接口 {route}"})


# ---------------------------------------------------------------- 给用户用的接口（/__mt_user/*）

_conversation_folders = mtfolders.ConversationFolders(WORKSPACE)

_FILE_OPS = {
    "/__mt_user/files/conversation-create": lambda files, body: {"path": _conversation_folders.create(body.get("defaultCwd"))},
    "/__mt_user/files/conversation-discard": lambda files, body: _conversation_folders.discard(body.get("path")) or {},
    "/__mt_user/files/rename": lambda files, body: files.rename(body.get("path"), body.get("new_name")),
    "/__mt_user/files/trash": lambda files, body: files.move_to_trash(body.get("path")),
    "/__mt_user/files/restore": lambda files, body: files.restore(body.get("id")),
}

_office: mtuser.OfficePreview | None = None
_export_lock: asyncio.Lock | None = None
_OFFICE_ROUTES = (
    "/__mt_user/office-pdf", "/__mt_user/office-preview", "/__mt_user/office-preview/page",
    "/__mt_user/office-sheet", "/__mt_user/office-sheet/image",
)


def _office_preview() -> mtuser.OfficePreview:
    """整个转发器共用一个：同一时间只转一个文件，同一个文件只转一次。"""
    global _office
    if _office is None:
        _office = mtuser.OfficePreview(WORKSPACE)
    return _office


async def _send_file(writer: asyncio.StreamWriter, path: Path, content_type: str,
                     cache_control: str = "no-store") -> None:
    """整份文件作为 200 的响应体发出去。浏览器中途断开就算了。"""
    with path.open("rb") as fh:
        size = os.fstat(fh.fileno()).st_size
        writer.write((
            "HTTP/1.1 200 OK\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {size}\r\n"
            f"Cache-Control: {cache_control}\r\n"
            "X-Content-Type-Options: nosniff\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii"))
        try:
            while True:
                chunk = await asyncio.to_thread(fh.read, 1 << 20)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass


async def _handle_user(
    method: str, path: str, headers: dict[str, str],
    rest: bytes, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
) -> None:
    """命令行通道（WebSocket）、回收站、重命名、Office 预览。都要会话令牌；实例在排空时一律 503。"""
    route, _, raw_query = path.partition("?")
    query = parse_qs(raw_query)
    if _draining:
        _reply(writer, 503, {"ok": False, "code": "draining", "error": "实例正在排空"})
        return
    if not _user_authorized(headers, query):
        _reply(writer, 403, {"ok": False, "code": "forbidden", "error": "缺少或错误的会话令牌"})
        return

    if route == "/__mt_user/terminal":
        await mtuser.serve_terminal(reader, writer, headers, query, WORKSPACE)
        return

    if route == "/__mt_user/preview-export":
        global _export_lock
        if method != 'POST' or not headers.get('content-type', '').lower().startswith('application/json'):
            _reply(writer, 415, {'ok': False, 'code': 'invalid_export'})
            return
        if _export_lock is None:
            _export_lock = asyncio.Lock()
        if _export_lock.locked():
            _reply(writer, 429, {'ok': False, 'code': 'export_busy'})
            return
        async with _export_lock:
            try:
                raw = await asyncio.wait_for(_read_body(headers, rest, reader, 10 * 1024 * 1024), 15)
                data = json.loads(raw.decode('utf-8')) if raw is not None else None
                if not isinstance(data, dict) or not isinstance(data.get('content'), str):
                    raise ValueError()
                async with mtexport.pdf(data['content'], HERMES_PYTHON) as output:
                    await _send_file(writer, output, 'application/pdf')
            except (ValueError, UnicodeError, mtexport.ExportError, OSError, asyncio.TimeoutError):
                _reply(writer, 422, {'ok': False, 'code': 'export_failed'})
        return

    files = mtuser.Files(WORKSPACE)
    try:
        if route in _OFFICE_ROUTES:
            if method != "GET":
                _reply(writer, 405, {"ok": False, "code": "method", "error": "只接受 GET"})
                return
            office, target = _office_preview(), (query.get("path") or [""])[0]
            if route == "/__mt_user/office-pdf":
                await _send_file(writer, await office.pdf(target), "application/pdf")
            elif route == "/__mt_user/office-preview":
                _reply(writer, 200, {"ok": True, **await office.info(target)})
            elif route == "/__mt_user/office-sheet":
                await _send_file(writer, await office.sheet(target), "application/json; charset=utf-8")
            else:
                # 每页的图、表格里的图表：地址里带着版本号（文件一改就变），版本对得上的可以让浏览器缓存一天。
                if route == "/__mt_user/office-preview/page":
                    version, image = await office.page(target, (query.get("n") or [""])[0])
                    content_type = "image/jpeg"
                else:
                    version, image, content_type = await office.sheet_image(target, (query.get("name") or [""])[0])
                fresh = (query.get("v") or [""])[0] == version
                await _send_file(writer, image, content_type, "private, max-age=86400" if fresh else "no-store")
            return
        if route == "/__mt_user/trash":
            if method != "GET":
                _reply(writer, 405, {"ok": False, "code": "method", "error": "只接受 GET"})
                return
            _reply(writer, 200, {"ok": True, "items": await asyncio.to_thread(files.list_trash)})
            return
        op = _FILE_OPS.get(route)
        if op is None:
            _reply(writer, 404, {"ok": False, "code": "unknown", "error": f"未知接口 {route}"})
            return
        if method != "POST":
            _reply(writer, 405, {"ok": False, "code": "method", "error": "只接受 POST"})
            return
        # 只收 JSON：表单这类「简单请求」不经预检就能跨源发出来，挡掉它们就挡掉了借登录态的跨站提交。
        if not headers.get("content-type", "").lower().startswith("application/json"):
            _reply(writer, 415, {"ok": False, "code": "content_type", "error": "请求体要是 JSON"})
            return
        body = await _read_body(headers, rest, reader)
        if body is None:
            _reply(writer, 413, {"ok": False, "code": "too_large", "error": "请求体过大"})
            return
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except ValueError:
            payload = None
        if not isinstance(payload, dict):
            _reply(writer, 400, {"ok": False, "code": "invalid", "error": "请求体不是 JSON 对象"})
            return
        result = await asyncio.to_thread(op, files, payload)
        _reply(writer, 200, {"ok": True, **result})
    except mtuser.FileError as exc:
        _reply(writer, exc.status, {"ok": False, "code": exc.code, "error": exc.message})
    except OSError as exc:
        _log(f"{route} 失败: {type(exc).__name__}: {exc}")
        _reply(writer, 500, {"ok": False, "code": "io", "error": f"{type(exc).__name__}: {exc.strerror or exc}"})


async def _trash_janitor() -> None:
    """回收站里放了超过保留期（默认 7 天）的东西，每小时清一次。卷还没挂好、没有回收站目录都不算错。"""
    await asyncio.sleep(600)
    while True:
        try:
            removed = await asyncio.to_thread(mtuser.Files(WORKSPACE).purge)
            if removed:
                _log(f"回收站清掉 {removed} 项过期内容")
        except Exception as exc:  # noqa: BLE001
            _log(f"清理回收站失败: {type(exc).__name__}: {exc}")
        await asyncio.sleep(TRASH_PURGE_INTERVAL_S)


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:  # noqa: BLE001 — 任一端断开都结束
        pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


def _api_head(head: bytes) -> bytes:
    """``/__mt/api/v1/runs…`` 改成 ``/v1/runs…``；去掉实例令牌和调用方自己的鉴权，换成实例里的 API key。"""
    raw_head, _, rest = head.partition(b"\r\n\r\n")
    lines = raw_head.split(b"\r\n")
    method, target, version = lines[0].split(b" ", 2)
    target = b"/" + target[len(API_PREFIX):]
    drop = (b"connection", b"keep-alive", b"x-mt-token", b"authorization", b"host")
    kept = [b" ".join((method, target, version))] + [
        line for line in lines[1:] if line.split(b":", 1)[0].strip().lower() not in drop
    ]
    kept += [f"Host: 127.0.0.1:{API_PORT}".encode(), f"Authorization: Bearer {_api_key}".encode(),
             b"Connection: close"]
    return b"\r\n".join(kept) + b"\r\n\r\n" + rest


async def _proxy_api(headers: dict[str, str], head: bytes, client_r: asyncio.StreamReader,
                     client_w: asyncio.StreamWriter) -> None:
    """``/__mt/api/*`` —— 服务实例里 gateway 的 API 服务，只给入口用（要实例令牌）。"""
    expected = _session_token()
    given = headers.get("x-mt-token", "")
    if not (expected and hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))):
        status, payload = 403, {"ok": False, "error": "缺少或错误的实例令牌"}
    elif not _api_enabled:
        status, payload = 404, {"ok": False, "error": "这台实例没有开 API 服务"}
    elif _draining:
        status, payload = 503, {"ok": False, "error": "实例正在排空", "draining": True}
    else:
        try:
            target_r, target_w = await asyncio.open_connection("127.0.0.1", API_PORT)
        except Exception:  # noqa: BLE001 — gateway 还没起来
            status, payload = 503, {"ok": False, "error": "API 服务尚未就绪"}
        else:
            target_w.write(_api_head(head))
            await target_w.drain()
            await asyncio.gather(_pipe(client_r, target_w), _pipe(target_r, client_w))
            return
    _reply(client_w, status, payload)
    try:
        await client_w.drain()
    except Exception:  # noqa: BLE001
        pass
    client_w.close()


async def _handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    try:
        head = await _read_head(client_r)
        if head is None:
            client_w.close()
            return

        method, path, headers, rest = _parse(head)
        if path.startswith(API_PREFIX):
            await _proxy_api(headers, head, client_r, client_w)
            return
        if path.startswith("/__mt/") or path.startswith(USER_PREFIX):
            handler = _handle_mt if path.startswith("/__mt/") else _handle_user
            try:
                await handler(method, path, headers, rest, client_r, client_w)
            finally:
                try:
                    await client_w.drain()
                except Exception:  # noqa: BLE001
                    pass
                client_w.close()
            return

        if _draining:
            _reply(client_w, 503, {"ok": False, "error": "实例正在排空", "draining": True})
            try:
                await client_w.drain()
            except Exception:  # noqa: BLE001
                pass
            client_w.close()
            return

        try:
            target_r, target_w = await asyncio.open_connection("127.0.0.1", TARGET_PORT)
        except Exception:  # noqa: BLE001 — hermes 还没起来
            _reply(client_w, 503, {"ok": False, "error": "hermes 尚未就绪",
                                   "bootstrapped": _bootstrapped})
            try:
                await client_w.drain()
            except Exception:  # noqa: BLE001
                pass
            client_w.close()
            return

        # 把已经读掉的请求头补发，之后纯字节对拷（WebSocket 升级因此不受影响）。普通请求改成回完就关，
        # 好让同一客户端的下一个请求重新经过这里分流（见文件头）。
        if headers.get("upgrade", "").lower() != "websocket":
            head = _close_after(head)
        target_w.write(head)
        await target_w.drain()
        await asyncio.gather(_pipe(client_r, target_w), _pipe(target_r, client_w))
    except Exception:  # noqa: BLE001 — 单个连接出错不影响整个服务
        try:
            client_w.close()
        except Exception:  # noqa: BLE001
            pass


async def _supervise_connectors() -> None:
    backoff = 1
    while True:
        if _bootstrapped and not _draining and _connectors_on():
            try:
                await _connectors.recover()
                backoff = 1
            except (OSError, RuntimeError, ValueError):
                _log('连接器服务恢复失败，请检查实例运行时和授权状态。')
                backoff = min(backoff * 2, 60)
        await asyncio.sleep(backoff)


async def main() -> None:
    global _bootstrapped, _hermes_token, _supervisor_task
    server = await asyncio.start_server(_handle, "0.0.0.0", LISTEN_PORT)
    # Docker receives its token and restored Home before startup; Cube receives them via bootstrap.
    token = os.environ.get('HERMES_DASHBOARD_SESSION_TOKEN', '')
    if token:
        _hermes_token = token
        await _spawn_hermes(token)
        _bootstrapped = True
        _supervisor_task = asyncio.create_task(_supervise())
    janitor = asyncio.create_task(_trash_janitor())
    follower = asyncio.create_task(_token_follower())
    connectors = asyncio.create_task(_supervise_connectors())
    if os.environ.get("MT_API_SERVER") == "1":
        # Docker 路径的服务实例：没有引导这一步，hermes 已在上面拉起，gateway 由这里拉起
        try:
            await _start_api_server()
        except Exception as exc:  # noqa: BLE001
            _log(f"拉起 gateway 失败: {type(exc).__name__}: {exc}")
    async with server:
        try:
            await server.serve_forever()
        finally:
            janitor.cancel()
            follower.cancel()
            connectors.cancel()
            await asyncio.gather(connectors, return_exceptions=True)
            if _supervisor_task:
                _supervisor_task.cancel()
                await asyncio.gather(_supervisor_task, return_exceptions=True)
            await _stop_hermes()


if __name__ == "__main__":
    asyncio.run(main())
