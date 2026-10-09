"""转发器给用户用的接口（deploy/hermes-mt/seed/mtuser.py + forward.py 的 /__mt_user/ 分流）。

pty 和真实文件操作要 Linux：容器里的整链路测试见 handover/tools/fwdtest/driver_batch2.py。
这里测与平台无关的部分：WebSocket 帧、受保护目录、名字校验、回收站过期清理、令牌校验。
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import struct
import sys
import time
from pathlib import Path

import pytest

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"
if str(SEED_DIR) not in sys.path:
    sys.path.insert(0, str(SEED_DIR))

import mtuser  # noqa: E402


def _client_frame(opcode: int, payload: bytes, fin: bool = True, mask: bytes = b"\x01\x02\x03\x04") -> bytes:
    head = bytearray([(0x80 if fin else 0) | opcode])
    n = len(payload)
    if n < 126:
        head.append(0x80 | n)
    elif n < 1 << 16:
        head.append(0x80 | 126)
        head += struct.pack("!H", n)
    else:
        head.append(0x80 | 127)
        head += struct.pack("!Q", n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return bytes(head) + mask + masked


class _Writer:
    def __init__(self) -> None:
        self.data = bytearray()

    def write(self, chunk: bytes) -> None:
        self.data += chunk

    async def drain(self) -> None:
        return None


def _server(data: bytes) -> tuple[mtuser.ServerWebSocket, _Writer]:
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    writer = _Writer()
    return mtuser.ServerWebSocket(reader, writer), writer  # type: ignore[arg-type]


def test_ws_accept_matches_rfc_example() -> None:
    assert mtuser.ws_accept("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


@pytest.mark.asyncio
async def test_ws_recv_unmasks_answers_ping_and_joins_fragments() -> None:
    big = ("中" * 50_000).encode("utf-8")  # 走 64 位长度
    data = (
        _client_frame(mtuser.OP_PING, b"hb")
        + _client_frame(mtuser.OP_TEXT, b'{"type":', fin=False)
        + _client_frame(mtuser.OP_CONT, b'"input"}')
        + _client_frame(mtuser.OP_TEXT, big)
        + _client_frame(mtuser.OP_CLOSE, struct.pack("!H", 1000))
    )
    ws, writer = _server(data)
    assert await ws.recv() == b'{"type":"input"}'
    assert bytes(writer.data[:4]) == mtuser.ws_frame(mtuser.OP_PONG, b"hb")
    assert await ws.recv() == big
    assert await ws.recv() is None
    assert ws.closed
    assert bytes(writer.data).endswith(mtuser.ws_frame(mtuser.OP_CLOSE, struct.pack("!H", 1000)))


@pytest.mark.asyncio
async def test_ws_rejects_unmasked_and_oversized_frames() -> None:
    ws, _ = _server(bytes([0x81, 0x02]) + b"hi")
    with pytest.raises(mtuser.ProtocolError):
        await ws.recv()
    ws, _ = _server(_client_frame(mtuser.OP_TEXT, b"x" * 10))
    ws.max_message = 5
    with pytest.raises(mtuser.ProtocolError):
        await ws.recv()


def test_server_frames_use_the_right_length_encoding() -> None:
    assert mtuser.ws_frame(mtuser.OP_TEXT, b"a" * 125)[:2] == bytes([0x81, 125])
    assert mtuser.ws_frame(mtuser.OP_TEXT, b"a" * 126)[:4] == bytes([0x81, 126]) + struct.pack("!H", 126)
    assert mtuser.ws_frame(mtuser.OP_TEXT, b"a" * 70_000)[:10] == bytes([0x81, 127]) + struct.pack("!Q", 70_000)


def test_protected_dirs_follow_the_state_manager_links() -> None:
    """附件、图片、生成的媒体经链接指进工作区的这些目录；它们和工作区里的上级目录都不能删、不能改名。"""
    assert {"uploads", "uploads/attachments", "uploads/media", "uploads/media/generated",
            "uploads/media/generated/images", "uploads/media/generated/audio",
            "uploads/media/generated/videos"} == set(mtuser.PROTECTED)


@pytest.mark.parametrize("name", ["", "   ", ".", "..", "a/b", "a\0b", "x" * 256, "中" * 86, None, 3])
def test_bad_names_are_rejected(name) -> None:
    with pytest.raises(mtuser.FileError) as exc:
        mtuser._check_name(name)
    assert exc.value.status == 400 and exc.value.code == "invalid_name"


@pytest.mark.parametrize("name", ["新建文件夹", "report v2.md", ".env.local", "x" * 255])
def test_good_names_pass(name: str) -> None:
    assert mtuser._check_name(name) == name


def test_trash_lives_next_to_the_real_workspace_and_purges_by_id_time(tmp_path: Path) -> None:
    workspace = tmp_path / "vol" / "workspace"
    workspace.mkdir(parents=True)
    files = mtuser.Files(workspace)
    assert files.trash == Path(os.path.realpath(workspace)).parent / ".trash"
    now = time.time()
    old = files.trash / f"{int((now - 8 * 86400) * 1000)}-0123abcd"
    fresh = files.trash / f"{int((now - 86400) * 1000)}-89abcdef"
    stray = files.trash / "not-an-entry"
    for entry in (old, fresh, stray):
        entry.mkdir(parents=True)
        (entry / "meta.json").write_text("{}", encoding="utf-8")
    assert files.purge(keep_s=7 * 86400, now=now) == 1
    assert not old.exists() and fresh.exists() and stray.exists()


def test_purge_without_a_trash_dir_is_a_noop(tmp_path: Path) -> None:
    assert mtuser.Files(tmp_path / "workspace").purge() == 0


def test_restore_rejects_bad_ids(tmp_path: Path) -> None:
    files = mtuser.Files(tmp_path / "workspace")
    for bad in ("../../etc", "1234", None, "1700000000000-XYZ12345"):
        with pytest.raises(mtuser.FileError) as exc:
            files.restore(bad)
        assert exc.value.code == "invalid_id"


@pytest.fixture
def forward(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    spec = importlib.util.spec_from_file_location("forward_mtuser_test", SEED_DIR / "forward.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_user_routes_need_the_session_token(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HERMES_DASHBOARD_SESSION_TOKEN", raising=False)
    assert not forward._user_authorized({}, {})  # 还没引导：谁都不放
    forward._hermes_token = "tok-1"
    assert forward._user_authorized({"x-hermes-session-token": "tok-1"}, {})
    assert forward._user_authorized({}, {"token": ["tok-1"]})  # WebSocket 走查询参数
    assert not forward._user_authorized({"x-hermes-session-token": "tok-2"}, {})
    assert not forward._user_authorized({}, {"token": [""]})


def test_docker_path_falls_back_to_the_container_token(forward, monkeypatch: pytest.MonkeyPatch) -> None:
    """Docker 路径没有引导这一步，令牌在容器环境变量里。"""
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "env-tok")
    forward._hermes_token = ""
    assert forward._user_authorized({"x-hermes-session-token": "env-tok"}, {})
    assert not forward._user_authorized({"x-hermes-session-token": "other"}, {})


@pytest.mark.asyncio
async def test_user_routes_are_closed_while_draining(forward) -> None:
    forward._hermes_token = "tok"
    forward._draining = True
    writer = _Writer()
    await forward._handle_user("GET", "/__mt_user/trash", {"x-hermes-session-token": "tok"}, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 503")


def test_requests_passed_to_hermes_are_closed_after_the_response(forward) -> None:
    """转发器只看每条连接的第一个请求：转给 hermes 的普通请求改成 Connection: close，
    客户端的下一个请求（比如 /__mt_user/…）就会新开连接、重新经过分流。已读进来的请求体原样保留。"""
    head = (b"POST /api/files/upload HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nConnection: keep-alive\r\n"
            b"Keep-Alive: timeout=5\r\nContent-Length: 4\r\n\r\nbody")
    out = forward._close_after(head)
    assert out.startswith(b"POST /api/files/upload HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nContent-Length: 4\r\n")
    assert out.endswith(b"Connection: close\r\n\r\nbody")
    assert b"keep-alive" not in out.lower().replace(b"connection: close", b"")
