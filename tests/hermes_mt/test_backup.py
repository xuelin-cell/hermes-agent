"""卷外副本任务：用内存里的假 S3 验「找最新归档 → 核对清单 → 拷贝 → 跳过已拷 → 清旧副本」。"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from entry.backup import BackupJob, select_keep
from entry.config import Settings
from entry.s3lite import S3Error


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.meta: dict[str, dict] = {}
        self.log: list[tuple[str, str]] = []

    async def list(self, prefix):
        self.log.append(("list", prefix))
        return [{"key": k, "size": len(v), "last_modified": ""} for k, v in sorted(self.objects.items()) if k.startswith(prefix)]

    async def get_bytes(self, key, max_bytes=4 * 1024 * 1024):
        self.log.append(("get", key))
        return self.objects.get(key)

    async def get_to_file(self, key, dest: Path):
        self.log.append(("get_file", key))
        if key not in self.objects:
            raise S3Error(404, "no such key")
        data = self.objects[key]
        dest.write_bytes(data)
        return len(data), hashlib.sha256(data).hexdigest()

    async def put_file(self, key, src: Path, sha256_hex, content_type="application/octet-stream", metadata=None):
        data = src.read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha256_hex
        self.log.append(("put", key))
        self.objects[key] = data
        self.meta[key] = dict(metadata or {})

    async def put_bytes(self, key, data, content_type="application/json", metadata=None):
        self.log.append(("put", key))
        self.objects[key] = data
        self.meta[key] = dict(metadata or {})

    async def head(self, key):
        if key not in self.objects:
            return None
        return {"size": len(self.objects[key]), "metadata": dict(self.meta.get(key, {}))}

    async def delete(self, key):
        self.log.append(("delete", key))
        self.objects.pop(key, None)


class FakeStore:
    def __init__(self):
        self.audits: list[tuple[str, str, dict]] = []

    async def write_audit(self, user_id, event_type, details=None):
        self.audits.append((user_id, event_type, details or {}))


def _settings(**over) -> Settings:
    base = dict(backend="cube", backup_s3_endpoint="http://s3", backup_s3_bucket="b",
                backup_s3_access_key="ak", backup_s3_secret_key="sk")
    base.update(over)
    return Settings(**base)


def _put_archive(s3: FakeS3, prefix: str, gen: str, stamp: str, payload: bytes, latest: bool = True) -> None:
    s3.objects[f"{prefix}{gen}/{stamp}.tar.gz"] = payload
    manifest = {"owner": gen.split("-", 1)[1], "epoch": int(gen[1:7]), "archive": f"{stamp}.tar.gz",
                "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(), "version": 1}
    s3.objects[f"{prefix}{gen}/{stamp}.json"] = json.dumps(manifest).encode()
    if latest:
        s3.objects[f"{prefix}{gen}/LATEST"] = f"{stamp}.tar.gz".encode()


def _job(s3: FakeS3, store: FakeStore, users: list[str], **over) -> BackupJob:
    async def candidates():
        return users
    return BackupJob(_settings(**over), store, s3, lambda uid: f"vol-{uid}", candidates)  # type: ignore[arg-type]


VOL = "volumes/vol-u1/.state/"


@pytest.mark.asyncio
async def test_copies_latest_archive_of_owner_generation_then_skips() -> None:
    s3, store = FakeS3(), FakeStore()
    _put_archive(s3, VOL, "e000001-aaaa0000", "20260930T010000Z", b"old gen")
    _put_archive(s3, VOL, "e000002-bbbb0000", "20260930T020000Z", b"first of gen 2")
    _put_archive(s3, VOL, "e000002-bbbb0000", "20260930T030000Z", b"newest of gen 2")
    s3.objects[f"{VOL}OWNER"] = json.dumps({"owner": "bbbb0000", "epoch": 2, "at": "x"}).encode()
    s3.meta[f"{VOL}e000002-bbbb0000/20260930T030000Z.tar.gz"] = {"uid": "10000", "gid": "10000", "mode": "33188"}
    job = _job(s3, store, ["u1"])

    summary = await job.run_once()
    assert (summary.copied, summary.skipped, summary.failed) == (1, 0, 0)
    dest = "backups/hermes-mt/u1/e000002-bbbb0000/20260930T030000Z"
    assert s3.objects[dest + ".tar.gz"] == b"newest of gen 2"
    assert s3.meta[dest + ".tar.gz"] == {"uid": "10000", "gid": "10000", "mode": "33188"}  # s3fs 元数据跟着副本走
    assert json.loads(s3.objects[dest + ".json"])["sha256"] == hashlib.sha256(b"newest of gen 2").hexdigest()
    assert store.audits[-1][1] == "backup.copy" and store.audits[-1][2]["archive"] == "20260930T030000Z.tar.gz"
    # 卷上的东西一个字节没动
    assert all(k in s3.objects for k in (f"{VOL}OWNER", f"{VOL}e000001-aaaa0000/LATEST"))
    assert not any(op == "delete" and key.startswith("volumes/") for op, key in s3.log)

    # 第二轮：同名同大小 ⇒ 跳过，不再下载
    s3.log.clear()
    summary = await job.run_once()
    assert (summary.copied, summary.skipped) == (0, 1)
    assert not any(op == "get_file" for op, _ in s3.log)


@pytest.mark.asyncio
async def test_falls_back_to_newest_generation_with_latest_when_owner_gen_is_empty() -> None:
    s3, store = FakeS3(), FakeStore()
    _put_archive(s3, VOL, "e000003-cccc0000", "20260930T010000Z", b"gen 3 archive")
    s3.objects[f"{VOL}e000004-dddd0000/PARENT"] = b"e000003-cccc0000"   # 第 4 代刚起，还没归档
    s3.objects[f"{VOL}OWNER"] = json.dumps({"owner": "dddd0000", "epoch": 4}).encode()
    result = await _job(s3, store, ["u1"]).backup_user("u1")
    assert result.action == "copied" and result.gen == "e000003-cccc0000"


@pytest.mark.asyncio
async def test_hash_mismatch_is_failed_and_nothing_is_written() -> None:
    s3, store = FakeS3(), FakeStore()
    _put_archive(s3, VOL, "e000001-aaaa0000", "20260930T010000Z", b"good")
    s3.objects[f"{VOL}e000001-aaaa0000/20260930T010000Z.tar.gz"] = b"tampered"
    s3.objects[f"{VOL}OWNER"] = json.dumps({"owner": "aaaa0000", "epoch": 1}).encode()
    summary = await _job(s3, store, ["u1"]).run_once()
    assert summary.failed == 1
    assert not any(k.startswith("backups/") for k in s3.objects)
    assert store.audits[-1][1] == "backup.failed" and "不符" in store.audits[-1][2]["error"]


@pytest.mark.asyncio
async def test_user_without_state_is_none_and_not_audited() -> None:
    s3, store = FakeS3(), FakeStore()
    summary = await _job(s3, store, ["u9"]).run_once()
    assert (summary.users, summary.copied, summary.failed) == (1, 0, 0)
    assert store.audits == []


@pytest.mark.asyncio
async def test_prune_keeps_daily_then_weekly_and_newest(monkeypatch) -> None:
    s3, store = FakeS3(), FakeStore()
    now = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
    dest = "backups/hermes-mt/u1/e000001-aaaa0000/"
    names = []
    for days_ago in list(range(0, 10)) + [14, 15, 21, 22, 35, 40, 60]:
        stamp = (now - timedelta(days=days_ago)).strftime("%Y%m%dT%H%M%SZ")
        s3.objects[f"{dest}{stamp}.tar.gz"] = b"x"
        s3.objects[f"{dest}{stamp}.json"] = b"{}"
        names.append(f"{stamp}.tar.gz")
    # 卷上也放一份，让任务有活干（今天的那份已在目标里 ⇒ skipped）
    _put_archive(s3, VOL, "e000001-aaaa0000", now.strftime("%Y%m%dT%H%M%SZ"), b"x")
    s3.objects[f"{VOL}OWNER"] = json.dumps({"owner": "aaaa0000", "epoch": 1}).encode()

    import entry.backup as backup_module

    class _Now(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(backup_module, "datetime", _Now)
    result = await _job(s3, store, ["u1"], backup_keep_days=7, backup_keep_weeks=4).backup_user("u1")
    kept = sorted(k.rsplit("/", 1)[-1] for k in s3.objects if k.startswith(dest) and k.endswith(".tar.gz"))
    expect = select_keep(names, now, 7, 4)
    assert set(kept) == expect
    # 7 天内每天一份（0..7 天前共 8 份），之后每周一份（8/9 天前同一周取最新=8、14/15 一周、21/22 一周），更老的删
    assert len(kept) == 8 + 3
    assert result.deleted == len(names) - len(kept)
    assert not any(k.endswith(".json") and k.rsplit("/", 1)[-1][:-5] + ".tar.gz" not in kept for k in s3.objects if k.startswith(dest))


def test_select_keep_newest_always_and_unparsable_kept() -> None:
    now = datetime(2026, 10, 8, tzinfo=timezone.utc)
    old = (now - timedelta(days=400)).strftime("%Y%m%dT%H%M%SZ") + ".tar.gz"
    assert select_keep([old, "weird-name.tar.gz"], now, 7, 4) == {old, "weird-name.tar.gz"}
    assert select_keep([], now, 7, 4) == set()
