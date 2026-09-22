"""租户容器内的转发器（Docker 路径）＋ 引导器（沙箱路径）：0.0.0.0:9121 -> 127.0.0.1:9120。

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

除 ``/__mt/*`` 外的所有请求原样转发，读完请求头就退化成裸字节对拷，因此 WebSocket 不受影响。

只用标准库；由容器 CMD 以 hermes 用户启动；出错不重启（容器整体由入口管）。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

LISTEN_PORT = int(os.environ.get("MT_FWD_PORT", "9121"))
TARGET_PORT = int(os.environ.get("MT_HERMES_PORT", "9120"))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
CHUNK = 64 * 1024

# 引导窗口：容器启动后多少秒内允许 bootstrap。入口在创建沙箱后立刻调用，
# 留这个窗口是为了缩小「别人抢先引导」的时间面（见下方 _bootstrap 的说明）。
BOOTSTRAP_WINDOW_S = int(os.environ.get("MT_BOOTSTRAP_WINDOW_S", "600"))

MAX_HEAD = 64 * 1024  # 请求头上限，超过就当坏请求
MAX_BODY = 4 * 1024 * 1024  # 引导载荷上限

_START_TS = time.monotonic()
_hermes_proc: asyncio.subprocess.Process | None = None
_bootstrapped = False
_boot_lock: asyncio.Lock | None = None


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
    reason = {200: "OK", 400: "Bad Request", 403: "Forbidden",
              409: "Conflict", 500: "Internal Server Error",
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

    每项的 ``overwrite`` 有三种取值：

    - ``True`` —— 总是写。入口每次都要刷新的东西（比如 ``.env`` 里的模型 key）用这个。
    - ``False`` —— 文件已存在就跳过。老用户卷里属于他自己的东西用这个。
    - ``"if-pristine"`` —— 文件不存在就写；已存在则仅当它与镜像里的示例逐字节相同
      时才写。这是 ``config.yaml`` 该用的：既能盖掉 stage2 种的默认示例，
      又不会碰用户或 hermes 自己写过的内容。
    """
    written: list[str] = []
    for item in files:
        rel = str(item.get("path", "")).strip().lstrip("/")
        if not rel or ".." in Path(rel).parts:
            raise ValueError(f"非法路径: {rel!r}")
        dest = HERMES_HOME / rel
        mode = item.get("overwrite", False)
        if dest.exists():
            if mode == "if-pristine":
                if not _is_pristine(rel, dest):
                    continue
            elif not mode:
                continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(item.get("content", ""), encoding="utf-8")
        try:
            dest.chmod(0o600 if rel.endswith(".env") else 0o644)
        except OSError:
            pass
        written.append(rel)
    return written


async def _spawn_hermes(token: str) -> None:
    global _hermes_proc
    env = dict(os.environ)
    env["HERMES_DASHBOARD_SESSION_TOKEN"] = token
    _hermes_proc = await asyncio.create_subprocess_exec(
        "hermes", "serve",
        "--host", "127.0.0.1",
        "--port", str(TARGET_PORT),
        "--skip-build",
        env=env,
    )


async def _bootstrap(writer: asyncio.StreamWriter, body: bytes) -> None:
    """``POST /__mt/bootstrap`` —— 收令牌和种子文件，落盘，拉起 hermes。

    只认第一次，且只在启动后的窗口期内。沙箱只能经平台代理按 sandboxId 访问，
    而 sandboxId 只有入口知道（存在入口自己的库里），再加上这两道限制，
    「别人抢先引导」需要同时猜中 ID 并在几秒内赢得竞争。
    TODO: 平台若支持创建时注入一次性密钥，改成校验密钥，去掉这个时间窗。
    """
    global _bootstrapped, _boot_lock
    if _boot_lock is None:
        _boot_lock = asyncio.Lock()

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

        try:
            written = _write_seed(list(payload.get("files") or []))
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 400, {"ok": False, "error": f"写种子文件失败: {exc}"})
            return

        try:
            await _spawn_hermes(token)
        except Exception as exc:  # noqa: BLE001
            _reply(writer, 500,
                   {"ok": False, "error": f"拉起 hermes 失败: {type(exc).__name__}: {exc}"})
            return

        _bootstrapped = True

    # 等 hermes 真正开始监听，好让入口一收到 200 就能直接转发。
    deadline = time.monotonic() + float(payload.get("ready_timeout_s", 180))
    while time.monotonic() < deadline:
        if await _hermes_alive():
            _reply(writer, 200, {"ok": True, "hermes": True, "written": written})
            return
        if _hermes_proc is not None and _hermes_proc.returncode is not None:
            _reply(writer, 500, {
                "ok": False,
                "error": f"hermes 启动后立刻退出，退出码 {_hermes_proc.returncode}",
                "written": written,
            })
            return
        await asyncio.sleep(0.5)
    _reply(writer, 503, {"ok": False, "error": "hermes 未在超时内就绪", "written": written})


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
            "uptime_s": round(time.monotonic() - _START_TS, 1),
            "boot_window_left_s": max(0, round(left)),
        })
        return

    if route == "/__mt/bootstrap":
        if method != "POST":
            _reply(writer, 400, {"ok": False, "error": "只接受 POST"})
            return
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            _reply(writer, 400, {"ok": False, "error": "Content-Length 不是数字"})
            return
        if length > MAX_BODY:
            _reply(writer, 400, {"ok": False, "error": "载荷过大"})
            return
        body = bytearray(rest)
        while len(body) < length:
            chunk = await reader.read(min(CHUNK, length - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        await _bootstrap(writer, bytes(body))
        return

    _reply(writer, 400, {"ok": False, "error": f"未知接口 {route}"})


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
        if path.startswith("/__mt/"):
            try:
                await _handle_mt(method, path, headers, rest, client_r, client_w)
            finally:
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

        # 把已经读掉的请求头原样补发，之后纯字节对拷（WebSocket 升级因此不受影响）。
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
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
