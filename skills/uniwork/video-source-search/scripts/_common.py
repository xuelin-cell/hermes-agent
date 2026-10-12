"""movie-tv-source-search skill 的跨平台公共工具。

只用标准库，Windows / macOS / Linux 通用。所有 OS 差异（缓存目录、进程探测、后台
启动方式、空设备）都收敛在本文件里，其它脚本不要再写平台分支——散落的平台判断正是
这个 skill 之前只能在 Windows 上跑的原因。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urljoin

IS_WIN = os.name == "nt"


def ensure_utf8_stdout() -> None:
    """Windows 中文/窄编码控制台默认是 gbk/cp936，直接 print emoji（✅/❌/⚠️）
    会抛 UnicodeEncodeError。macOS/Linux 默认已是 utf-8，此处跳过、保持系统行为。
    被所有脚本经 _common 导入时提前钉好 stdout，避免在首个输出前才补救。"""
    enc = getattr(sys.stdout, "encoding", None)
    if enc and "utf" not in enc.lower():
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


ensure_utf8_stdout()

# 很多防盗链源站只认浏览器 UA，探测/下载默认带上，比逐个源站猜 Referer 便宜得多
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


# ── 路径 ──────────────────────────────────────────────────────────────────

def cache_dir(app: str = "mcp-vods-skill") -> str:
    """各平台约定的用户缓存目录，用来放预热标记和串行锁。"""
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local")
    elif sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Caches")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    path = os.path.join(base, app)
    os.makedirs(path, exist_ok=True)
    return path


# ── 可执行文件解析（全 skill 唯一入口）────────────────────────────────────
#
# 这里是 preflight 与所有运行时脚本共用的同一段解析逻辑。曾经 preflight 自己查一
# 套目录、_common.which() 查另一套，结果是 preflight 报「✅ ffprobe 已装」而
# probe_media 同一台机器上报「找不到 ffprobe」，agent 于是 where / Get-Command /
# winget / curl 一路手搓重装——本文件就是为了让那类事故不可能再发生：谁都只能通过
# iter_tool_candidates() 找工具，preflight 找得到的路径运行时必然也找得到。
#
# 三层解析，从便宜到贵：
#   1. 环境变量覆盖 VSS_FFMPEG / VSS_FFPROBE / VSS_NPX / VSS_UVX（用户/CI 兜底）
#   2. 注册表 tools.json：preflight 验真（真跑过 -version）后写下的绝对路径，
#      跨进程复用，不依赖 PATH 是否刷新——这是修掉"装了却找不到"的关键
#   3. PATH + 各平台已知安装位置（见 _install_dirs）
# 解析成功即回写注册表并把所在目录并进本进程 PATH，后续 subprocess 一并受益。

REGISTRY_TOOLS = ("npx", "uvx", "ffmpeg", "ffprobe")

_tool_cache: dict[str, str] = {}
_install_lock = threading.Lock()


def _registry_path() -> str:
    return os.path.join(cache_dir(), "tools.json")


def _read_registry() -> dict:
    try:
        with open(_registry_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def record_tool(name: str, path: str) -> None:
    """把已验真的绝对路径记进注册表，供后续任何进程直接复用（免二次探测/误判缺失）。
    写临时文件再原子替换：并发探测有 4 个线程/进程同时写，半截 JSON 会让下一次
    读取整个注册表失效。"""
    try:
        data = _read_registry()
        data[name] = {"path": path, "ts": int(time.time())}
        tmp = f"{_registry_path()}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _registry_path())
    except Exception:
        pass          # 注册表只是加速与纠偏，写失败不该影响主流程


def forget_tool(name: str) -> None:
    """注册表里的路径已经跑不起来（文件被删/是 HTML 错误页/架构不对）时清掉它，
    否则坏记录会一直优先于 PATH 里真正可用的那份。"""
    _tool_cache.pop(name, None)
    try:
        data = _read_registry()
        if data.pop(name, None) is not None:
            tmp = f"{_registry_path()}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, _registry_path())
    except Exception:
        pass


def preflight_bin_dirs() -> list[str]:
    """preflight 直连安装的落位目录。Windows 的 ffmpeg/ffprobe.exe 就落在这里，
    且这个目录几乎不可能在 agent 子进程的 PATH 里——不查它就会"装完还是找不到"。"""
    base = ((os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local"))
            if IS_WIN else
            (os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")))
    return [os.path.join(base, "hexagent-preflight", "ffmpeg-bin"),
            # 旧版缓存在 /tmp，一并认，免得重下 90MB
            os.path.join(tempfile.gettempdir(), "hexagent-preflight", "ffmpeg-bin")]


def _exe_names(name: str) -> list[str]:
    """Windows 上 npx 实际是 npx.cmd、ffmpeg 是 ffmpeg.exe；不走 shell 时必须用带
    后缀的真实文件名，否则 FileNotFoundError。"""
    if not IS_WIN:
        return [name]
    return [f"{name}{ext}" for ext in (".exe", ".cmd", ".bat", "")]


def _install_dirs(name: str) -> list[str]:
    """PATH 之外的已知安装位置。agent 子进程的 PATH 常和用户终端不同（尤其
    Windows：注册表 PATH 改了也要重开进程才生效），这份清单就是 PATH 的替身。"""
    dirs: list[str] = list(preflight_bin_dirs())
    home = os.path.expanduser("~")
    if IS_WIN:
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        roaming = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        pf = os.environ.get("ProgramFiles") or r"C:\Program Files"
        dirs += [
            os.path.join(local, "Microsoft", "WinGet", "Links"),   # winget 的 shim 目录
            os.path.join(home, ".local", "bin"),                   # uv 官方安装脚本
            os.path.join(home, "scoop", "shims"),
            os.path.join(os.environ.get("ChocolateyInstall") or r"C:\ProgramData\chocolatey", "bin"),
        ]
        if name in ("npx",):
            dirs += [os.path.join(roaming, "npm"),
                     os.path.join(pf, "nodejs"),
                     os.path.join(local, "Programs", "nodejs")]
        if name in ("ffmpeg", "ffprobe"):
            dirs += [r"C:\ffmpeg\bin", os.path.join(pf, "ffmpeg", "bin")]
            # winget 装的 Gyan.FFmpeg 真身埋在带版本号的包目录里（Links 下的 shim
            # 有时没建成），做一次有界 glob 兜底，不做递归全盘扫描
            import glob
            pkgs = os.path.join(local, "Microsoft", "WinGet", "Packages")
            for pat in (os.path.join(pkgs, "*FFmpeg*", "*", "bin"),
                        os.path.join(pkgs, "*FFmpeg*", "bin")):
                try:
                    dirs += sorted(glob.glob(pat))
                except Exception:
                    pass
    else:
        dirs += [os.path.join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin"]
        if sys.platform == "darwin":
            dirs += ["/opt/homebrew/bin", "/opt/local/bin"]
        else:
            dirs += ["/snap/bin"]
    return dirs


def iter_tool_candidates(name: str) -> list[str]:
    """按优先级返回该工具所有"文件确实存在且可执行"的候选绝对路径（已去重）。

    preflight 会对每个候选真跑一次 -version 挑出能用的那个；运行时脚本取第一个。
    两边共用这一个函数，就不会再出现"体检说有、运行说无"。
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(p: str | None):
        if not p:
            return
        try:
            real = os.path.abspath(p)
        except Exception:
            return
        key = real.lower() if IS_WIN else real
        if key in seen or not os.path.isfile(real):
            return
        if not IS_WIN and not os.access(real, os.X_OK):
            return
        seen.add(key)
        out.append(real)

    add(os.environ.get(f"VSS_{name.upper()}"))
    entry = _read_registry().get(name) or {}
    add(entry.get("path") if isinstance(entry, dict) else None)
    add(shutil.which(name))
    for d in _install_dirs(name):
        for exe in _exe_names(name):
            add(os.path.join(d, exe))
    return out


def _remember(name: str, path: str) -> str:
    """缓存 + 回写注册表 + 把所在目录并进本进程 PATH（子进程随之受益）。"""
    _tool_cache[name] = path
    if name in REGISTRY_TOOLS:
        record_tool(name, path)
    d = os.path.dirname(path)
    parts = (os.environ.get("PATH") or "").split(os.pathsep)
    if d and d not in parts:
        os.environ["PATH"] = d + os.pathsep + (os.environ.get("PATH") or "")
    return path


def _usable(path: str | None) -> str | None:
    if path and os.path.isfile(path) and (IS_WIN or os.access(path, os.X_OK)):
        return os.path.abspath(path)
    return None


def which(name: str, refresh: bool = False) -> str | None:
    """解析可执行文件的绝对路径，找不到返回 None。refresh=True 跳过进程内缓存。

    命中注册表就直接返回，不去走完整候选枚举——Windows 那条路要 glob winget 的包
    目录，probe 一次并发探 4 条 URL、每条都 require 两次，全枚举一遍纯属浪费。
    """
    if not refresh and name in _tool_cache:
        return _tool_cache[name]
    entry = _read_registry().get(name)
    fast = _usable(os.environ.get(f"VSS_{name.upper()}")) or _usable(
        entry.get("path") if isinstance(entry, dict) else None)
    if fast:
        return _remember(name, fast)
    cands = iter_tool_candidates(name)
    return _remember(name, cands[0]) if cands else None


def _auto_install(name: str) -> str | None:
    """缺依赖时自动跑一次 preflight --install，而不是把"找不到"甩给 agent。

    agent 拿到"找不到 ffprobe"后的典型行为是 where / Get-Command / winget / curl
    一通手搓（实测每条都会翻车，浪费好几分钟还装出一堆半成品）。这里直接调用唯一
    正确的那条命令，装完就地续跑。
    加锁：一次多 URL 并发探测有 4 个线程同时 require()，不锁就是 4 份并发安装互相
    覆盖下载缓存；拿到锁后先重新解析一次——多半上一个持锁者已经装好了。
    """
    if os.environ.get("VSS_NO_AUTOINSTALL"):
        return None
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preflight.py")
    if not os.path.isfile(script):
        return None
    with _install_lock:                               # 进程内互斥
        exe = which(name, refresh=True)
        if exe:
            return exe
        # 等锁 15 分钟够任何一次正常安装跑完（慢网 winget/OSS 也就几分钟）；再久
        # 多半是持锁者卡死，宁可放弃等待去重新解析一次，也别把整条命令拖到超时
        lock = FileLock(os.path.join(cache_dir(), "preflight-install.lock"),
                        timeout=900, stale_after=3600)
        if not lock.acquire():                        # 跨进程互斥
            return which(name, refresh=True)
        try:
            exe = which(name, refresh=True)
            if exe:
                return exe
            print(f"⏳ 缺少 {name}，正在自动安装依赖（首次 1–5 分钟，请勿中断）…",
                  file=sys.stderr, flush=True)
            # 输出收到 stderr：probe/status 的 stdout 是 JSON，混入安装日志会让
            # 调用方解析失败
            r = run_hidden([sys.executable, script, "--install"],
                           capture_output=True, text=True, timeout=1800)
            tail = "\n".join((r.stdout or "").strip().splitlines()[-6:])
            if tail:
                print(tail, file=sys.stderr, flush=True)
        except Exception as e:
            print(f"自动安装 {name} 失败：{e}", file=sys.stderr, flush=True)
        finally:
            lock.release()
        return which(name, refresh=True)


def require(name: str) -> str:
    """解析可执行文件；缺了就自动装一次再解析，仍然没有才报错退出。"""
    exe = which(name)
    if exe:
        return exe
    exe = _auto_install(name)
    if exe:
        print(f"✅ {name} 已自动安装：{exe}", file=sys.stderr, flush=True)
        return exe
    skill_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    die(f"找不到可执行文件 `{name}`，自动安装也没成功。\n"
        f"只跑这一条命令修复，然后原样重跑刚才的命令：\n"
        f"  python {os.path.join(skill_root, 'scripts', 'preflight.py')} --install\n"
        f"（脚本幂等，失败就原样重跑。不要用 where/Get-Command/winget/curl 自己找路径或\n"
        f"装 ffmpeg——这些路径实测全部翻车。已查过：PATH 以及 "
        f"{', '.join(_install_dirs(name)[:3])} 等已知安装位置。）")


def die(msg: str, code: int = 1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def run_hidden(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    """前台运行一条命令并抑制 Windows 控制台弹窗。

    subprocess.run 在 Windows 上启动一个控制台子进程（ffmpeg/npx/uvx/ffprobe/
    tasklist 等）时，默认会弹一个 cmd 窗口，隔几秒弹一次就被 agent 当成"卡住/
    别有目的"。传 capture_output 并不能阻止弹窗——必须显式加 CREATE_NO_WINDOW。
    macOS/Linux 没有"控制台弹窗"概念，原样转发，零行为变化。
    """
    if IS_WIN:
        kwargs.setdefault("creationflags", 0x08000000)  # CREATE_NO_WINDOW
    return subprocess.run(argv, **kwargs)


# ── 进程 ──────────────────────────────────────────────────────────────────

def process_name(pid: int) -> str | None:
    """返回进程名（小写、去掉 .exe），进程不存在返回 None。

    用进程名而不是单纯 pid 存活判断，是为了防 PID 复用误杀：下载任务可能跨轮次
    存活很久，中途 ffmpeg 退出、pid 被系统回收给别的进程，这时按 pid 强杀会打死
    无关进程。
    """
    try:
        if IS_WIN:
            out = run_hidden(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                capture_output=True, text=True, errors="replace", timeout=15,
            ).stdout.strip()
            if not out or "INFO:" in out or '"' not in out:
                return None
            name = out.split('","')[0].lstrip('"')
        else:
            out = run_hidden(
                ["ps", "-p", str(pid), "-o", "comm="],
                capture_output=True, text=True, timeout=15,
            ).stdout.strip()
            if not out:
                return None
            name = os.path.basename(out)
    except Exception:
        return None
    name = name.lower()
    return name[:-4] if name.endswith(".exe") else name


def is_alive(pid: int, name_prefix: str | None = None) -> bool:
    name = process_name(pid)
    if name is None:
        return False
    return True if name_prefix is None else name.startswith(name_prefix)


def detached_popen(argv: list[str], stdout=None, stderr=None, env=None) -> subprocess.Popen:
    """启动一个脱离当前 agent 会话的后台进程。

    下载动辄十几分钟，必须 detach，否则一个命令就把 agent 卡到超时；detach 后
    agent 靠轮询进度文件跨轮次汇报。
    """
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": stdout if stdout is not None else subprocess.DEVNULL,
        "stderr": stderr if stderr is not None else subprocess.DEVNULL,
        "env": env,
    }
    if IS_WIN:
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        kwargs["creationflags"] = (
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        )
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(argv, **kwargs)


class FileLock:
    """跨平台互斥锁（O_EXCL 建锁 + 死锁自愈）。

    并行起多个 `uvx mcp-vods` 会抢 uv 的缓存/临时可执行文件，表现成 Connection
    closed 或空结果，很容易被误判成"没有资源"。原来靠一句自然语言规则约束 agent，
    这里改成代码强制。
    """

    def __init__(self, path: str, timeout: float = 300, stale_after: float = 900):
        self.path = path
        self.timeout = timeout
        self.stale_after = stale_after
        self._held = False

    def _steal_if_stale(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                info = json.load(f)
            owner, ts = int(info.get("pid", -1)), float(info.get("ts", 0))
        except Exception:
            owner, ts = -1, 0.0
        expired = (time.time() - ts) > self.stale_after
        if expired or owner <= 0 or not is_alive(owner):
            try:
                os.remove(self.path)
            except OSError:
                pass

    def acquire(self) -> bool:
        deadline = time.time() + self.timeout
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                with os.fdopen(fd, "w") as f:
                    json.dump({"pid": os.getpid(), "ts": time.time()}, f)
                self._held = True
                return True
            except FileExistsError:
                self._steal_if_stale()
                if time.time() >= deadline:
                    return False
                time.sleep(1.0)

    def release(self):
        if self._held:
            try:
                os.remove(self.path)
            except OSError:
                pass
            self._held = False

    def __enter__(self):
        if not self.acquire():
            die("等待其它片源查询释放锁超时；请稍后重试，或删除锁文件 "
                f"{self.path} 后重试。", 4)
        return self

    def __exit__(self, *exc):
        self.release()


# ── ffmpeg/ffprobe 参数 ───────────────────────────────────────────────────

def http_input_args(referer: str = "", user_agent: str = "",
                    reconnect: bool = True, rw_timeout_s: int = 0,
                    reconnect_streamed: bool = True,
                    reconnect_at_eof: bool = True,
                    reconnect_max_retries: int = -1) -> list[str]:
    """构造 ffmpeg/ffprobe 的输入侧 HTTP 选项（必须放在 -i 之前）。

    UA 走 `-user_agent` 而不是塞进 `-headers`：ffmpeg 自己也会发一个默认 UA，
    塞在 headers 里会出现两个 User-Agent 头，部分源站直接判成异常请求拒绝。
    自定义头必须以 CRLF 结尾，少了结尾换行有些 build 会把下一行粘连。

    reconnect_max_retries 默认 -1（不设上限）适合下载——慢源偶发断流要多试几次；
    探测路径要"快速失败"让 agent 换源，应传小值（如 3）避免在死源上死等。
    """
    args: list[str] = ["-user_agent", user_agent or DEFAULT_UA]
    if referer:
        args += ["-headers", f"Referer: {referer}\r\n"]
    if reconnect:
        # 弱网/长时下载常见的中途断流，让 ffmpeg 自己重连而不是整单失败
        args += ["-reconnect", "1"]                      # 打开所有重连协议
        if reconnect_streamed:
            args += ["-reconnect_streamed", "1"]         # 流中断时重连
        if reconnect_at_eof:
            args += ["-reconnect_at_eof", "1"]           # 读到 EOF 也重连（直播/循环列表续拉）
        args += ["-reconnect_delay_max", "5"]
        if reconnect_max_retries != -1:                  # -1 = 不设上限
            args += ["-reconnect_max_retries", str(int(reconnect_max_retries))]
    if rw_timeout_s > 0:
        args += ["-rw_timeout", str(int(rw_timeout_s) * 1_000_000)]  # 微秒
    return args


def hms(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# ── HLS master → media playlist 下钻 ──────────────────────────────────────

def hls_fetch_text(url: str, referer: str = "", ua: str = "",
                   timeout: int = 20) -> str | None:
    """带默认浏览器 UA（可选 Referer）抓一次文本。失败返回 None 不抛。"""
    headers = {"User-Agent": ua or DEFAULT_UA}
    if referer:
        headers["Referer"] = referer
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(8 * 1024 * 1024).decode("utf-8", "replace")
    except Exception:
        return None


def resolve_media_playlist(url: str, referer: str = "", ua: str = "",
                           depth: int = 0) -> dict | None:
    """把 HLS master playlist 下钻到最高码率子流的真实分片清单。

    master playlist 里只有各档子流地址、没有分片。ffmpeg 直接喂 master 时，部分
    源站/清单会让它卡在解析阶段——进程活着、进度文件空、0%、mp4 没生成，表现成
    一种极难诊断的"死状态"。下载前先下钻到含 #EXTINF 的真实分片清单，能根治这类
    卡死。

    返回 dict（三平台探测与下载共用）：
      * url            真实分片清单 m3u8（master 可能递归下钻多次）
      * duration       由 #EXTINF 累加（秒，0=拿不到）
      * bandwidth_kbps master 里该档的 BANDWIDTH / 1000
      * note           说明（下钻过、或时长来源）
      * is_media       是否为分片清单（True）还是原样返回

    不是 HLS（无 .m3u8）/ 抓取失败 / 非 m3u8 内容时返回 None，调用方应回退用原 URL。
    纯函数、无副作用，probe 与 download 共用同一套逻辑，避免两处实现漂移。
    """
    if ".m3u8" not in url.lower() or depth >= 3:
        return None
    text = hls_fetch_text(url, referer, ua)
    if text is None or "#EXTM3U" not in text:
        return None
    if "#EXT-X-STREAM-INF" not in text:      # media playlist：含分片，可直接用
        total = sum(float(m)
                    for m in re.findall(r"#EXTINF:\s*([\d.]+)", text))
        return {"url": url, "duration": round(total, 1) if total > 0 else 0.0,
                "bandwidth_kbps": None,
                "note": "时长由 #EXTINF 累加得出" if total > 0 else None,
                "is_media": True,
                "text": text}   # 清单原文：给下载引擎判定用，免得再抓一次
    # master：挑 BANDWIDTH 最高那档下钻
    best, best_bw = None, -1
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF"):
            continue
        m = re.search(r"BANDWIDTH=(\d+)", line)
        bw = int(m.group(1)) if m else 0
        for nxt in lines[i + 1:]:
            nxt = nxt.strip()
            if nxt and not nxt.startswith("#"):
                if bw > best_bw:
                    best, best_bw = nxt, bw
                break
    if not best:
        return None
    child = resolve_media_playlist(urljoin(url, best), referer, ua, depth + 1)
    if child is None:
        # 下钻拿不到就返回该档子流地址本身，让 ffmpeg 直接试它
        return {"url": urljoin(url, best),
                "duration": 0.0, "bandwidth_kbps": best_bw // 1000 or None,
                "note": "master playlist：已选最高码率子流（未下钻成功）",
                "is_media": False}
    child["bandwidth_kbps"] = child.get("bandwidth_kbps") or (best_bw // 1000 or None)
    child["note"] = f"master playlist：已选最高码率子流（{best_bw // 1000} kbps）"
    child["is_media"] = True if child.get("url", "").lower().endswith(".m3u8") else False
    return child
