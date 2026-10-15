"""卷外第二份副本：把每个用户卷上最新的状态归档拷到实例碰不到的桶前缀下。

为什么要有它：实例里的 agent 能拿到 root，能删掉自己卷上 ``.state/`` 里的归档；
卷本身又是唯一持久的地方。这份副本放在只有入口持有凭据的前缀下，实例够不着。

怎么做：每隔 ``MT_BACKUP_INTERVAL_H`` 小时跑一轮。对每个建过实例的用户：
读卷上 ``.state/OWNER`` 找到当前那一代 → 读 ``LATEST`` 得到最新归档名 → 读清单 ``.json``
→ 把归档流式下载到本地临时文件、边下边算 sha256 → 与清单核对 → 上传到
``<备份前缀><用户ID>/<代目录>/<归档名>``（清单一起）→ 按「保留几天 + 保留几周 + 最新永留」清旧副本。
已经拷过（目标里同名同大小）就跳过。每个用户的结果写一条审计。

它只读卷、只写备份前缀；从不删卷上的任何东西。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from .s3lite import S3Error, S3Lite

log = logging.getLogger("entry.backup")

STATE_DIRNAME = ".state"
_GEN_RE = re.compile(r"^e(\d{6})-([0-9a-f]{8,64})$")
_STAMP_RE = re.compile(r"^(\d{8}T\d{6}Z)\.tar\.gz$")


@dataclass
class UserResult:
    user_id: str
    action: str = ""          # copied / skipped / failed / none
    archive: str = ""
    gen: str = ""
    size: int = 0
    deleted: int = 0
    error: str = ""

    def as_audit(self) -> dict[str, Any]:
        out: dict[str, Any] = {"action": self.action, "archive": self.archive, "gen": self.gen, "size": self.size}
        if self.deleted:
            out["pruned"] = self.deleted
        if self.error:
            out["error"] = self.error[:200]
        return out


@dataclass
class RunSummary:
    started_at: str = ""
    users: int = 0
    copied: int = 0
    skipped: int = 0
    failed: int = 0
    results: list[UserResult] = field(default_factory=list)


def _parse_stamp(name: str) -> datetime | None:
    m = _STAMP_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def select_keep(names: list[str], now: datetime, keep_days: int, keep_weeks: int) -> set[str]:
    """按名字里的时间戳决定留哪些副本：最新永留；``keep_days`` 天内每天留最新一份；
    再往前 ``keep_weeks`` 周内每周留最新一份；其余删。认不出时间戳的名字一律留着（宁多勿少）。"""
    stamped = [(n, _parse_stamp(n)) for n in names]
    keep = {n for n, ts in stamped if ts is None}
    dated = sorted([(ts, n) for n, ts in stamped if ts is not None], reverse=True)
    if not dated:
        return keep
    keep.add(dated[0][1])
    day_cut = now - timedelta(days=keep_days)
    week_cut = now - timedelta(weeks=keep_weeks)
    seen_days: set[str] = set()
    seen_weeks: set[tuple[int, int]] = set()
    for ts, n in dated:
        if ts >= day_cut:
            day = ts.strftime("%Y%m%d")
            if day not in seen_days:
                seen_days.add(day)
                keep.add(n)
        elif ts >= week_cut:
            wk = ts.isocalendar()[:2]
            if wk not in seen_weeks:
                seen_weeks.add(wk)
                keep.add(n)
    return keep


class BackupJob:
    def __init__(
        self,
        settings,
        store,
        s3: S3Lite,
        volume_name: Callable[[str], str],
        candidates: Callable[[], Awaitable[list[str]]],
    ):
        self.s = settings
        self.store = store
        self.s3 = s3
        self.volume_name = volume_name
        self.candidates = candidates
        self.last: RunSummary | None = None

    # ---- 调度 ---------------------------------------------------------------------

    async def loop(self, initial_delay_s: int = 300) -> None:
        await asyncio.sleep(initial_delay_s)
        while True:
            try:
                summary = await self.run_once()
                log.info("backup: %d 用户，拷 %d，跳过 %d，失败 %d", summary.users, summary.copied, summary.skipped, summary.failed)
            except Exception as exc:  # noqa: BLE001
                log.exception("backup run failed: %s", type(exc).__name__)
            await asyncio.sleep(max(1, self.s.backup_interval_h) * 3600)

    async def run_once(self) -> RunSummary:
        summary = RunSummary(started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        for user_id in await self.candidates():
            summary.users += 1
            result = await self.backup_user(user_id)
            summary.results.append(result)
            if result.action == "copied":
                summary.copied += 1
            elif result.action == "failed":
                summary.failed += 1
            else:
                summary.skipped += 1
            if result.action in ("copied", "failed"):
                try:
                    await self.store.write_audit(user_id, "backup." + ("copy" if result.action == "copied" else "failed"), result.as_audit())
                except Exception as exc:  # noqa: BLE001
                    log.warning("backup: 写审计失败 %s", type(exc).__name__)
        self.last = summary
        return summary

    # ---- 单个用户 -------------------------------------------------------------------

    def _state_prefix(self, user_id: str) -> str:
        return f"{self.s.backup_volume_prefix}{self.volume_name(user_id)}/{STATE_DIRNAME}/"

    def _dest_prefix(self, user_id: str) -> str:
        return f"{self.s.backup_prefix}{user_id}/"

    async def backup_user(self, user_id: str) -> UserResult:
        result = UserResult(user_id=user_id)
        try:
            return await self._backup_user(user_id, result)
        except (S3Error, OSError, ValueError, json.JSONDecodeError) as exc:
            result.action = "failed"
            result.error = f"{type(exc).__name__}: {exc}"
            log.warning("backup: 用户 %s 失败: %s", user_id[:8], result.error)
            return result

    async def _backup_user(self, user_id: str, result: UserResult) -> UserResult:
        src_prefix = self._state_prefix(user_id)
        objects = await self.s3.list(src_prefix)
        keys = {o["key"]: o["size"] for o in objects}
        if not keys:
            result.action = "none"
            return result
        gen, archive = await self._latest_archive(src_prefix, keys)
        if not archive:
            result.action = "none"
            return result
        result.gen, result.archive = gen, archive
        manifest_key = f"{src_prefix}{gen}/{archive[:-len('.tar.gz')]}.json"
        archive_key = f"{src_prefix}{gen}/{archive}"
        manifest_raw = await self.s3.get_bytes(manifest_key)
        if manifest_raw is None:
            raise ValueError(f"归档 {archive} 没有清单")
        manifest = json.loads(manifest_raw)
        expected_sha = str(manifest.get("sha256") or "")
        expected_size = int(manifest.get("size") or 0)
        if not expected_sha:
            raise ValueError(f"清单 {archive} 里没有 sha256")

        dest_prefix = self._dest_prefix(user_id)
        dest_archive = f"{dest_prefix}{gen}/{archive}"
        dest_manifest = f"{dest_prefix}{gen}/{archive[:-len('.tar.gz')]}.json"
        existing = {o["key"]: o["size"] for o in await self.s3.list(dest_prefix)}
        if existing.get(dest_archive) == keys.get(archive_key) and dest_manifest in existing:
            result.action = "skipped"
            result.size = existing[dest_archive]
        else:
            with tempfile.TemporaryDirectory(prefix="mt-backup-") as tmp:
                local = Path(tmp) / archive
                size, sha = await self.s3.get_to_file(archive_key, local)
                if sha != expected_sha or (expected_size and size != expected_size):
                    raise ValueError(f"归档 {archive} 与清单不符（哈希或大小），不拷")
                # 连 s3fs 的属主 / 权限元数据一起拷：哪天要把副本放回卷前缀，挂载后才是能读的文件
                src_meta = ((await self.s3.head(archive_key)) or {}).get("metadata") or {}
                man_meta = ((await self.s3.head(manifest_key)) or {}).get("metadata") or {}
                await self.s3.put_file(dest_archive, local, sha, metadata=src_meta)
                await self.s3.put_bytes(dest_manifest, manifest_raw, metadata=man_meta)
                result.action = "copied"
                result.size = size
            existing = {o["key"]: o["size"] for o in await self.s3.list(dest_prefix)}
        result.deleted = await self._prune(dest_prefix, existing)
        return result

    async def _latest_archive(self, src_prefix: str, keys: dict[str, int]) -> tuple[str, str]:
        """先按 OWNER 指的那一代找 LATEST；那一代没有归档就退到名字最大的、有 LATEST 的一代。"""
        gens = sorted({k[len(src_prefix):].split("/", 1)[0] for k in keys if "/" in k[len(src_prefix):]})
        gens = [g for g in gens if _GEN_RE.match(g)]
        owner_raw = await self.s3.get_bytes(f"{src_prefix}OWNER") if f"{src_prefix}OWNER" in keys else None
        order: list[str] = []
        if owner_raw:
            try:
                owner = json.loads(owner_raw)
                gen = f"e{int(owner.get('epoch', 0)):06d}-{owner.get('owner', '')}"
                if gen in gens:
                    order.append(gen)
            except (ValueError, TypeError):
                pass
        order.extend(g for g in reversed(gens) if g not in order)
        for gen in order:
            latest_key = f"{src_prefix}{gen}/LATEST"
            if latest_key not in keys:
                continue
            raw = await self.s3.get_bytes(latest_key, max_bytes=4096)
            name = (raw or b"").decode("utf-8", "replace").strip()
            if name and f"{src_prefix}{gen}/{name}" in keys:
                return gen, name
        return "", ""

    async def _prune(self, dest_prefix: str, existing: dict[str, int]) -> int:
        """按保留策略删旧副本（归档和清单成对删）。只动备份前缀。"""
        archives = [k for k in existing if k.endswith(".tar.gz")]
        by_name = {k.rsplit("/", 1)[-1]: k for k in archives}
        keep = select_keep(list(by_name), datetime.now(timezone.utc), self.s.backup_keep_days, self.s.backup_keep_weeks)
        deleted = 0
        for name, key in by_name.items():
            if name in keep:
                continue
            await self.s3.delete(key)
            await self.s3.delete(key[:-len(".tar.gz")] + ".json")
            deleted += 1
        return deleted
