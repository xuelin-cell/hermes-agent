"""状态管家（deploy/hermes-mt/seed/mtstate.py）：归档、恢复、校验、主人标记、变化检测。"""

from __future__ import annotations

import io
import json
import os
import sqlite3
import sys
import tarfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"
if str(SEED_DIR) not in sys.path:
    sys.path.insert(0, str(SEED_DIR))

import mtstate  # noqa: E402


def _can_symlink(tmp_path: Path) -> bool:
    try:
        os.symlink(str(tmp_path), str(tmp_path / "_probe_link"))
    except (OSError, NotImplementedError):
        return False
    return True


def _make_db(path: Path, sessions: int = 2, messages: int = 5, heartbeats: int = 1) -> None:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE sessions(id INTEGER PRIMARY KEY, title TEXT)")
    conn.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id INTEGER, body TEXT)")
    conn.execute("CREATE TABLE gateway_heartbeats(backend_id TEXT PRIMARY KEY, ts REAL)")
    conn.execute("CREATE VIRTUAL TABLE messages_fts USING fts5(body)")
    for i in range(sessions):
        conn.execute("INSERT INTO sessions(title) VALUES(?)", (f"s{i}",))
    for i in range(messages):
        conn.execute("INSERT INTO messages(session_id, body) VALUES(?, ?)", (1, f"m{i}"))
    for i in range(heartbeats):
        conn.execute("INSERT INTO gateway_heartbeats VALUES(?, ?)", (f"b{i}", 1.0))
    conn.commit()
    conn.close()


def _make_home(home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    _make_db(home / "state.db")
    (home / "memories").mkdir()
    (home / "memories" / "MEMORY.md").write_text("§ 记住这个\n", encoding="utf-8")
    (home / "memories" / "MEMORY.md.lock").write_text("", encoding="utf-8")
    (home / "skills" / "foo").mkdir(parents=True)
    (home / "skills" / "foo" / "SKILL.md").write_text("# foo\n", encoding="utf-8")
    (home / "skills" / ".usage.json").write_text('{"foo": 1}', encoding="utf-8")
    (home / "skills" / ".bundled_manifest").write_text("foo:abc\n", encoding="utf-8")
    (home / "config.yaml").write_text("_config_version: 39\nmodel:\n  default: \"x\"\n", encoding="utf-8")
    (home / ".env").write_text("TERMINAL_ENV=local\nUSER_OWN_KEY=abc\n", encoding="utf-8")
    (home / "logs").mkdir()
    (home / "logs" / "agent.log").write_text("noise\n", encoding="utf-8")
    (home / "cache" / "web").mkdir(parents=True)
    (home / "cache" / "web" / "page.html").write_text("<html>", encoding="utf-8")
    (home / "home" / ".ssh").mkdir(parents=True)
    (home / "home" / ".ssh" / "id_ed25519").write_text("key", encoding="utf-8")
    (home / "home" / ".gitconfig").write_text("[user]\n", encoding="utf-8")
    (home / "home" / ".cache").mkdir()
    (home / "home" / ".cache" / "pip.bin").write_bytes(b"\x00" * 10)
    (home / "sessions").mkdir()
    (home / "sessions" / "request_dump_1.json").write_text("{}", encoding="utf-8")
    (home / "sessions" / "saved").mkdir()
    (home / "sessions" / "saved" / "a.json").write_text("{}", encoding="utf-8")
    (home / "config.yaml.bak-20260101T000000Z").write_text("old", encoding="utf-8")
    (home / "spawn-ledger.json").write_text("{}", encoding="utf-8")
    (home / "kanban").mkdir()
    _make_db(home / "kanban" / "kanban.db", sessions=1, messages=0)
    (home / "workspace").mkdir()
    (home / "workspace" / "big.bin").write_bytes(b"x" * 100)


def _mgr(home: Path, vol: Path, owner: str, epoch: int) -> mtstate.StateManager:
    return mtstate.StateManager(home, vol, owner, epoch, work=vol.parent / f"work-{owner}", require_mount=False)


def test_collect_separates_dbs_and_applies_exclusions(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _make_home(home)
    files, dbs = mtstate.collect(home)
    files_s = {str(p).replace(os.sep, "/") for p in files}
    dbs_s = {str(p).replace(os.sep, "/") for p in dbs}
    assert dbs_s == {"state.db", "kanban/kanban.db"}
    assert "memories/MEMORY.md" in files_s
    assert "skills/foo/SKILL.md" in files_s
    assert "skills/.bundled_manifest" in files_s
    assert "home/.ssh/id_ed25519" in files_s
    assert "home/.gitconfig" in files_s
    assert "sessions/saved/a.json" in files_s
    for excluded in ("logs/agent.log", "cache/web/page.html", "home/.cache/pip.bin", "workspace/big.bin",
                     "sessions/request_dump_1.json", "config.yaml.bak-20260101T000000Z",
                     "memories/MEMORY.md.lock", "spawn-ledger.json"):
        assert excluded not in files_s, excluded


def test_archive_then_restore_round_trip(tmp_path: Path) -> None:
    home = tmp_path / "home"
    vol = tmp_path / "vol"
    vol.mkdir()
    _make_home(home)
    mgr = _mgr(home, vol, "sbA", 1)
    mtstate.ensure_layout(vol)
    mtstate.write_owner(vol / ".state", "sbA", 1)
    manifest = mgr.archive(force=True)
    assert manifest is not None
    gen = vol / ".state" / "e000001-sbA"
    assert (gen / manifest.archive).is_file()
    assert (gen / "LATEST").read_text() == manifest.archive
    assert manifest.dbs["state.db"] == {"sessions": 2, "messages": 5}  # 心跳表与 FTS 影子表不计
    assert manifest.sha256

    # 新实例：空的 home，只有模板种下的默认技能和残留的 -wal
    home2 = tmp_path / "home2"
    home2.mkdir()
    (home2 / "skills" / "builtin").mkdir(parents=True)
    (home2 / "skills" / "builtin" / "SKILL.md").write_text("template default", encoding="utf-8")
    (home2 / "state.db-wal").write_bytes(b"garbage")
    mgr2 = _mgr(home2, vol, "sbB", 2)
    rep = mgr2.prepare(restore_from="sbA", migrate=False) if _can_symlink(tmp_path) else None
    if rep is None:
        # 没有符号链接权限的机器（Windows 默认）：只验恢复本体
        result = mtstate.restore_archive(home2, gen, manifest)
        assert result["counts"]["state.db"] == {"sessions": 2, "messages": 5}
    else:
        assert rep.restored_from == "sbA"
        assert rep.archive == manifest.archive
        assert mtstate.read_owner(vol / ".state") == mtstate.Owner("sbB", 2)
        assert (home2 / "workspace").is_symlink()
        assert (home2 / "scratch").is_dir()
    assert not (home2 / "state.db-wal").exists()
    assert not (home2 / "skills" / "builtin").exists()  # 整体替换：模板默认技能不回来
    assert (home2 / "skills" / "foo" / "SKILL.md").read_text(encoding="utf-8") == "# foo\n"
    assert (home2 / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "§ 记住这个\n"
    assert (home2 / ".env").read_text(encoding="utf-8") == "TERMINAL_ENV=local\nUSER_OWN_KEY=abc\n"
    assert (home2 / "home" / ".ssh" / "id_ed25519").is_file()
    conn = sqlite3.connect(home2 / "state.db")
    assert conn.execute("SELECT count(*) FROM messages").fetchone()[0] == 5
    conn.close()
    assert mtstate.db_counts(home2 / "kanban" / "kanban.db") == {"sessions": 1, "messages": 0}


def test_signature_ignores_heartbeat_and_usage_but_sees_messages(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _make_home(home)
    s0 = mtstate.signature(home)
    conn = sqlite3.connect(home / "state.db")
    conn.execute("UPDATE gateway_heartbeats SET ts = 2.0")
    conn.commit()
    conn.close()
    (home / "skills" / ".usage.json").write_text('{"foo": 2}', encoding="utf-8")
    assert mtstate.signature(home) == s0
    conn = sqlite3.connect(home / "state.db")
    conn.execute("INSERT INTO messages(session_id, body) VALUES(1, 'new')")
    conn.commit()
    conn.close()
    assert mtstate.signature(home) != s0


def test_archive_skips_when_unchanged_and_when_skills_upgrading(tmp_path: Path) -> None:
    home = tmp_path / "home"
    vol = tmp_path / "vol"
    vol.mkdir()
    _make_home(home)
    mgr = _mgr(home, vol, "sbA", 1)
    mtstate.ensure_layout(vol)
    mtstate.write_owner(vol / ".state", "sbA", 1)
    assert mgr.archive(force=True) is not None
    assert mgr.archive(force=False) is None  # 没变化
    (home / "memories" / "MEMORY.md").write_text("§ 变了\n", encoding="utf-8")
    (home / "skills" / "foo.bak").mkdir()
    assert mgr.archive(force=False) is None  # 技能正在升级
    (home / "skills" / "foo.bak").rmdir()
    assert mgr.archive(force=False) is not None


def test_fencing_stops_writes_when_owner_changed(tmp_path: Path) -> None:
    home = tmp_path / "home"
    vol = tmp_path / "vol"
    vol.mkdir()
    _make_home(home)
    mgr = _mgr(home, vol, "sbA", 1)
    mtstate.ensure_layout(vol)
    mtstate.write_owner(vol / ".state", "sbA", 1)
    assert mgr.archive(force=True) is not None
    mtstate.write_owner(vol / ".state", "sbB", 2)  # 新实例接管
    with pytest.raises(mtstate.OwnerLost):
        mgr.archive(force=True)
    assert mgr.phase == "fenced"


def test_prepare_refuses_when_volume_is_newer_than_entry(tmp_path: Path) -> None:
    home = tmp_path / "home"
    vol = tmp_path / "vol"
    vol.mkdir()
    home.mkdir()
    mtstate.ensure_layout(vol)
    mtstate.write_owner(vol / ".state", "sbOld", 5)
    # PG 回滚：新实例拿到的编号不比卷上的大
    with pytest.raises(mtstate.RefuseStart):
        _mgr(home, vol, "sbNew", 5).prepare(restore_from="sbOld", migrate=False)
    # PG 丢了：没给恢复来源
    with pytest.raises(mtstate.RefuseStart):
        _mgr(home, vol, "sbNew", 6).prepare(restore_from="", migrate=False)
    # 来源没有归档：不能以空库启动
    with pytest.raises(mtstate.StateError):
        _mgr(home, vol, "sbNew", 6).prepare(restore_from="sbOld", migrate=False)


@pytest.mark.skipif(sys.platform == "win32", reason="需要符号链接权限")
def test_prepare_prefers_newer_owner_on_volume(tmp_path: Path) -> None:
    """上一代引导成功但入口没记上：卷上的 OWNER 比入口给的来源新，且它留了归档，就从它恢复。"""
    vol = tmp_path / "vol"
    vol.mkdir()
    mtstate.ensure_layout(vol)
    home_a = tmp_path / "a"
    _make_home(home_a)
    mtstate.write_owner(vol / ".state", "sbA", 1)
    _mgr(home_a, vol, "sbA", 1).archive(force=True)
    home_b = tmp_path / "b"
    _make_home(home_b)
    conn = sqlite3.connect(home_b / "state.db")
    conn.execute("INSERT INTO messages(session_id, body) VALUES(1, 'newer')")
    conn.commit()
    conn.close()
    mtstate.write_owner(vol / ".state", "sbB", 2)
    _mgr(home_b, vol, "sbB", 2).archive(force=True)
    home_c = tmp_path / "c"
    home_c.mkdir()
    rep = _mgr(home_c, vol, "sbC", 3).prepare(restore_from="sbA", migrate=False)
    assert rep.restored_from == "sbB"
    assert rep.counts["state.db"]["messages"] == 6


def test_prepare_follows_parent_chain_when_source_never_archived(tmp_path: Path) -> None:
    """上一代刚建好还没归档就没了：沿 PARENT 退到更早那一代的归档，而不是拒绝启动。"""
    vol = tmp_path / "vol"
    vol.mkdir()
    state_dir = mtstate.ensure_layout(vol)
    home_a = tmp_path / "a"
    _make_home(home_a)
    mtstate.write_owner(state_dir, "sbA", 1)
    _mgr(home_a, vol, "sbA", 1).archive(force=True)
    # 第二代：只写了谱系和主人标记，没归档
    gen_b = state_dir / mtstate.gen_dirname(2, "sbB")
    gen_b.mkdir()
    (gen_b / mtstate.PARENT_FILE).write_text("sbA", encoding="utf-8")
    mtstate.write_owner(state_dir, "sbB", 2)
    home_c = tmp_path / "c"
    home_c.mkdir()
    rep = _mgr(home_c, vol, "sbC", 3).prepare(restore_from="sbB", migrate=False) if _can_symlink(tmp_path) else None
    if rep is None:
        resolved = mtstate._resolve_chain(state_dir, "sbB", [])
        assert resolved is not None and resolved[0] == "sbA"
        return
    assert rep.restored_from == "sbA"
    assert any("沿谱系" in n for n in rep.notes)
    assert (state_dir / mtstate.gen_dirname(3, "sbC") / mtstate.PARENT_FILE).read_text(encoding="utf-8") == "sbA"


def test_restore_rejects_symlink_members_and_traversal(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    gen = tmp_path / "gen"
    gen.mkdir()
    for bad in ("link", "traversal"):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            if bad == "link":
                info = tarfile.TarInfo("memories/evil")
                info.type = tarfile.SYMTYPE
                info.linkname = "/etc/passwd"
                tar.addfile(info)
            else:
                info = tarfile.TarInfo("../outside.txt")
                data = b"x"
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        name = f"2026010{1 if bad == 'link' else 2}T000000Z.tar.gz"
        (gen / name).write_bytes(buf.getvalue())
        manifest = mtstate.Manifest(owner="x", epoch=1, parent="", created_at=name[:16], archive=name,
                                    size=len(buf.getvalue()), sha256=mtstate._sha256_file(gen / name), files=1)
        with pytest.raises(mtstate.StateError):
            mtstate.restore_archive(home, gen, manifest)
    assert not (tmp_path / "outside.txt").exists()
    assert not (home / "memories").exists()


def test_restore_detects_zeroed_db(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    gen = tmp_path / "gen"
    gen.mkdir()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("state.db")
        data = b"\x00" * 4096
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    name = "20260101T000000Z.tar.gz"
    (gen / name).write_bytes(buf.getvalue())
    manifest = mtstate.Manifest(owner="x", epoch=1, parent="", created_at=name[:16], archive=name,
                                size=len(buf.getvalue()), sha256=mtstate._sha256_file(gen / name), files=1,
                                dbs={"state.db": {"sessions": 1}})
    with pytest.raises(mtstate.StateError, match="不是 SQLite"):
        mtstate.restore_archive(home, gen, manifest)


def test_restore_rejects_hash_mismatch(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    gen = tmp_path / "gen"
    gen.mkdir()
    name = "20260101T000000Z.tar.gz"
    (gen / name).write_bytes(b"not really")
    manifest = mtstate.Manifest(owner="x", epoch=1, parent="", created_at=name[:16], archive=name,
                                size=10, sha256="0" * 64, files=0)
    with pytest.raises(mtstate.StateError, match="哈希"):
        mtstate.restore_archive(home, gen, manifest)


def test_select_keep_tiers() -> None:
    now = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
    names = []
    for minutes in (0, 5, 10, 30, 59):
        names.append((now - timedelta(minutes=minutes)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz")
    for hours in (2, 3, 26, 27, 24 * 3, 24 * 10, 24 * 11, 24 * 40):
        names.append((now - timedelta(hours=hours)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz")
    keep = mtstate.select_keep(names, now=now)
    recent = {n for n in names if now - mtstate._parse_stamp(n) <= timedelta(hours=1)}
    assert recent <= keep
    two_h = (now - timedelta(hours=2)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz"
    three_h = (now - timedelta(hours=3)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz"
    assert two_h in keep and three_h not in keep  # 同一天只留最新
    assert (now - timedelta(hours=24 * 10)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz" in keep
    assert (now - timedelta(hours=24 * 11)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz" not in keep  # 同一周只留一份
    assert (now - timedelta(hours=24 * 40)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz" not in keep  # 超过 4 周


def test_env_upsert_keeps_user_lines(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("TERMINAL_ENV=docker\nUSER_KEY=keep\n# comment\n", encoding="utf-8")
    mtstate.env_upsert(env, ["TERMINAL_ENV=local", "PLATFORM_KEY=new"])
    assert env.read_text(encoding="utf-8") == "TERMINAL_ENV=local\nUSER_KEY=keep\n# comment\nPLATFORM_KEY=new\n"
    mtstate.env_upsert(tmp_path / "fresh.env", ["A=1"])
    assert (tmp_path / "fresh.env").read_text(encoding="utf-8") == "A=1\n"


def test_patch_config_file_only_touches_platform_lines(tmp_path: Path) -> None:
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "_config_version: 39\nmodel:\n  default: \"old\"\n  provider: \"yuanjing\"\n  base_url: \"http://old\"\n"
        "providers:\n  yuanjing:\n    api: \"http://old\"\n    default_model: \"old\"\n    models:\n      old: {}\n\n"
        "terminal:\n  cwd: \"/opt/data/workspace\"\n  user_setting: 1\n",
        encoding="utf-8",
    )
    changed = mtstate.patch_config_file(cfg, {"base_url": "http://new/v1", "model": "m1", "provider_key": "yuanjing", "models": ["m1", "m2"]})
    assert changed
    text = cfg.read_text(encoding="utf-8")
    assert '  default: "m1"' in text and '  base_url: "http://new/v1"' in text
    assert "      m1: {}\n      m2: {}\n" in text and "old: {}" not in text
    assert "user_setting: 1" in text
    assert not mtstate.patch_config_file(cfg, {"base_url": "http://new/v1", "model": "m1", "provider_key": "yuanjing", "models": ["m1", "m2"]})


def test_manifest_json_round_trip() -> None:
    m = mtstate.Manifest(owner="a", epoch=3, parent="b", created_at="20260101T000000Z", archive="x.tar.gz",
                         size=1, sha256="ff", files=2, dbs={"state.db": {"messages": 4}})
    assert mtstate.Manifest.from_json(m.to_json()) == m
    assert json.loads(m.to_json())["version"] == mtstate.MANIFEST_VERSION


def test_links_include_generated_media_under_images_root(tmp_path: Path) -> None:
    """生成媒体的三条链接落在 images 根之下，且上级目录 cache/ 不存在时也能建；重复调用幂等。"""
    if not _can_symlink(tmp_path):
        pytest.skip("本机没有建符号链接的权限")
    home = tmp_path / "home"
    vol = tmp_path / "vol"
    home.mkdir()
    vol.mkdir()
    mtstate.ensure_layout(vol)
    changed = mtstate.ensure_links(home, vol)
    assert set(changed) == {name for name, _ in mtstate.LINKS}
    for name, rel in mtstate.LINKS:
        link = home / name
        assert link.is_symlink(), name
        assert link.resolve() == (vol / rel).resolve()
        assert (vol / rel).is_dir(), rel
    # 生成媒体必须在 images 根（仪表盘 /api/media 认的根）之下
    images_root = (home / "images").resolve()
    for name in ("cache/images", "cache/audio", "cache/videos"):
        assert images_root in (home / name).resolve().parents, name
    # 已有的旧内容会被搬进卷，再换成链接
    assert mtstate.ensure_links(home, vol) == []
    (home / "cache" / "images").unlink()
    (home / "cache" / "images").mkdir()
    (home / "cache" / "images" / "old.png").write_bytes(b"x")
    assert mtstate.ensure_links(home, vol) == ["cache/images"]
    assert (vol / "workspace/uploads/media/generated/images/old.png").read_bytes() == b"x"
    assert (home / "cache" / "images").is_symlink()


def test_archive_skips_cache_even_with_links(tmp_path: Path) -> None:
    """cache/ 整个在归档排除清单里：生成媒体在卷上，不该再被打进归档。"""
    if not _can_symlink(tmp_path):
        pytest.skip("本机没有建符号链接的权限")
    home = tmp_path / "home"
    vol = tmp_path / "vol"
    vol.mkdir()
    _make_home(home)
    mtstate.ensure_layout(vol)
    mtstate.ensure_links(home, vol)
    (vol / "workspace/uploads/media/generated/images/gen.png").write_bytes(b"png")
    files, dbs = mtstate.collect(home)
    files_s = {str(f).replace("\\", "/") for f in files}
    assert not any(f.startswith("cache/") for f in files_s)
    assert not any("generated" in f for f in files_s)
