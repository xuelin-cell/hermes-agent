"""实例里给用户用的接口：命令行通道、回收站、重命名、Office 文件预览。

浏览器经入口的 ``/__hermes_backend/__mt_user/…`` 转进来，路径原样落到转发器的 ``/__mt_user/…``。
令牌校验和分流在 forward.py，这里只管干活。只用标准库；pty 相关的模块用到时才导入，
好让 Windows 上的单元测试也能导入本文件。

为什么不用 hermes 自己的：hermes 的 ``/api/pty`` 起的是它的命令行聊天界面、不是 shell；
它也没有重命名接口，删除是直接删；预览面板不认 Office 文件，pptx 会被当成二进制。
浏览器版的右侧终端、回收站、改名、Office 预览都要在实例里另做。
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import contextlib
import hashlib
import json
import os
import posixpath
import re
import secrets
import shutil
import signal
import stat
import struct
import tempfile
import time
from pathlib import Path

import mtstate

# ---------------------------------------------------------------- WebSocket（RFC 6455，服务端最小实现）

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class ProtocolError(Exception):
    """对端发来的帧不合协议。"""


def ws_accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")


def ws_frame(opcode: int, payload: bytes = b"") -> bytes:
    """服务端发出的帧：单帧、不加掩码。"""
    head = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n < 1 << 16:
        head.append(126)
        head += struct.pack("!H", n)
    else:
        head.append(127)
        head += struct.pack("!Q", n)
    return bytes(head) + payload


def _unmask(payload: bytes, mask: bytes) -> bytes:
    if not payload:
        return payload
    n = len(payload)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "little") ^ int.from_bytes(key, "little")).to_bytes(n, "little")


class ServerWebSocket:
    """握手之后的一条连接。``recv`` 自动回 pong、处理分片和关闭；``send`` 带锁，几个协程可以一起发。"""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, max_message: int = 4 << 20):
        self.reader = reader
        self.writer = writer
        self.max_message = max_message
        self.closed = False
        self._send_lock = asyncio.Lock()

    async def send(self, opcode: int, payload: bytes) -> None:
        if self.closed:
            raise ConnectionError("websocket 已关闭")
        async with self._send_lock:
            self.writer.write(ws_frame(opcode, payload))
            await self.writer.drain()

    async def send_json(self, obj: dict) -> None:
        await self.send(OP_TEXT, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        try:
            await self.send(OP_CLOSE, struct.pack("!H", code) + reason.encode("utf-8")[:120])
        except Exception:  # noqa: BLE001 —— 对端已经走了
            pass
        self.closed = True

    async def _read_frame(self) -> tuple[bool, int, bytes]:
        head = await self.reader.readexactly(2)
        if head[0] & 0x70:
            raise ProtocolError("没协商过扩展，RSV 位却被置上")
        fin, opcode = bool(head[0] & 0x80), head[0] & 0x0F
        masked, length = bool(head[1] & 0x80), head[1] & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", await self.reader.readexactly(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", await self.reader.readexactly(8))
        if not masked:
            raise ProtocolError("客户端发来的帧必须加掩码")
        if length > self.max_message:
            raise ProtocolError("帧太大")
        mask = await self.reader.readexactly(4)
        return fin, opcode, _unmask(await self.reader.readexactly(length), mask)

    async def recv(self) -> bytes | None:
        """下一条完整的文本 / 二进制消息；对端关闭返回 None。"""
        buf = bytearray()
        started = False
        while True:
            fin, opcode, payload = await self._read_frame()
            if opcode == OP_PING:
                await self.send(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1000
                await self.close(code if 1000 <= code < 5000 else 1000)
                return None
            if opcode in (OP_TEXT, OP_BINARY):
                if started:
                    raise ProtocolError("上一条分片消息还没收完")
                started = True
            elif opcode == OP_CONT:
                if not started:
                    raise ProtocolError("没有开头的续帧")
            else:
                raise ProtocolError(f"不认识的操作码 {opcode}")
            buf += payload
            if len(buf) > self.max_message:
                raise ProtocolError("消息太大")
            if fin:
                return bytes(buf)


_REASONS = {101: "Switching Protocols", 400: "Bad Request", 429: "Too Many Requests",
            501: "Not Implemented", 503: "Service Unavailable"}


def _http_reply(writer: asyncio.StreamWriter, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    head = (
        f"HTTP/1.1 {status} {_REASONS.get(status, 'Error')}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode("ascii")
    try:
        writer.write(head + body)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- 命令行通道

MAX_TERMINALS = int(os.environ.get("MT_MAX_TERMINALS", "8"))
_OUT_HIGH = 256 * 1024     # 积压的输出超过这么多就先不读 pty，等发送追上（shell 那边会被写阻塞）
_KILL_GRACE_S = 3.0
_terminals: set["Terminal"] = set()


def _shell() -> tuple[str, list[str], str]:
    """交互式 bash，不加 -l：登录 shell 会读 /etc/profile 重设 PATH，hermes 的 venv 就不在 PATH 里了。"""
    for path in ("/bin/bash", "/usr/bin/bash"):
        if os.access(path, os.X_OK):
            return path, ["-i"], "bash"
    return "/bin/sh", ["-i"], "sh"


def _shell_env(cwd: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("MT_")}
    env.pop("HERMES_DASHBOARD_SESSION_TOKEN", None)
    env.update(TERM="xterm-256color", COLORTERM="truecolor", TERM_PROGRAM="Hermes")
    # 工作区是指向卷的链接：带上 PWD，bash 就显示 /opt/data/workspace（和 agent 的终端工具一致），
    # 而不是解开链接后的 /mnt/u/workspace。
    env["PWD"] = cwd
    env.setdefault("LANG", "C.UTF-8")
    return env


def _safe_cwd(requested: str, workspace: Path) -> str:
    """shell 的起点。工作区里的目录一律写成经链接的 /opt/data/workspace/…：前端给的常是卷上的真实路径
    （/mnt/u/workspace/…，文件树就是这么列的），而 agent 的终端工具和环境说明用的是链接这种写法。"""
    for candidate in (requested, str(workspace), os.environ.get("HOME", ""), "/"):
        if candidate and os.path.isabs(candidate) and os.path.isdir(candidate):
            real = Path(os.path.realpath(candidate))
            root = Path(os.path.realpath(workspace))
            if real == root or root in real.parents:
                rel = real.relative_to(root).as_posix()
                linked = str(workspace) if rel == "." else posixpath.join(str(workspace), rel)
                if os.path.isdir(linked):
                    return linked
            return candidate
    return "/"


def _int_arg(query: dict[str, list[str]], name: str, default: int, low: int, high: int) -> int:
    try:
        value = int((query.get(name) or [str(default)])[0])
    except ValueError:
        value = default
    return max(low, min(high, value))


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    import fcntl
    import termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _become_tty_owner() -> None:
    """子进程里、exec 之前：start_new_session 已经 setsid，这里把 pty 设成控制终端（作业控制、^C 才有效）。"""
    import fcntl
    import termios
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class Terminal:
    """一条 ws 连接对应一个 shell：连接断了 shell 就结束，和桌面版刷新、关窗时一样。"""

    def __init__(self, ws: ServerWebSocket, cols: int, rows: int, cwd: str):
        self.ws = ws
        self.cols, self.rows, self.cwd = cols, rows, cwd
        self.proc: asyncio.subprocess.Process | None = None
        self.master = -1
        self._loop = asyncio.get_running_loop()
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._out: list[str] = []
        self._out_bytes = 0
        self._out_ready = asyncio.Event()
        self._eof = False
        self._reading = False

    # ---- pty 读写
    def _start_reading(self) -> None:
        if not self._reading and not self._eof and self.master >= 0:
            self._loop.add_reader(self.master, self._readable)
            self._reading = True

    def _stop_reading(self) -> None:
        if self._reading:
            self._loop.remove_reader(self.master)
            self._reading = False

    def _readable(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO：pty 另一头的进程全关了
            data = b""
        if not data:
            self._eof = True
            self._stop_reading()
            tail = self._decoder.decode(b"", final=True)
            if tail:
                self._out.append(tail)
        else:
            self._out.append(self._decoder.decode(data))
            self._out_bytes += len(data)
            if self._out_bytes > _OUT_HIGH:
                self._stop_reading()
        self._out_ready.set()

    async def _pump_out(self) -> None:
        """攒着的输出合成一帧发出去；读到头（pty 关了）就返回。发送失败抛出 = 浏览器那头没了。"""
        while True:
            await self._out_ready.wait()
            self._out_ready.clear()
            if self._out:
                text = "".join(self._out)
                self._out.clear()
                self._out_bytes = 0
                self._start_reading()
                if text:
                    await self.ws.send_json({"type": "output", "data": text})
            if self._eof and not self._out:
                return

    async def _write(self, text: str) -> None:
        data = text.encode("utf-8", "replace")
        while data:
            try:
                written = os.write(self.master, data)
                data = data[written:]
            except BlockingIOError:
                ready = self._loop.create_future()
                self._loop.add_writer(self.master, ready.set_result, None)
                try:
                    await ready
                finally:
                    self._loop.remove_writer(self.master)
            except OSError:
                return  # shell 已经没了

    def _current_cwd(self) -> str | None:
        if self.proc is None:
            return None
        try:
            return os.readlink(f"/proc/{self.proc.pid}/cwd")
        except OSError:
            return None

    async def _pump_in(self) -> None:
        """浏览器发来的消息；对端关闭就返回。"""
        while True:
            message = await self.ws.recv()
            if message is None:
                return
            try:
                obj = json.loads(message)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            kind = obj.get("type")
            if kind == "input":
                await self._write(str(obj.get("data") or ""))
            elif kind == "resize":
                try:
                    cols, rows = int(obj.get("cols") or self.cols), int(obj.get("rows") or self.rows)
                except (TypeError, ValueError):
                    continue
                self.cols, self.rows = max(2, min(1000, cols)), max(2, min(500, rows))
                _set_winsize(self.master, self.rows, self.cols)
            elif kind == "cwd":
                await self.ws.send_json({"type": "cwd", "cwd": self._current_cwd(), "seq": obj.get("seq")})

    # ---- 生命周期
    async def _spawn(self) -> None:
        shell, args, _ = _shell()
        master, slave = os.openpty()
        try:
            _set_winsize(slave, self.rows, self.cols)
            self.proc = await asyncio.create_subprocess_exec(
                shell, *args,
                stdin=slave, stdout=slave, stderr=slave,
                cwd=self.cwd, env=_shell_env(self.cwd),
                start_new_session=True, preexec_fn=_become_tty_owner,
            )
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        self.master = master

    def _signal_group(self, sig: int) -> None:
        if self.proc is None or self.proc.returncode is not None:
            return
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    async def shutdown(self) -> None:
        """浏览器断开、或实例要排空：挂断 shell，不退就强杀。"""
        self._signal_group(signal.SIGHUP)
        if self.proc is not None:
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=_KILL_GRACE_S)
            except asyncio.TimeoutError:
                self._signal_group(signal.SIGKILL)
                await self.proc.wait()
        await self.ws.close(1001, "terminal closed")

    def _release(self) -> None:
        self._stop_reading()
        if self.master >= 0:
            try:
                os.close(self.master)
            except OSError:
                pass
            self.master = -1

    async def run(self) -> None:
        await self._spawn()
        assert self.proc is not None
        await self.ws.send_json({"type": "ready", "shell": _shell()[2], "cwd": self.cwd, "pid": self.proc.pid})
        self._start_reading()
        pump_out = asyncio.create_task(self._pump_out())
        pump_in = asyncio.create_task(self._pump_in())
        exited = asyncio.create_task(self.proc.wait())
        pending = {pump_out, pump_in, exited}
        client_gone = False
        try:
            while True:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                if exited in done:
                    break
                if pump_in in done or (pump_out in done and pump_out.exception() is not None):
                    client_gone = True
                    break
                # pump_out 正常结束 = pty 读到头，shell 马上就会退，接着等
            if client_gone:
                await self.shutdown()
                return
            # shell 自己退了（exit / ^D / 崩了）：把最后几行送完，再告诉浏览器退出码
            if not pump_out.done():
                try:
                    await asyncio.wait_for(asyncio.shield(pump_out), timeout=1.0)
                except Exception:  # noqa: BLE001
                    pass
            code = self.proc.returncode
            await self.ws.send_json({
                "type": "exit",
                "code": code if code is not None and code >= 0 else None,
                "signal": signal.Signals(-code).name if code is not None and code < 0 else None,
            })
            await self.ws.close(1000, "shell exited")
        finally:
            for task in (pump_out, pump_in, exited):
                if not task.done():
                    task.cancel()
            await asyncio.gather(pump_out, pump_in, exited, return_exceptions=True)
            self._release()


async def serve_terminal(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    headers: dict[str, str],
    query: dict[str, list[str]],
    workspace: Path,
) -> None:
    """``GET /__mt_user/terminal?cols=&rows=&cwd=``（WebSocket）。令牌已由 forward.py 校验过。"""
    if headers.get("upgrade", "").lower() != "websocket" or not headers.get("sec-websocket-key"):
        _http_reply(writer, 400, {"ok": False, "code": "not_websocket", "error": "要用 WebSocket 连接"})
        return
    try:
        import fcntl  # noqa: F401
        import termios  # noqa: F401
    except ImportError:
        _http_reply(writer, 501, {"ok": False, "code": "no_pty", "error": "这台机器没有 pty"})
        return
    if len(_terminals) >= MAX_TERMINALS:
        _http_reply(writer, 429, {"ok": False, "code": "too_many", "error": f"最多同时开 {MAX_TERMINALS} 个终端"})
        return
    writer.write((
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {ws_accept(headers['sec-websocket-key'])}\r\n\r\n"
    ).encode("ascii"))
    await writer.drain()
    ws = ServerWebSocket(reader, writer)
    term = Terminal(
        ws,
        _int_arg(query, "cols", 80, 2, 1000),
        _int_arg(query, "rows", 24, 2, 500),
        _safe_cwd((query.get("cwd") or [""])[0], workspace),
    )
    _terminals.add(term)
    try:
        await term.run()
    except (ConnectionError, asyncio.IncompleteReadError, ProtocolError):
        await term.shutdown()
    except Exception as exc:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        except Exception:  # noqa: BLE001
            pass
        await term.shutdown()
    finally:
        _terminals.discard(term)


async def close_all_terminals() -> None:
    """实例排空前：所有终端一起挂断。"""
    await asyncio.gather(*(term.shutdown() for term in list(_terminals)), return_exceptions=True)


def terminal_count() -> int:
    return len(_terminals)


# ---------------------------------------------------------------- 回收站与重命名

TRASH_DIRNAME = ".trash"
TRASH_KEEP_S = int(os.environ.get("MT_TRASH_KEEP_S", str(7 * 86400)))
_META = "meta.json"
_ENTRY_ID = re.compile(r"^(\d{13})-[0-9a-f]{8}$")


class FileError(Exception):
    """给浏览器的错误：``code`` 让垫片换成界面语言的提示。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _protected(links=mtstate.LINKS) -> frozenset[str]:
    """hermes 的附件、图片、生成的媒体都靠链接指进工作区里的这些目录，聊天记录里的图片也靠它们：
    这些目录和它们在工作区里的上级目录不能删、不能改名，里面的文件可以。"""
    out: set[str] = set()
    for _, target in links:
        parts = target.split("/")
        if parts[0] != "workspace" or len(parts) < 2:
            continue
        for i in range(2, len(parts) + 1):
            out.add("/".join(parts[1:i]))
    return frozenset(out)


PROTECTED = _protected()


def _check_name(name: object) -> str:
    if not isinstance(name, str) or not name.strip() or name in (".", "..") \
            or "/" in name or "\0" in name or len(name.encode("utf-8")) > 255:
        raise FileError(400, "invalid_name", "名字不合法")
    return name


class Files:
    """只动工作区里的东西。前端给的路径可能是 /opt/data/workspace/… 这条链接，也可能是卷上的真实路径，
    两种都认；返回的新路径保持和传进来的同一种写法。"""

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)

    @property
    def root(self) -> Path:
        return Path(os.path.realpath(self.workspace))

    @property
    def trash(self) -> Path:
        return self.root.parent / TRASH_DIRNAME

    def _within(self, real: Path) -> bool:
        root = self.root
        return real == root or root in real.parents

    def _aliases(self, shown: str, rel: str) -> list[str]:
        """同一个文件在前端可能有两种写法：经链接的 /opt/data/workspace/… 和卷上的真实路径。
        垫片按这些关掉还指着旧位置的预览标签。"""
        out = [shown]
        for form in (posixpath.join(str(self.workspace).replace("\\", "/"), rel),
                     posixpath.join(self.root.as_posix(), rel)):
            if form not in out:
                out.append(form)
        return out

    def _locate(self, path: object) -> tuple[Path, str]:
        """返回 (真实路径, 相对工作区的路径)。最后一级不跟随链接：删链接删的是链接本身。"""
        if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
            raise FileError(400, "invalid_path", "路径不合法")
        name = posixpath.basename(path.rstrip("/"))
        if name in ("", ".", ".."):
            raise FileError(400, "invalid_path", "路径不合法")
        parent = Path(os.path.realpath(posixpath.dirname(path.rstrip("/"))))
        if not self._within(parent):
            raise FileError(403, "outside", "只能操作工作区里的文件")
        real = parent / name
        if not os.path.lexists(real):
            raise FileError(404, "not_found", "文件不存在")
        rel = real.relative_to(self.root).as_posix()
        return real, rel

    def rename(self, path: object, new_name: object) -> dict:
        real, rel = self._locate(path)
        name = _check_name(new_name)
        if rel in PROTECTED:
            raise FileError(403, "protected", "这个文件夹存放聊天附件和生成的图片，不能改名")
        assert isinstance(path, str)
        shown = posixpath.join(posixpath.dirname(path.rstrip("/")), name)
        if name == real.name:
            return {"path": shown, "old_paths": []}
        target = real.parent / name
        if os.path.lexists(target):
            raise FileError(409, "exists", "已经有同名的文件或文件夹")
        os.rename(real, target)
        return {"path": shown, "old_paths": self._aliases(path, rel)}

    def move_to_trash(self, path: object) -> dict:
        real, rel = self._locate(path)
        if rel in PROTECTED:
            raise FileError(403, "protected", "这个文件夹存放聊天附件和生成的图片，不能删除")
        entry_id = f"{int(time.time() * 1000)}-{secrets.token_hex(4)}"
        entry = self.trash / entry_id
        entry.mkdir(parents=True)
        meta = {
            "id": entry_id,
            "name": real.name,
            "rel": rel,
            "path": path,
            "deleted_at": time.time(),
            "dir": real.is_dir() and not real.is_symlink(),
        }
        (entry / _META).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        try:
            os.rename(real, entry / real.name)
        except BaseException:
            shutil.rmtree(entry, ignore_errors=True)
            raise
        assert isinstance(path, str)
        return {**meta, "old_paths": self._aliases(path, rel)}

    def _entry(self, entry_id: object) -> tuple[Path, dict]:
        if not isinstance(entry_id, str) or not _ENTRY_ID.match(entry_id):
            raise FileError(400, "invalid_id", "回收站条目编号不合法")
        entry = self.trash / entry_id
        try:
            meta = json.loads((entry / _META).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise FileError(404, "not_found", "回收站里没有这一项") from exc
        if not isinstance(meta, dict):
            raise FileError(404, "not_found", "回收站里没有这一项")
        return entry, meta

    def restore(self, entry_id: object) -> dict:
        """放回原处。条目里的说明文件 agent 也能改，当不可信输入：名字、相对路径都要重新校验。"""
        entry, meta = self._entry(entry_id)
        name = _check_name(meta.get("name"))
        rel = str(meta.get("rel") or "")
        parts = rel.split("/")
        if not rel or rel.startswith("/") or any(p in ("", ".", "..") for p in parts) or parts[-1] != name:
            raise FileError(400, "invalid_entry", "回收站条目损坏")
        # 先确认落点在工作区里再建目录：rel 的某一级可能是指向外面的链接。建完再确认一次。
        parent = self.root / posixpath.dirname(rel) if "/" in rel else self.root
        if not self._within(Path(os.path.realpath(parent))):
            raise FileError(403, "outside", "只能恢复到工作区里")
        parent.mkdir(parents=True, exist_ok=True)
        parent = Path(os.path.realpath(parent))
        if not self._within(parent):
            raise FileError(403, "outside", "只能恢复到工作区里")
        target = parent / name
        if os.path.lexists(target):
            raise FileError(409, "exists", "原位置已经有同名的文件或文件夹")
        source = entry / name
        if not os.path.lexists(source):
            raise FileError(404, "not_found", "回收站里没有这一项")
        os.rename(source, target)
        shutil.rmtree(entry, ignore_errors=True)
        shown = meta.get("path")
        return {"path": shown if isinstance(shown, str) and shown.startswith("/") else str(target)}

    def list_trash(self, limit: int = 500) -> list[dict]:
        out: list[dict] = []
        try:
            entries = list(self.trash.iterdir())
        except OSError:
            return out
        for entry in entries:
            if not _ENTRY_ID.match(entry.name):
                continue
            try:
                meta = json.loads((entry / _META).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(meta, dict):
                out.append({k: meta.get(k) for k in ("id", "name", "path", "deleted_at", "dir")})
        out.sort(key=lambda m: m.get("deleted_at") or 0, reverse=True)
        return out[:limit]

    def purge(self, keep_s: int = TRASH_KEEP_S, now: float | None = None) -> int:
        """删掉放进回收站超过 keep_s 秒的条目，按编号里的时间算。返回删了几条。"""
        now_ms = (time.time() if now is None else now) * 1000
        removed = 0
        try:
            entries = list(self.trash.iterdir())
        except OSError:
            return 0
        for entry in entries:
            match = _ENTRY_ID.match(entry.name)
            if match and now_ms - int(match.group(1)) > keep_s * 1000:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        return removed


# ---------------------------------------------------------------- Office 文件预览

# 预览面板只会显示文本、图片、PDF 和网页，Word / PowerPoint / Excel 在它眼里是二进制。这里用镜像里的
# LibreOffice 把它们转成 PDF，面板按 PDF 显示。转好的放在本地盘（不进卷、不进归档），按「真实路径 +
# 大小 + 修改时间」认，文件一改就重新转。同一时间只转一个；浏览器等不及断开了，这次转换照样做完，
# 下次打开直接用。
OFFICE_EXTENSIONS = frozenset({".doc", ".docx", ".odp", ".ods", ".odt", ".ppt", ".pptx", ".xls", ".xlsx"})
OFFICE_MAX_BYTES = int(os.environ.get("MT_OFFICE_PREVIEW_MAX_BYTES", str(100 << 20)))
OFFICE_PDF_MAX_BYTES = int(os.environ.get("MT_OFFICE_PREVIEW_PDF_MAX_BYTES", str(50 << 20)))
OFFICE_TIMEOUT_S = float(os.environ.get("MT_OFFICE_PREVIEW_TIMEOUT_S", "180"))
OFFICE_CACHE_DIR = Path(os.environ.get("MT_OFFICE_PREVIEW_DIR", "/tmp/mt-office-preview"))
# 缓存在实例的可写层上，和对话库共用那几 G：份数和总量都要有上限。
OFFICE_CACHE_KEEP = 30
OFFICE_CACHE_MAX_BYTES = 500 << 20
_JOB_PREFIX = "job-"
_JOB_STALE_S = 3600


def soffice_command() -> list[str] | None:
    """LibreOffice 的命令行；没装就是 None。"""
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return [found]
    return None


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    """soffice 会再起一个 soffice.bin：整组一起杀。"""
    if proc.returncode is not None:
        return
    try:
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError):
        pass


def _tail(output: str, limit: int = 300) -> str:
    lines = [ln.strip() for ln in output.splitlines() if ln.strip()]
    return " / ".join(lines)[-limit:] or "LibreOffice 没有给出原因"


class OfficePreview:
    """Office 文件转 PDF。转发器里只有一个：锁和「正在转哪些」要跨请求共用。"""

    def __init__(self, workspace: Path, cache_dir: Path = OFFICE_CACHE_DIR):
        self.files = Files(workspace)
        self.cache_dir = Path(cache_dir)
        self._lock: asyncio.Lock | None = None
        self._jobs: dict[str, asyncio.Future] = {}

    def locate(self, path: object) -> tuple[Path, os.stat_result]:
        """返回 (真实路径, stat)。只认工作区里的 Office 文件（链接解开后算）。"""
        if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path:
            raise FileError(400, "invalid_path", "路径不合法")
        real = Path(os.path.realpath(path))
        if not self.files._within(real):
            raise FileError(403, "outside", "只能预览工作区里的文件")
        if real.suffix.lower() not in OFFICE_EXTENSIONS:
            raise FileError(415, "unsupported", "这种文件不能转成 PDF 预览")
        try:
            st = real.stat()
        except OSError as exc:
            raise FileError(404, "not_found", "文件不存在") from exc
        if not stat.S_ISREG(st.st_mode):
            raise FileError(404, "not_found", "文件不存在")
        if st.st_size > OFFICE_MAX_BYTES:
            raise FileError(413, "too_large", f"文件超过 {OFFICE_MAX_BYTES >> 20} MB，不能在线预览")
        return real, st

    async def pdf(self, path: object) -> Path:
        """这个文件对应的 PDF（缓存里有就直接给）。出错抛 FileError。"""
        real, st = await asyncio.to_thread(self.locate, path)
        ident = f"{real}\0{st.st_size}\0{st.st_mtime_ns}".encode("utf-8", "surrogateescape")
        key = hashlib.sha256(ident).hexdigest()[:40]
        out = self.cache_dir / f"{key}.pdf"
        if out.is_file():
            with contextlib.suppress(OSError):
                os.utime(out)  # 清理按修改时间留最近用过的
            return out
        job = self._jobs.get(key)
        if job is None:
            job = asyncio.ensure_future(self._convert(real, out))
            self._jobs[key] = job
            job.add_done_callback(lambda done: self._finished(key, done))
        # 浏览器断开时取消的只是这次等待，转换本身接着做完。
        return await asyncio.shield(job)

    def _finished(self, key: str, job: asyncio.Future) -> None:
        self._jobs.pop(key, None)
        if not job.cancelled():
            job.exception()  # 没人在等时也算取走了，免得事件循环报「异常没人看」

    async def _convert(self, real: Path, out: Path) -> Path:
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if out.is_file():
                return out
            command = soffice_command()
            if command is None:
                raise FileError(501, "unavailable", "实例里没有 LibreOffice，不能生成预览")
            await asyncio.to_thread(self._prepare)
            work = Path(await asyncio.to_thread(tempfile.mkdtemp, prefix=_JOB_PREFIX, dir=str(self.cache_dir)))
            try:
                # 拷一份 ASCII 名字的副本去转：LibreOffice 会在文档旁边放锁文件，不能让它出现在用户的工作区里；
                # 文件名里的中文、空格也就不用操心它的命令行怎么解析。
                source = work / f"source{real.suffix.lower()}"
                await asyncio.to_thread(shutil.copyfile, real, source)
                profile = (self.cache_dir / "profile").resolve().as_uri()
                code, output = await self._run(command + [
                    f"-env:UserInstallation={profile}",
                    "--headless", "--invisible", "--nologo", "--nodefault", "--norestore",
                    "--nolockcheck", "--nofirststartwizard",
                    "--convert-to", "pdf", "--outdir", str(work), str(source),
                ], work)
                produced = work / "source.pdf"
                size = produced.stat().st_size if produced.is_file() else 0
                if code != 0 or size == 0:
                    await asyncio.to_thread(shutil.rmtree, self.cache_dir / "profile", True)
                    raise FileError(422, "convert_failed", "转换失败：" + _tail(output))
                if size > OFFICE_PDF_MAX_BYTES:
                    raise FileError(413, "too_large", f"转出来的 PDF 超过 {OFFICE_PDF_MAX_BYTES >> 20} MB，不能在线预览")
                os.replace(produced, out)
            finally:
                await asyncio.to_thread(shutil.rmtree, work, True)
            await asyncio.to_thread(self.prune)
            return out

    async def _run(self, argv: list[str], cwd: Path) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd), env=self._env(),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            raw, _ = await asyncio.wait_for(proc.communicate(), timeout=OFFICE_TIMEOUT_S)
        except asyncio.TimeoutError:
            _kill_group(proc)
            await proc.wait()
            # 杀掉的 soffice 可能把配置目录留在「使用中」，下一次换个干净的。
            await asyncio.to_thread(shutil.rmtree, self.cache_dir / "profile", True)
            raise FileError(504, "timeout", f"生成预览超过 {int(OFFICE_TIMEOUT_S)} 秒") from None
        except BaseException:
            _kill_group(proc)
            raise
        return proc.returncode or 0, raw.decode("utf-8", "replace")

    def _env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith("MT_")}
        env.pop("HERMES_DASHBOARD_SESSION_TOKEN", None)
        # 配置目录由 -env:UserInstallation 指到缓存目录；HOME 也指过去，字体缓存之类不落进用户的数据目录。
        env["HOME"] = str(self.cache_dir / "home")
        env.setdefault("LANG", "C.UTF-8")
        return env

    def _prepare(self) -> None:
        (self.cache_dir / "home").mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            self.cache_dir.chmod(0o700)

    def prune(self, keep: int = OFFICE_CACHE_KEEP, max_bytes: int = OFFICE_CACHE_MAX_BYTES,
              now: float | None = None) -> int:
        """只留最近用过的 PDF：最多 keep 份、合计不超过 max_bytes（最新那份总留着）；
        崩溃留下的转换目录过一小时清掉。返回删了几项。"""
        now = time.time() if now is None else now
        removed = 0
        pdfs: list[tuple[float, int, Path]] = []
        try:
            entries = list(self.cache_dir.iterdir())
        except OSError:
            return 0
        for entry in entries:
            try:
                st = entry.stat()
            except OSError:
                continue
            if entry.suffix == ".pdf" and entry.is_file():
                pdfs.append((st.st_mtime, st.st_size, entry))
            elif entry.name.startswith(_JOB_PREFIX) and now - st.st_mtime > _JOB_STALE_S:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        pdfs.sort(key=lambda item: item[0], reverse=True)
        total = 0
        for i, (_, size, entry) in enumerate(pdfs):
            total += size
            if i == 0 or (i < keep and total <= max_bytes):
                continue
            with contextlib.suppress(OSError):
                entry.unlink()
                removed += 1
        return removed
