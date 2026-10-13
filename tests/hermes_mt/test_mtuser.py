"""转发器给用户用的接口（deploy/hermes-mt/seed/mtuser.py + forward.py 的 /__mt_user/ 分流）。

pty 和真实文件操作要 Linux：容器里的整链路测试见 handover/tools/fwdtest/driver_batch2.py。
这里测与平台无关的部分：WebSocket 帧、受保护目录、名字校验、回收站过期清理、令牌校验，
以及 Office 预览（用假的 soffice：真 LibreOffice 的转换在实例镜像里验）。
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import json
import struct
import sys
import time
from pathlib import Path
from urllib.parse import quote

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


# ---------------------------------------------------------------- Office 文件预览（转 PDF、按页出图）

FAKE_SOFFICE = """
import os, sys, time
args = sys.argv[1:]
log = os.environ["FAKE_SOFFICE_LOG"]
with open(log, "a", encoding="utf-8") as fh:
    fh.write(repr(args) + "\\n")
mode = os.environ.get("FAKE_SOFFICE_MODE", "ok")
if mode == "fail":
    print("Error: source file could not be loaded")
    sys.exit(1)
if mode == "sleep":
    time.sleep(30)
outdir = args[args.index("--outdir") + 1]
source = args[-1]
stem = os.path.splitext(os.path.basename(source))[0]
with open(source, "rb") as src, open(os.path.join(outdir, stem + ".pdf"), "wb") as out:
    out.write(b"%PDF-1.4 fake of " + src.read())
"""

# poppler 的两个命令：pdfinfo 报 3 页、720 x 405 磅；pdftoppm 照 -singlefile 的样子写 <输出前缀>.jpg。
FAKE_PDFINFO = """
print("Producer:       LibreOffice")
print("Pages:          3")
print("Page size:      720 x 405 pts")
"""

FAKE_PDFTOPPM = """
import os, sys
args = sys.argv[1:]
page = args[args.index("-f") + 1]
# 每次调用各记一个文件：两个进程同时追加同一个文件，Windows 上会丢行
with open(os.path.join(os.environ["FAKE_PDFTOPPM_LOG"], "call-%s-%d" % (page, os.getpid())), "w") as fh:
    fh.write(repr(args))
with open(args[-1] + ".jpg", "wb") as out:
    out.write(b"JPEG page " + page.encode())
"""


@pytest.fixture
def office(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """工作区 + 假 soffice（照真的那样在 --outdir 里写 <名字>.pdf，并把每次的参数记下来）。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    script = tmp_path / "fake_soffice.py"
    script.write_text(FAKE_SOFFICE, encoding="utf-8")
    log = tmp_path / "soffice.log"
    monkeypatch.setenv("FAKE_SOFFICE_LOG", str(log))
    monkeypatch.setattr(mtuser, "soffice_command", lambda: [sys.executable, str(script)])
    tools = {}
    for name, body in (("pdfinfo", FAKE_PDFINFO), ("pdftoppm", FAKE_PDFTOPPM)):
        tools[name] = tmp_path / f"fake_{name}.py"
        tools[name].write_text(body, encoding="utf-8")
    (tmp_path / "pdftoppm-calls").mkdir()
    monkeypatch.setenv("FAKE_PDFTOPPM_LOG", str(tmp_path / "pdftoppm-calls"))
    monkeypatch.setattr(mtuser, "poppler_command", lambda name: [sys.executable, str(tools[name])])
    preview = mtuser.OfficePreview(workspace, cache_dir=tmp_path / "cache")
    preview.log = log  # type: ignore[attr-defined]
    preview.render_log = tmp_path / "pdftoppm-calls"  # type: ignore[attr-defined]
    return preview


def _calls(preview) -> list[str]:
    return preview.log.read_text(encoding="utf-8").splitlines() if preview.log.exists() else []


def test_office_preview_only_takes_office_files_in_the_workspace(office, tmp_path: Path, monkeypatch) -> None:
    ws = office.files.workspace
    (ws / "deck.pptx").write_bytes(b"PK deck")
    (ws / "notes.txt").write_text("x", encoding="utf-8")
    (ws / "folder.docx").mkdir()
    (tmp_path / "outside.pptx").write_bytes(b"PK")
    cases = {
        "relative.pptx": "invalid_path",
        str(tmp_path / "outside.pptx"): "outside",
        str(ws / "notes.txt"): "unsupported",
        str(ws / "gone.xlsx"): "not_found",
        str(ws / "folder.docx"): "not_found",
    }
    for path, code in cases.items():
        with pytest.raises(mtuser.FileError) as exc:
            office.locate(path)
        assert exc.value.code == code, path
    real, st = office.locate(str(ws / "deck.pptx"))
    assert real.name == "deck.pptx" and st.st_size == 7
    monkeypatch.setattr(mtuser, "OFFICE_MAX_BYTES", 3)
    with pytest.raises(mtuser.FileError) as exc:
        office.locate(str(ws / "deck.pptx"))
    assert exc.value.code == "too_large" and exc.value.status == 413


@pytest.mark.asyncio
async def test_office_preview_converts_a_copy_once_and_reuses_it(office) -> None:
    ws = office.files.workspace
    deck = ws / "新疆 文旅.PPTX"
    deck.write_bytes(b"PK v1")
    first, again, *rest = await asyncio.gather(*(office.pdf(str(deck)) for _ in range(4)))
    assert first == again and all(p == first for p in rest)
    assert first.read_bytes() == b"%PDF-1.4 fake of PK v1"
    calls = _calls(office)
    assert len(calls) == 1  # 四个请求只转了一次
    # 转的是工作目录里的 ASCII 副本，配置目录指到缓存目录；工作区里不留任何东西
    assert "source.pptx" in calls[0] and "-env:UserInstallation=file:" in calls[0]
    assert sorted(p.name for p in ws.iterdir()) == ["新疆 文旅.PPTX"]
    assert [p.name for p in office.cache_dir.iterdir() if p.name.startswith("job-")] == []
    assert await office.pdf(str(deck)) == first and len(_calls(office)) == 1
    # 文件改了就重新转
    deck.write_bytes(b"PK version 2")
    os.utime(deck, (time.time() + 5, time.time() + 5))
    second = await office.pdf(str(deck))
    assert second != first and second.read_bytes().endswith(b"PK version 2") and len(_calls(office)) == 2


@pytest.mark.asyncio
async def test_office_preview_reports_why_it_could_not_convert(office, monkeypatch: pytest.MonkeyPatch) -> None:
    deck = office.files.workspace / "broken.docx"
    deck.write_bytes(b"not really")
    monkeypatch.setenv("FAKE_SOFFICE_MODE", "fail")
    with pytest.raises(mtuser.FileError) as exc:
        await office.pdf(str(deck))
    assert exc.value.code == "convert_failed" and "could not be loaded" in exc.value.message
    monkeypatch.setenv("FAKE_SOFFICE_MODE", "sleep")
    monkeypatch.setattr(mtuser, "OFFICE_TIMEOUT_S", 1.0)
    with pytest.raises(mtuser.FileError) as exc:
        await office.pdf(str(deck))
    assert exc.value.code == "timeout" and exc.value.status == 504
    monkeypatch.setattr(mtuser, "soffice_command", lambda: None)
    with pytest.raises(mtuser.FileError) as exc:
        await office.pdf(str(deck))
    assert exc.value.code == "unavailable"
    # 失败的不进缓存：下次还会再试
    assert list(office.cache_dir.glob("*/doc.pdf")) == []


@pytest.mark.asyncio
async def test_slides_are_rendered_page_by_page_once(office) -> None:
    """幻灯片查看器先问页数和版本号，再一页一页地要图；每页只出一次图，文件一改版本号就变。"""
    deck = office.files.workspace / "deck.pptx"
    deck.write_bytes(b"PK deck")
    info = await office.info(str(deck))
    assert info["pages"] == 3 and (info["width"], info["height"]) == (720.0, 405.0)
    assert len(info["version"]) == 40
    pages = await asyncio.gather(office.page(str(deck), "2"), office.page(str(deck), 2), office.page(str(deck), "1"))
    (v2, img2), again, (_, img1) = pages
    assert v2 == info["version"] and again == (v2, img2)
    assert img2.read_bytes() == b"JPEG page 2" and img1.read_bytes() == b"JPEG page 1"
    renders = sorted(f.name.rsplit("-", 1)[0] for f in office.render_log.iterdir())
    assert renders == ["call-1", "call-2"]  # 第 2 页要了两次，只出了一次图
    args = next(office.render_log.glob("call-2-*")).read_text()
    assert "-singlefile" in args and "1600" in args
    assert sorted(p.name for p in img2.parent.iterdir()) == ["doc.pdf", "info.json", "p1.jpg", "p2.jpg"]
    for bad, code in (("4", "no_page"), ("0", "no_page"), ("x", "invalid_page"), ("", "invalid_page")):
        with pytest.raises(mtuser.FileError) as exc:
            await office.page(str(deck), bad)
        assert exc.value.code == code, bad
    deck.write_bytes(b"PK deck, edited")
    os.utime(deck, (time.time() + 5, time.time() + 5))
    assert (await office.info(str(deck)))["version"] != info["version"]


@pytest.mark.asyncio
async def test_slides_say_so_without_poppler(office, monkeypatch: pytest.MonkeyPatch) -> None:
    deck = office.files.workspace / "deck.pptx"
    deck.write_bytes(b"PK deck")
    monkeypatch.setattr(mtuser, "poppler_command", lambda name: None)
    with pytest.raises(mtuser.FileError) as exc:
        await office.info(str(deck))
    assert exc.value.code == "unavailable" and exc.value.status == 501


def test_office_preview_keeps_the_most_recent_files(office) -> None:
    cache = office.cache_dir
    cache.mkdir()
    now = time.time()
    keys = [f"{i:040x}" for i in range(33)]  # 一个文件一个目录，目录名是 40 位版本号
    for i, key in enumerate(keys):
        folder = cache / key
        folder.mkdir()
        (folder / "doc.pdf").write_bytes(b"%PDF")
        (folder / "p1.jpg").write_bytes(b"JPEG")
        os.utime(folder, (now - i, now - i))
    stale, fresh, home = cache / "job-stale", cache / "job-fresh", cache / "home"
    for folder in (stale, fresh, home):
        folder.mkdir()
    os.utime(stale, (now - 7200, now - 7200))
    os.utime(home, (now - 7200, now - 7200))
    assert office.prune(keep=30, now=now) == 4
    assert sorted(p.name for p in cache.iterdir() if len(p.name) == 40) == keys[:30]
    assert fresh.exists() and home.exists() and not stale.exists()
    # 总量也有上限（每个 8 字节，上限 20 字节 ⇒ 留最新两个）；最新那个再大也留着
    assert office.prune(keep=30, max_bytes=20, now=now) == 28
    assert sorted(p.name for p in cache.iterdir() if len(p.name) == 40) == keys[:2]
    assert office.prune(keep=30, max_bytes=1, now=now) == 1
    assert [p.name for p in cache.iterdir() if len(p.name) == 40] == keys[:1]


@pytest.mark.asyncio
async def test_office_route_answers_with_the_pdf(forward, office, monkeypatch: pytest.MonkeyPatch) -> None:
    forward._hermes_token = "tok"
    forward._office = office
    deck = office.files.workspace / "deck.xlsx"
    deck.write_bytes(b"PK sheet")
    auth = {"x-hermes-session-token": "tok"}
    query = "path=" + quote(str(deck))
    writer = _Writer()
    await forward._handle_user("GET", f"/__mt_user/office-pdf?{query}", auth, b"", None, writer)
    head, _, body = bytes(writer.data).partition(b"\r\n\r\n")
    assert head.startswith(b"HTTP/1.1 200") and b"Content-Type: application/pdf" in head
    assert f"Content-Length: {len(body)}".encode() in head and body == b"%PDF-1.4 fake of PK sheet"
    writer = _Writer()
    await forward._handle_user("POST", f"/__mt_user/office-pdf?{query}", auth, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 405")
    writer = _Writer()
    await forward._handle_user("GET", "/__mt_user/office-pdf?path=%2Fetc%2Fpasswd.docx", auth, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 40") and b'"code": "' in writer.data
    writer = _Writer()
    await forward._handle_user("GET", f"/__mt_user/office-pdf?{query}", {}, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 403")


@pytest.mark.asyncio
async def test_slide_routes_answer_with_pages_and_images(forward, office) -> None:
    forward._hermes_token = "tok"
    forward._office = office
    deck = office.files.workspace / "deck.pptx"
    deck.write_bytes(b"PK deck")
    auth = {"x-hermes-session-token": "tok"}
    query = "path=" + quote(str(deck))
    writer = _Writer()
    await forward._handle_user("GET", f"/__mt_user/office-preview?{query}", auth, b"", None, writer)
    head, _, body = bytes(writer.data).partition(b"\r\n\r\n")
    info = json.loads(body)
    assert head.startswith(b"HTTP/1.1 200") and info["ok"] is True and info["pages"] == 3
    writer = _Writer()
    await forward._handle_user("GET", f"/__mt_user/office-preview/page?{query}&n=2&v={info['version']}",
                               auth, b"", None, writer)
    head, _, body = bytes(writer.data).partition(b"\r\n\r\n")
    assert head.startswith(b"HTTP/1.1 200") and b"Content-Type: image/jpeg" in head and body == b"JPEG page 2"
    assert b"Cache-Control: private, max-age=86400" in head  # 版本对得上：浏览器可以缓存
    writer = _Writer()
    await forward._handle_user("GET", f"/__mt_user/office-preview/page?{query}&n=2&v=old", auth, b"", None, writer)
    assert b"Cache-Control: no-store" in bytes(writer.data)
    writer = _Writer()
    await forward._handle_user("GET", f"/__mt_user/office-preview/page?{query}&n=9", auth, b"", None, writer)
    assert writer.data.startswith(b"HTTP/1.1 404") and b'"code": "no_page"' in writer.data


def test_requests_passed_to_hermes_are_closed_after_the_response(forward) -> None:
    """转发器只看每条连接的第一个请求：转给 hermes 的普通请求改成 Connection: close，
    客户端的下一个请求（比如 /__mt_user/…）就会新开连接、重新经过分流。已读进来的请求体原样保留。"""
    head = (b"POST /api/files/upload HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nConnection: keep-alive\r\n"
            b"Keep-Alive: timeout=5\r\nContent-Length: 4\r\n\r\nbody")
    out = forward._close_after(head)
    assert out.startswith(b"POST /api/files/upload HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nContent-Length: 4\r\n")
    assert out.endswith(b"Connection: close\r\n\r\nbody")
    assert b"keep-alive" not in out.lower().replace(b"connection: close", b"")
