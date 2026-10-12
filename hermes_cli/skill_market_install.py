"""UniWork 技能市场 ZIP 包的安全下载与标准安装链。"""

from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import PurePosixPath
from typing import Optional

import httpx

from hermes_cli.web_server_profiles import _profile_scope
from tools.skills_guard import scan_skill_cached, should_allow_install
from tools.skills_hub_install import install_from_quarantine, quarantine_bundle
from tools.skills_hub_models import SkillBundle, _parse_frontmatter, _validate_skill_name

MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_EXTRACTED_BYTES = 80 * 1024 * 1024
MAX_ARCHIVE_FILES = 500


class MarketSkillInstallError(ValueError):
    """表示可直接反馈给用户的技能市场安装失败。"""


def download_skill_package(url: str) -> bytes:
    """下载固定来源的技能包，并限制网络响应体大小。"""
    try:
        with httpx.Client(timeout=45, follow_redirects=False) as client:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                declared = int(response.headers.get("content-length", "0") or 0)
                if declared > MAX_ARCHIVE_BYTES:
                    raise MarketSkillInstallError("技能包超过 20 MB，无法安装")
                chunks = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_ARCHIVE_BYTES:
                        raise MarketSkillInstallError("技能包超过 20 MB，无法安装")
                    chunks.append(chunk)
                return b"".join(chunks)
    except httpx.HTTPError as exc:
        raise MarketSkillInstallError("技能包下载失败，请稍后重试") from exc


def bundle_from_zip(package: bytes, identifier: str, source_url: str) -> SkillBundle:
    """校验 ZIP 成员并转换为可进入隔离扫描链的技能包。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(package))
    except (OSError, zipfile.BadZipFile) as exc:
        raise MarketSkillInstallError("下载内容不是有效的技能包") from exc

    with archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        if not members or len(members) > MAX_ARCHIVE_FILES:
            raise MarketSkillInstallError("技能包文件数量不合法")
        if sum(item.file_size for item in members) > MAX_EXTRACTED_BYTES:
            raise MarketSkillInstallError("技能包解压后超过 80 MB，无法安装")

        normalized = []
        for item in members:
            path = PurePosixPath(item.filename.replace("\\", "/"))
            if path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts):
                raise MarketSkillInstallError("技能包包含不安全的文件路径")
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise MarketSkillInstallError("技能包不能包含符号链接")
            normalized.append((item, tuple(part for part in path.parts if part not in {"", "."})))

        skill_files = [parts for _, parts in normalized if parts and parts[-1].lower() == "skill.md"]
        if len(skill_files) != 1:
            raise MarketSkillInstallError("技能包必须且只能包含一个 SKILL.md")
        skill_root = skill_files[0][:-1]
        files = {}
        for item, parts in normalized:
            if parts and parts[0] == "__MACOSX":
                continue
            if parts[: len(skill_root)] != skill_root or len(parts) <= len(skill_root):
                raise MarketSkillInstallError("技能包中存在技能目录之外的文件")
            relative = "/".join(parts[len(skill_root) :])
            files[relative] = archive.read(item)

    try:
        skill_text = files["SKILL.md"].decode("utf-8-sig")
    except (KeyError, UnicodeDecodeError) as exc:
        raise MarketSkillInstallError("SKILL.md 必须使用 UTF-8 编码") from exc
    frontmatter = _parse_frontmatter(skill_text)
    try:
        name = _validate_skill_name(str(frontmatter.get("name", "")).strip())
    except ValueError as exc:
        raise MarketSkillInstallError("SKILL.md 缺少有效的技能名称") from exc
    if not name:
        raise MarketSkillInstallError("SKILL.md 缺少有效的技能名称")
    return SkillBundle(name, files, "uniwork", identifier, "community", {"source_url": source_url})


def install_market_skill(url: str, identifier: str, profile: Optional[str] = None) -> dict:
    """在目标配置档中下载、隔离扫描并安装一个 UniWork 技能。"""
    with _profile_scope(profile):
        bundle = bundle_from_zip(download_skill_package(url), identifier, url)
        from tools.skills_hub import HUB_DIR, HubLockFile, _skills_dir

        existing = HubLockFile().get_installed(bundle.name)
        target = _skills_dir() / bundle.name
        if existing or target.exists():
            raise MarketSkillInstallError(f"技能 {bundle.name} 已安装")

        quarantine_path = quarantine_bundle(bundle)
        try:
            result, provenance = scan_skill_cached(
                quarantine_path,
                source=bundle.identifier,
                source_url=url,
                cache_dir=HUB_DIR / "scan-cache",
            )
            allowed, reason = should_allow_install(result)
            if allowed is not True:
                raise MarketSkillInstallError(f"技能未通过安全安装策略：{reason}")
            install_dir = install_from_quarantine(
                quarantine_path, bundle.name, "", bundle, result, scan_provenance=provenance
            )
        except Exception:
            shutil.rmtree(quarantine_path, ignore_errors=True)
            raise
        return {"ok": True, "name": bundle.name, "install_path": str(install_dir)}
