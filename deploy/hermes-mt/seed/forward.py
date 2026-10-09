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
   入口在暂停前调 ``/__mt/sync``、删实例前调 ``/__mt/drain``。这些接口要带实例令牌。
   这两个接口和 ``/__mt/status`` 都附带「忙不忙」（定时任务、对话回合，见 mtstate.activity）：
   入口据此决定这轮回收要不要暂停，并在实例停着时按下一个定时任务的时间把它叫起来。

``/__mt_user/*`` 是给用户用的（命令行通道、回收站、重命名，见 mtuser.py）：浏览器经入口的
``/__hermes_backend/__mt_user/…`` 转进来，带的是和 hermes 一样的会话令牌。入口照常校验登录后放行；
``/__mt/*`` 这组管理接口入口不放行，用户碰不到。

其余请求原样转发，读完请求头就退化成裸字节对拷，因此 WebSocket 不受影响。转发器只看每条连接的
第一个请求，所以转给 hermes 的普通请求一律改成 ``Connection: close``：hermes 回完就关，客户端的下一个
请求只能新开连接、重新经过这里分流。平台代理本来就不复用到实例的连接（CubeProxy 关了 upstream keepalive），
但入口直接连到容器的 Docker 路径、本机的复现台都会复用——不改的话，同一条连接上后面的 ``/__mt_user/…``
会被当成普通请求整段转给 hermes（10-09 本机实测撞过）。

只用标准库；由容器 CMD 以 hermes 用户启动。hermes 意外退出时由本文件带退避拉起。
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import signal
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mtstate  # noqa: E402
import mtuser  # noqa: E402

LISTEN_PORT = int(os.environ.get("MT_FWD_PORT", "9121"))
TARGET_PORT = int(os.environ.get("MT_HERMES_PORT", "9120"))
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

_START_TS = time.monotonic()
_hermes_proc: asyncio.subprocess.Process | None = None
_hermes_token: str = ""
_hermes_env: dict[str, str] = {}
_bootstrapped = False
_boot_lock: asyncio.Lock | None = None
_state: mtstate.StateManager | None = None
_state_lock: asyncio.Lock | None = None
_archiver_task: asyncio.Task | None = None
_supervisor_task: asyncio.Task | None = None
_draining = False
_drained: dict | None = None
_hermes_restarts = 0


# ---------------------------------------------------------------- 工具

async def _hermes_alive() -> bool:
    """hermes 端口能不能连上。"""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", TARGET_PORT), timeout=1.0
        )
    except Exception:  # noqa: BLE001
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:  # noqa: BLE001
        pass
    return True


def _reply(writer: asyncio.StreamWriter, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    reason = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
              405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
              415: "Unsupported Media Type", 500: "Internal Server Error",
              503: "Service Unavailable"}.get(status, "Error")
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
    - ``"patch-model"`` —— content 是 JSON ``{base_url, model, provider_key, key_env, models, template}``：
      整份解析 config.yaml，只改平台块（端点、provider、key 来源、模型清单），用户自己的设置不碰；
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


async def _spawn_hermes(token: str) -> None:
    global _hermes_proc
    env = dict(os.environ)
    env.update(_hermes_env)
    env["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    # hermes serve 只在桌面模式下自己起定时任务的调度线程（web_server.py 的
    # _start_desktop_cron_ticker）；实例里没有单独的 gateway 进程，不设它，用户建的定时任务
    # 永远停在「已排期」。它的其余作用逐个核过：清理桌面遗留的随机端口 serve（我们是固定端口，
    # 碰不到）、父进程看门狗（要 HERMES_PARENT_PID，我们不设）、新会话的来源记为 desktop。
    env["HERMES_DESKTOP"] = "1"
    _hermes_proc = await asyncio.create_subprocess_exec(
        "hermes", "serve",
        "--host", "127.0.0.1",
        "--port", str(TARGET_PORT),
        "--skip-build",
        env=env,
    )


async def _stop_hermes(grace_s: float = 30.0) -> None:
    """先 SIGTERM 等它自己退，超时再 SIGKILL。"""
    proc = _hermes_proc
    if proc is None or proc.returncode is not None:
        return
    try:
        proc.send_signal(signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_s)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        await proc.wait()


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
    await mtuser.close_all_terminals()
    await _stop_hermes()


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
        return await asyncio.to_thread(mtstate.activity, HERMES_HOME)
    except Exception as exc:  # noqa: BLE001
        return {"errors": [f"{type(exc).__name__}: {exc}"]}


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
    """
    global _bootstrapped, _boot_lock, _state, _state_lock, _archiver_task, _supervisor_task, _hermes_token
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

        _hermes_token = token
        try:
            await _spawn_hermes(token)
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
    while time.monotonic() < deadline:
        if await _hermes_alive():
            _reply(writer, 200, {"ok": True, "hermes": True, "written": written, "state": report})
            return
        if _hermes_proc is not None and _hermes_proc.returncode is not None:
            _reply(writer, 500, {
                "ok": False,
                "error": f"hermes 启动后立刻退出，退出码 {_hermes_proc.returncode}",
                "written": written,
                "state": report,
            })
            return
        await asyncio.sleep(0.5)
    _reply(writer, 503, {"ok": False, "error": "hermes 未在超时内就绪", "written": written, "state": report})


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
    _draining = True
    _state.phase = "draining"
    if _archiver_task is not None:
        _archiver_task.cancel()
    await mtuser.close_all_terminals()
    await _stop_hermes()
    try:
        summary = await _do_archive(force=True)
    except mtstate.OwnerLost as exc:
        _state.phase = "fenced"
        _reply(writer, 409, {"ok": False, "error": str(exc), "fenced": True})
        return
    except Exception as exc:  # noqa: BLE001
        _state.phase = "drain_failed"
        _reply(writer, 500, {"ok": False, "error": f"最终归档失败: {type(exc).__name__}: {exc}",
                             "hermes_stopped": True})
        return
    _state.phase = "drained"
    # hermes 已停，jobs.json 不会再变：这里报的下次执行时间就是入口叫醒下一台实例的依据。
    _drained = {"ok": True, "archive": summary, "activity": await _activity()}
    _reply(writer, 200, _drained)


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
    if _supervisor_task is None or _supervisor_task.done():
        _supervisor_task = asyncio.create_task(_supervise())
    if _archiver_task is None or _archiver_task.done():
        _archiver_task = asyncio.create_task(_archiver(ARCHIVE_INTERVAL_S))
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


async def _read_body(headers: dict[str, str], rest: bytes, reader: asyncio.StreamReader) -> bytes | None:
    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        return None
    if length > MAX_BODY:
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

_FILE_OPS = {
    "/__mt_user/files/rename": lambda files, body: files.rename(body.get("path"), body.get("new_name")),
    "/__mt_user/files/trash": lambda files, body: files.move_to_trash(body.get("path")),
    "/__mt_user/files/restore": lambda files, body: files.restore(body.get("id")),
}


async def _handle_user(
    method: str, path: str, headers: dict[str, str],
    rest: bytes, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
) -> None:
    """命令行通道（WebSocket）、回收站、重命名。都要会话令牌；实例在排空时一律 503。"""
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

    files = mtuser.Files(WORKSPACE)
    try:
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


async def _handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    try:
        head = await _read_head(client_r)
        if head is None:
            client_w.close()
            return

        method, path, headers, rest = _parse(head)
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


async def main() -> None:
    server = await asyncio.start_server(_handle, "0.0.0.0", LISTEN_PORT)
    janitor = asyncio.create_task(_trash_janitor())
    async with server:
        try:
            await server.serve_forever()
        finally:
            janitor.cancel()


if __name__ == "__main__":
    asyncio.run(main())
