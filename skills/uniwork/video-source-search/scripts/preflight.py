#!/usr/bin/env python3
"""依赖体检；缺什么就装什么。

    python scripts/preflight.py             # 只检查，列出缺的和安装命令
    python scripts/preflight.py --install   # 检查并安装缺失项
    python scripts/preflight.py --json      # 机器可读

需要 node/npx（mcp-vods 调用链）、uv/uvx（同上）、ffmpeg/ffprobe（探测与下载）。
缺任何一个，故障都会以别的面目出现——uvx 不在 PATH 报出来像"片源引擎连接失败"，
ffprobe 缺失报出来像"这个源不可播"。先体检比事后猜便宜得多。

需要 sudo 的命令只打印不执行：agent 环境下 sudo 会卡在密码提示上，还不如让用户
自己跑一行。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import tarfile
import urllib.request
import zipfile

sys.dont_write_bytecode = True   # 别在用户目录留 __pycache__（这里常是同步盘）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# 工具解析必须和运行时脚本走同一段代码，否则又会出现"体检说装好了、
# probe 说找不到"——这正是 preflight 反复重装的老病根
from _common import (cache_dir, ensure_utf8_stdout, forget_tool,  # noqa: E402
                     iter_tool_candidates, preflight_bin_dirs, record_tool,
                     run_hidden)

IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")


# 工具 -> (说明, 探测用的命令)
TOOLS = {
    "npx":     ("mcp-vods 调用链（Node.js 自带）", ["--version"]),
    "uvx":     ("mcp-vods 运行时（uv 自带）", ["--version"]),
    "ffprobe": ("媒体探测：时长/分辨率/可播性", ["-version"]),
    "ffmpeg":  ("下载与抽样验证", ["-version"]),
}

# 一个包管理器条目能同时补齐哪些工具
PACKAGES = {
    "npx":     {"brew": "node", "winget": "OpenJS.NodeJS.LTS",
                "apt": "nodejs npm", "dnf": "nodejs", "pacman": "nodejs npm"},
    "uvx":     {"brew": "uv", "winget": "astral-sh.uv",
                "apt": None, "dnf": None, "pacman": None},   # 走官方安装脚本
    "ffprobe": {"brew": "ffmpeg", "winget": "Gyan.FFmpeg",
                "apt": "ffmpeg", "dnf": "ffmpeg", "pacman": "ffmpeg"},
}
PACKAGES["ffmpeg"] = PACKAGES["ffprobe"]

UV_FALLBACK = ('powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' if IS_WIN
               else "curl -LsSf https://astral.sh/uv/install.sh | sh")

# ── Windows 国内镜像直下 ──────────────────────────────────────────────────
# winget 的包只在官方 CDN(nodejs.org) / GitHub releases(ffmpeg)分发，后者在国内
# 常被墙(0x80072efd)，winget 也就跟着失败。这里改走实测可达的国内/直连镜像，作为
# winget 的前置尝试；仍失败才落回 winget。所有 URL 均已在开发机上逐个验证过可达。
#
# "body" 是下载完成后运行的工具安装主体，返回错误说明则视为该步失败。
MIRROR_NODE_LTS_URL = "https://cdn.npmmirror.com/binaries/node/index.json"


# 下载内容校验：镜像/代理/对象存储出错时经常返回 200 + HTML 错误页，落盘成
# "二进制"后执行只会报 `syntax error near unexpected token`，极难排查（实测
# sandbox 里就这么翻过车）。按魔数验，不对就删掉让调用方换下一个源。
MAGIC = {"elf": b"\x7fELF", "gzip": b"\x1f\x8b", "exe": b"MZ",
         "xz": b"\xfd7zXZ\x00", "msi": b"\xd0\xcf\x11\xe0"}


def looks_like(path: str, kind: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(MAGIC[kind])) == MAGIC[kind]
    except OSError:
        return False


def preflight_cache() -> str:
    """下载缓存目录。放用户缓存目录而不是 /tmp——sandbox 的 /tmp 常见共享挂载，
    删不掉旧目录（Operation not permitted），一条 `rm && 重装` 就卡死；用户
    缓存目录永远可写，且脚本全程只覆盖文件、不要求删目录。"""
    base = ((os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local"))
            if IS_WIN else
            (os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")))
    path = os.path.join(base, "hexagent-preflight")
    os.makedirs(path, exist_ok=True)
    return path


def download_with_progress(url: str, dst: str, label: str,
                           expect: str | None = None) -> bool:
    """urllib 下载(url -> dst)，带简单进度。失败返回 False 不抛。

    先写 dst.part 校验魔数再原子替换——半截文件和 HTML 错误页永远到不了 dst，
    重跑天然幂等，不需要手动清理。expect 见 MAGIC 表。
    """
    import time
    part = dst + ".part"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "preflight"})
        with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done, last = 0, 0.0
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                now = time.time()
                if total and now - last > 0.5:
                    last = now
                    print(f"\r  {label} {done * 100 // total}%", end="", flush=True)
        if expect and not looks_like(part, expect):
            print(f"\r  {label} 内容校验失败：返回的不是 {expect} 二进制"
                  f"（多半是镜像的 HTML 错误页），丢弃并换源", flush=True)
            os.remove(part)
            return False
        os.replace(part, dst)
        print(f"\r  {label} 完成 ({done})", flush=True)
        return True
    except Exception as e:
        print(f"\r  {label} 下载失败：{e}", flush=True)
        try:
            os.remove(part)
        except OSError:
            pass
        return False


# 自家 OSS 直连的 ffmpeg 构建（Windows 专用 exe）。Linux 没有 OSS 包，走
# npmmirror 国内镜像装静态构建（见 linux_static_ffmpeg）；macOS 用 brew。
OSS_FFMPEG_BASE = ("https://obs-nmhhht6.cucloud.cn/app-agent-prod/"
                   "video-search/ffmpeg-9.0-essentials/bin")

# Linux 静态构建的国内镜像源（npmmirror 同步自 GitHub releases / npm 包）：
# * ffmpeg：eugeneware/ffmpeg-static 的单文件二进制（.gz 版省一半流量，
#   x64 28MB / arm64 24MB）
# * ffprobe：@ffprobe-installer 的按平台 npm 包（每包只含一个二进制，
#   x64 28MB / arm64 24MB；别用 ffprobe-static 大杂烩包，122MB）
NPMMIRROR_FFMPEG_GZ = ("https://registry.npmmirror.com/-/binary/"
                       "ffmpeg-static/b6.0/ffmpeg-linux-{arch}.gz")
NPMMIRROR_FFPROBE_TGZ = ("https://registry.npmmirror.com/@ffprobe-installer/"
                         "linux-{arch}/-/linux-{arch}-5.2.0.tgz")


def mirror_ffmpeg(cache: str, tool: str, shown: str) -> str | None:
    """Windows 专用：优先从自家 OSS 直下 ffmpeg.exe/ffprobe.exe（速度稳定可控），
    失败落回 gyan.dev 的 essentials zip。一次把两个 exe 都补齐——安装计划按包
    去重后 ffmpeg/ffprobe 只会走进来一次。"""
    # 落位目录由 _common 定义：运行时脚本解析工具时查的就是它，两边共用一个常量
    # 才不会出现"装到 A 目录、去 B 目录找"
    bin_dir = preflight_bin_dirs()[0]
    os.makedirs(bin_dir, exist_ok=True)
    want = os.path.join(bin_dir, f"{tool}.exe")
    for t in ("ffmpeg", "ffprobe"):        # 清掉历史留下的非 exe 垃圾（HTML 错误页）
        p = os.path.join(bin_dir, f"{t}.exe")
        if os.path.exists(p) and not looks_like(p, "exe"):
            try:
                os.remove(p)
            except OSError:
                pass
    targets = [t for t in ("ffmpeg", "ffprobe")
               if not os.path.exists(os.path.join(bin_dir, f"{t}.exe"))]
    if not targets:
        return want
    # 1) OSS 直下 exe（魔数校验在 download 内完成，失败不会留半截/垃圾文件）
    ok = True
    for t in targets:
        dst = os.path.join(bin_dir, f"{t}.exe")
        print(f"▶ 下载 {t}：OSS 直连", flush=True)
        if not download_with_progress(f"{OSS_FFMPEG_BASE}/{t}.exe", dst,
                                      f"[{t}]", expect="exe"):
            ok = False
            break
    if ok and looks_like(want, "exe"):
        return want
    # 2) gyan.dev zip 兜底。zip 里有一层版本号目录（ffmpeg-x.x-essentials_build/
    # bin/*.exe），解压后必须把 exe 挑出来放平到 bin_dir，否则 check() 找不到。
    url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    zip_path = os.path.join(cache, "ffmpeg-essentials.zip")
    print(f"▶ OSS 不可用，改下 gyan.dev 全家桶：{shown}", flush=True)
    if not download_with_progress(url, zip_path, f"[ffmpeg]{cache}"):
        return None
    tmp = os.path.join(cache, "ffmpeg-zip")
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)
        for root, _dirs, files in os.walk(tmp):
            for f in files:
                if f in ("ffmpeg.exe", "ffprobe.exe"):
                    shutil.copy2(os.path.join(root, f), os.path.join(bin_dir, f))
    except Exception as e:
        print(f"  解压失败：{e}")
        return None
    return want if os.path.exists(want) else None


def _johnvansickle_fallback(bin_dir: str, arch: str, cache: str) -> None:
    """兜底：官方静态版 tar.xz 一包含 ffmpeg+ffprobe（arm64 的 ffprobe 只有这条路）。
    解压后从版本号子目录里把二进制挑出来放平。失败不抛，交给调用方检查结果。"""
    url = f"https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-{arch}-static.tar.xz"
    tarball = os.path.join(cache, f"ffmpeg-{arch}-static.tar.xz")
    print("▶ 改下 johnvansickle 静态构建兜底（约 40MB）", flush=True)
    if not download_with_progress(url, tarball, "[ffmpeg-static]", expect="xz"):
        return
    tmp = os.path.join(cache, "ffmpeg-static")
    try:
        with tarfile.open(tarball, "r:xz") as t:
            t.extractall(tmp)
        for root, _dirs, files in os.walk(tmp):
            for f in files:
                if f in ("ffmpeg", "ffprobe"):
                    dst = os.path.join(bin_dir, f)
                    shutil.copy2(os.path.join(root, f), dst)
                    os.chmod(dst, 0o755)
    except Exception as e:
        print(f"  解压失败：{e}")


def linux_static_ffmpeg(tool: str) -> str | None:
    """Linux 无 root 的用户级安装——sandbox 常态是 sudo 卡密码、apt 没权限。

    静态构建是单文件二进制，下到 ~/.local/bin 即用，全程不需要 root。
    国内镜像（npmmirror）优先，johnvansickle 官方静态版兜底。
    一次补齐 ffmpeg+ffprobe——安装计划按包去重后只会走进来一次。
    _common.which() 会兜底查 ~/.local/bin，装完即便 PATH 没刷新脚本也找得到。
    """
    arch = {"x86_64": "x64", "amd64": "x64",
            "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
    if not arch:
        return None
    bin_dir = os.path.expanduser("~/.local/bin")
    os.makedirs(bin_dir, exist_ok=True)
    cache = preflight_cache()
    want = os.path.join(bin_dir, tool)

    # 落位文件必须是 ELF 才算已装：以前有 agent 把 HTML 错误页存成过"二进制"，
    # 光看文件存在会把垃圾当成装好了，反复困死在"装了却跑不了"
    for t in ("ffmpeg", "ffprobe"):
        p = os.path.join(bin_dir, t)
        if os.path.exists(p) and not looks_like(p, "elf"):
            print(f"  发现损坏的 {t}（非 ELF，疑似 HTML 错误页），删除重装", flush=True)
            try:
                os.remove(p)
            except OSError:
                pass

    # 1) ffmpeg：npmmirror 的 .gz 单文件二进制，下完就地解压
    ffmpeg_dst = os.path.join(bin_dir, "ffmpeg")
    if not os.path.exists(ffmpeg_dst):
        import gzip
        gz = os.path.join(cache, f"ffmpeg-linux-{arch}.gz")
        print(f"▶ 下载 ffmpeg：npmmirror 静态构建（linux-{arch}）", flush=True)
        if download_with_progress(NPMMIRROR_FFMPEG_GZ.format(arch=arch), gz,
                                  "[ffmpeg]", expect="gzip"):
            try:
                with gzip.open(gz, "rb") as src, open(ffmpeg_dst, "wb") as out:
                    shutil.copyfileobj(src, out)
                os.chmod(ffmpeg_dst, 0o755)
            except Exception as e:
                print(f"  解压失败：{e}")
                try:
                    os.remove(ffmpeg_dst)   # 半截文件不能留，会被 check() 当成已装
                except OSError:
                    pass

    # 2) ffprobe：@ffprobe-installer 按平台包，从 tgz 里抽出唯一的二进制
    ffprobe_dst = os.path.join(bin_dir, "ffprobe")
    if not os.path.exists(ffprobe_dst):
        tgz = os.path.join(cache, f"ffprobe-linux-{arch}.tgz")
        print(f"▶ 下载 ffprobe：npmmirror @ffprobe-installer（linux-{arch}）", flush=True)
        if download_with_progress(NPMMIRROR_FFPROBE_TGZ.format(arch=arch), tgz,
                                  "[ffprobe]", expect="gzip"):
            try:
                with tarfile.open(tgz, "r:gz") as t, \
                        open(ffprobe_dst, "wb") as out:
                    shutil.copyfileobj(t.extractfile("package/ffprobe"), out)
                os.chmod(ffprobe_dst, 0o755)
            except Exception as e:
                print(f"  提取失败：{e}")
                try:
                    os.remove(ffprobe_dst)
                except OSError:
                    pass

    # 3) 镜像路径有缺的走 johnvansickle 兜底
    if not (looks_like(ffmpeg_dst, "elf") and looks_like(ffprobe_dst, "elf")):
        jv_arch = "amd64" if arch == "x64" else "arm64"
        _johnvansickle_fallback(bin_dir, jv_arch, cache)

    if looks_like(want, "elf"):
        print(f"  {add_to_path(bin_dir)}", flush=True)
        return want
    return None


# 返回 (是否装成了, 错误信息)。失败让调用方落回包管理器/手动提示。
def mirror_install(tool: str, cache: str) -> tuple[bool, str]:
    """直连下载安装（不经过包管理器）。

    * Windows：npx 走 npmmirror msi；ffmpeg/ffprobe 走自家 OSS exe（gyan 兜底）。
      从下载源到安装方式（msiexec/.exe/写注册表 PATH）全套 Windows 专属。
    * Linux：ffmpeg/ffprobe 走用户级静态构建（无 root 的 sandbox 唯一可行路径）。
    * macOS：不走直连，brew 足够（见 install_cmd）。
    """
    if IS_LINUX and tool in ("ffprobe", "ffmpeg"):
        exe = linux_static_ffmpeg(tool)
        return (True, "") if exe else (False, "OSS 与 johnvansickle 静态构建均下载失败")
    if not IS_WIN:
        return False, "直连安装不适用当前平台，请改用系统包管理器"
    if tool in ("npx",):
        # npmmirror 查 LTS 版本 -> 下 msi -> msiexec 静默安装。和 winget 装 node 等价。
        try:
            req = urllib.request.Request(
                MIRROR_NODE_LTS_URL, headers={"User-Agent": "preflight"})
            ver = None
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            for e in data:                      # npmmirror index.json 是版本列表
                if e.get("lts"):
                    ver = e["version"]
                    break
            if not ver:
                return False, "npmmirror 拿不到 LTS 版本"
        except Exception as e:
            return False, f"npmmirror 查询失败：{e}"
        msi = os.path.join(cache, f"node-{ver}-x64.msi")
        url = f"https://cdn.npmmirror.com/binaries/node/{ver}/node-{ver}-x64.msi"
        print(f"▶ 安装 npx（Node LTS {ver}）：npmmirror 直下 msi", flush=True)
        if not download_with_progress(url, msi, f"[node {ver}]", expect="msi"):
            return False, "npmmirror 下载 node msi 失败"
        print("  运行 msiexec 静默安装...", flush=True)
        r = run_hidden(["msiexec", "/i", msi, "/qn", "/norestart"],
                       timeout=1800)
        if r.returncode != 0:
            return False, f"msiexec 安装失败（退出码 {r.returncode}）"
        return True, ""
    if tool in ("ffprobe", "ffmpeg"):
        exe = mirror_ffmpeg(cache, tool, "gyan.dev ffmpeg-release-essentials.zip")
        if exe:
            note = add_to_path(os.path.dirname(exe))
            if "已把" in note or "已在" in note:
                print(f"  {note}", flush=True)
            return True, ""
        return False, "gyan.dev 下载/解压 ffmpeg 失败"
    return False, ""                          # 无镜像覆盖，回退 install_cmd


def _shell_rc_path() -> str | None:
    """POSIX 下挑一个最可能被登录 shell 读取的 rc 文件。agent 的子进程环境来源
    不固定，我们只做"尽力补 PATH"，失败/拿不准就 return None 让调用方提示手动。"""
    shell = os.environ.get("SHELL", "")
    home = os.path.expanduser("~")
    default = os.path.join(home, ".zshrc" if "zsh" in shell else ".bashrc")
    for cand in (default,
                 os.path.join(home, ".zshrc"),
                 os.path.join(home, ".bashrc"),
                 os.path.join(home, ".profile")):
        if os.path.isfile(cand) or cand == default:
            return cand
    return default


def add_to_path(new_dir: str) -> str:
    r"""把 new_dir 追加进可用 shell 环境的 PATH，返回提示串。

    Windows 写 HKCU\Environment（避免动系统级），并广播 WM_SETTINGCHANGE 让会话内
    后续 subprocess 能找到；macOS/Linux 没有注册表，改成往 ~/.zshrc|.bashrc 追加
    一行 export PATH（尽力而为，拿不准 rc 路径时就提示手动，绝不因此抛错——安装
    成功不该被"加 PATH 失败"毁掉）。

    新装工具的 exe 目录往往不在 PATH，不加则 subprocess 找不到。
    """
    if IS_WIN:
        import ctypes
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Environment", 0, winreg.KEY_SET_VALUE) as k:
                cur, _ = winreg.QueryValueEx(k, "Path")
            if new_dir.lower() in (p.strip().lower() for p in cur.split(";")):
                return "（已在 PATH）"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Environment", 0, winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, "Path", 0, winreg.REG_EXPAND_SZ, cur + ";" + new_dir)
            # 广播给已开的进程，让本会话之后的 subprocess 也能找到
            HWND_BROADCAST = 0xFFFF
            import struct
            ctypes.windll.user32.SendMessageTimeoutW(
                HWND_BROADCAST, 0x001A, 0, 0, 0x0002, 1000, None)  # WM_SETTINGCHANGE
            return f"（已把 {new_dir} 追加到用户 PATH）"
        except Exception as e:
            return f"（改 PATH 失败：{e}，需手动把目录加入 PATH）"
    # macOS/Linux：往 shell rc 追加 export PATH
    rc = _shell_rc_path()
    if not rc:
        return f"（无法确定 shell 配置文件，请手动把 {new_dir} 加入 PATH）"
    export = f'\nexport PATH="{new_dir}:$PATH"\n'
    try:
        if not os.path.exists(rc):
            open(rc, "a", encoding="utf-8").close()
        with open(rc, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        if new_dir not in text:
            with open(rc, "a", encoding="utf-8") as f:
                f.write(export)
        return f"（已把 {new_dir} 追加到 {rc}，新开终端生效）"
    except Exception as e:
        return f"（追加 {rc} 失败：{e}，需手动把目录加入 PATH）"


def pkg_manager() -> str | None:
    for name in (["winget"] if IS_WIN else
                 ["brew"] if IS_MAC else ["apt-get", "dnf", "pacman"]):
        if shutil.which(name):
            return {"apt-get": "apt"}.get(name, name)
    return None


def check(tool: str) -> dict:
    """逐个候选真跑一次 -version，第一个跑得通的就是答案，并写进注册表。

    要求"版本命令真能跑"而不是"文件存在"：HTML 错误页伪装的二进制、架构不对的
    下载物都会在这里现形，让 --install 重装而不是谎报已就绪。
    候选清单来自 _common.iter_tool_candidates()——和 probe/download 用的是同一个
    函数，所以这里判定 found 的那条路径，运行时必然也解析得到。
    验真通过即 record_tool()：注册表把绝对路径钉死，后续进程不再依赖 PATH 是否
    刷新（Windows 改注册表 PATH 不影响已运行进程，这正是老 bug 的成因）。
    """
    cands = iter_tool_candidates(tool)
    for path in cands:
        try:
            r = run_hidden([path, *TOOLS[tool][1]], capture_output=True,
                           text=True, timeout=60)
            ver = ((r.stdout or r.stderr).strip().splitlines() or [""])[0][:60] \
                if r.returncode == 0 else None
        except Exception:
            ver = None
        if ver:
            record_tool(tool, path)
            return {"tool": tool, "found": True, "path": path, "version": ver,
                    "purpose": TOOLS[tool][0]}
    forget_tool(tool)          # 注册表里若有坏记录，别让它继续误导运行时
    return {"tool": tool, "found": False, "path": cands[0] if cands else None,
            "version": None, "purpose": TOOLS[tool][0]}


def install_cmd(tool: str, pm: str | None) -> tuple[list[str] | None, str, bool, bool]:
    """返回 (可执行的 argv 或 None, 展示用命令行, 是否需要 sudo, 是否走直连安装)。
    第 4 项为 True 时，main 会调 mirror_install() 直下安装而非 run_hidden(argv)。"""
    if IS_LINUX and tool in ("ffprobe", "ffmpeg"):
        # Linux 一律先试用户级静态构建（sandbox 无 root 是常态，sudo 会卡密码）；
        # shown 只作直连失败后的手动兜底提示
        pkg = PACKAGES[tool].get(pm) if pm else None
        shown = ({"apt": f"sudo apt-get install -y {pkg}",
                  "dnf": f"sudo dnf install -y {pkg}",
                  "pacman": f"sudo pacman -S --noconfirm {pkg}"}.get(pm or "", "")
                 or f"（无包管理器，请手动安装 {tool} 或检查网络后重跑 --install）")
        return None, shown, False, True
    if tool == "uvx" and (pm not in ("brew", "winget")):
        return None, UV_FALLBACK, False, False        # 官方安装脚本，装到用户目录
    pkg = PACKAGES.get(tool, {}).get(pm)
    if not pkg:
        return None, f"（未识别包管理器，请手动安装 {tool}）", False, False
    if pm == "brew":
        # brew install 本身不需要 sudo（与 apt/dnf 不同）。但新装 Homebrew 后其目录
        # 还没归当前用户所有，首次 install 会报 Permission denied 且提示要 chown——
        # 那一步才需要 sudo，agent 里会卡密码，所以并入 shown 提示让用户自己跑。
        primer = ("（若报 Permission denied，先执行 "
                  "sudo chown -R \"$(whoami)\" /opt/homebrew）" if tool in (
                      "ffprobe", "ffmpeg") else "")
        return (["brew", "install", *pkg.split()],
                f"brew install {pkg}{primer}", False, False)
    if pm == "winget":
        winget_argv = ["winget", "install", "-e", "--id", pkg,
                       "--accept-package-agreements", "--accept-source-agreements"]
        # 这三类 winget 底层走 nodejs.org / GitHub releases(国内常被墙)，优先国内镜像
        via_mirror = tool in ("npx", "ffprobe", "ffmpeg")
        return (winget_argv, f"winget install -e --id {pkg}", False, via_mirror)
    if pm == "apt":
        return None, f"sudo apt-get install -y {pkg}", True, False
    if pm == "dnf":
        return None, f"sudo dnf install -y {pkg}", True, False
    if pm == "pacman":
        return None, f"sudo pacman -S --noconfirm {pkg}", True, False
    return None, f"（请手动安装 {tool}）", False, False


def main() -> int:
    p = argparse.ArgumentParser(description="影视片源搜索：依赖体检与安装")
    p.add_argument("--install", action="store_true", help="安装缺失依赖")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()

    ensure_utf8_stdout()

    results = [check(t) for t in TOOLS]
    missing = [r["tool"] for r in results if not r["found"]]
    pm = pkg_manager()

    if a.json:
        print(json.dumps({"python": sys.version.split()[0], "platform": platform.system(),
                          "package_manager": pm, "missing": missing,
                          "tools": results}, ensure_ascii=False, indent=2))
        return 0 if not missing else 1

    print(f"Python {sys.version.split()[0]} · {platform.system()} · 包管理器：{pm or '未检测到'}")
    for r in results:
        mark = "✅" if r["found"] else "❌"
        print(f"{mark} {r['tool']:<8} {r['version'] or r['purpose']}")
        # 打出验真过的绝对路径：✅ 却不给路径，agent 遇到后续报错就会怀疑
        # "是不是没装"，转而 where/winget 手搓重装（实测就是这么翻车的）
        if r["found"]:
            print(f"   ↳ {r['path']}")

    if not missing:
        print(f"\n依赖齐全，绝对路径已记入 {os.path.join(cache_dir(), 'tools.json')}，"
              "所有脚本共用，不依赖 PATH。\n"
              "→ 后续脚本再报「找不到 ffmpeg/ffprobe」是别的问题，"
              "不要重复安装、不要用 where/Get-Command/winget/curl 手动找。\n"
              "新机器首搜会自动构建片源引擎环境（1–5 分钟），直接搜即可，"
              "Bash 超时给 600000ms。")
        return 0

    # 同一个包能补多个工具（ffmpeg/ffprobe 同源），去重后再装
    plan, seen = [], set()
    for t in missing:
        argv, shown, needs_sudo, via_mirror = install_cmd(t, pm)
        if shown in seen:
            continue
        seen.add(shown)
        plan.append((t, argv, shown, needs_sudo, via_mirror))

    print(f"\n缺少 {len(missing)} 项：{', '.join(missing)}")
    if not a.install:
        print("安装命令（或直接加 --install 自动执行）：")
        for _, _, shown, _, _ in plan:
            print(f"  {shown}")
        return 1

    failed = []
    cache = preflight_cache()
    for tool, argv, shown, needs_sudo, via_mirror in plan:
        if needs_sudo or (argv is None and not via_mirror):
            reason = "需要 sudo，agent 里会卡在密码提示" if needs_sudo else "需手动执行"
            print(f"\n⏭  {tool}：{reason}，请自行运行：\n  {shown}")
            failed.append(tool)
            continue
        if via_mirror:
            ok, err = mirror_install(tool, cache)
            if ok:
                print(f"\n✅ {tool} 安装成功。")
            elif argv is not None and not needs_sudo:
                print(f"\n⚠️ {tool} 直连安装失败：{err}。改走包管理器兜底：{shown}")
                if run_hidden(argv, timeout=1800).returncode != 0:
                    failed.append(tool)
            else:
                # Linux 直连失败后没有可自动执行的兜底（apt 要 sudo），转手动
                print(f"\n⚠️ {tool} 直连安装失败：{err}。请自行运行：\n  {shown}")
                failed.append(tool)
            continue
        print(f"\n▶ 安装 {tool}：{shown}")
        try:
            if run_hidden(argv, timeout=1800).returncode != 0:
                failed.append(tool)
        except Exception as e:
            print(f"  失败：{e}")
            failed.append(tool)

    # 用 check() 复核而不是裸 shutil.which：用户级安装（~/.local/bin、镜像缓存）
    # 不在本进程 PATH 快照里，裸 which 会把装好的报成"仍缺"；复核同时把绝对路径
    # 写进注册表，运行时脚本据此直接命中
    recheck = [check(t) for t in missing]
    still = [r["tool"] for r in recheck if not r["found"]]
    for r in recheck:
        if r["found"]:
            print(f"   ↳ {r['tool']}: {r['path']}")
    print("\n" + ("✅ 依赖已齐全，绝对路径已记入 "
                  f"{os.path.join(cache_dir(), 'tools.json')}，脚本共用，无需重开终端。"
                  if not still else
                  f"⚠️ 仍缺：{', '.join(still)}。请原样重跑本命令（幂等、断点续传），"
                  "不要改用别的安装方式。"))
    return 0 if not still else 1


if __name__ == "__main__":
    sys.exit(main())
