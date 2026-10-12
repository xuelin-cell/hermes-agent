"""HLS VOD 并发分片下载引擎。

ffmpeg 的 HLS 下载是逐分片串行拉流，源站普遍按单连接限速，几百 MB 的剧集常被压到
0.5–2x。这里把分片并发拉下来（默认 8 并发，失败自动降并发补试两轮），本地重写播放
列表后交给 ffmpeg 一次性合并——AES-128 分片按密文落盘，解密由合并时的 ffmpeg 完成，
所以加密源不需要特殊处理。限速源上吞吐普遍能拉高数倍。

只做 VOD（有 #EXT-X-ENDLIST）；直播、BYTERANGE 清单由 download_media.py 回退
ffmpeg 串行引擎，用 seg_supported() 判定。

分片落在 {输出名}.seg/ 工作目录，已存在且非空的分片直接跳过——失败后重跑同一条
start 即断点续传。全部分片齐了才合并（残缺分片绝不合并交差）；合并成功即清掉
工作目录。
"""

from __future__ import annotations

import os
import re
import shutil
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin

from _common import DEFAULT_UA, require, run_hidden

URI_RE = re.compile(r'URI="([^"]+)"')


def seg_supported(text: str | None) -> tuple[bool, str]:
    """这份 m3u8 文本能否交给分片引擎。不能时返回原因，调用方回退 ffmpeg。"""
    if not text or "#EXTM3U" not in text:
        return False, "无法读取清单内容"
    if "#EXT-X-STREAM-INF" in text:
        return False, "master 清单未下钻"
    if "#EXT-X-ENDLIST" not in text:
        return False, "直播/滚动清单（无 ENDLIST），并发下载会漏分片"
    if "#EXT-X-BYTERANGE" in text:
        return False, "BYTERANGE 分片"
    if "#EXTINF" not in text:
        return False, "清单里没有分片"
    return True, ""


def _fetch(url: str, referer: str, ua: str, timeout: int = 30,
           retries: int = 3) -> bytes:
    """带 UA/Referer 的下载，指数退避重试。全部失败抛最后一个异常。"""
    headers = {"User-Agent": ua or DEFAULT_UA}
    if referer:
        headers["Referer"] = referer
    delay, last = 1.0, None
    for _ in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(delay)
            delay *= 2
    raise last  # type: ignore[misc]


def _parse_playlist(text: str, base_url: str):
    """把媒体清单拆成 (分片列表, 密钥/初始化文件列表, 本地化重写后的清单文本)。

    分片重命名为 seg_00001.ts 之类的本地文件名；#EXT-X-KEY / #EXT-X-MAP 的 URI
    改指向本地 aux_ 文件。其余行（MEDIA-SEQUENCE、IV 等）原样保留——AES 默认 IV
    按媒体序号推导，动了这些行解密就错了。
    """
    segs: list[tuple[str, str, float]] = []   # (绝对URL, 本地名, EXTINF秒数)
    aux: list[tuple[str, str]] = []           # (绝对URL, 本地名)
    out_lines: list[str] = []
    pending_inf, aux_idx = 0.0, 0
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith(("#EXT-X-KEY", "#EXT-X-MAP", "#EXT-X-SESSION-KEY")):
            m = URI_RE.search(line)
            if m:
                aux_idx += 1
                ext = os.path.splitext(m.group(1).split("?")[0])[1] or ".bin"
                local = f"aux_{aux_idx:03d}{ext}"
                aux.append((urljoin(base_url, m.group(1)), local))
                line = line[:m.start(1)] + local + line[m.end(1):]
            out_lines.append(line)
        elif line.startswith("#EXTINF"):
            m = re.search(r"#EXTINF:\s*([\d.]+)", line)
            pending_inf = float(m.group(1)) if m else 0.0
            out_lines.append(line)
        elif line and not line.startswith("#"):
            ext = os.path.splitext(line.split("?")[0])[1] or ".ts"
            local = f"seg_{len(segs):05d}{ext}"
            segs.append((urljoin(base_url, line), local, pending_inf))
            pending_inf = 0.0
            out_lines.append(local)
        else:
            out_lines.append(raw)
    return segs, aux, "\n".join(out_lines) + "\n"


def _fmt_out_time(sec: float) -> str:
    """ffmpeg -progress 的 out_time 格式（H:MM:SS.ffffff），status 端同一套解析。"""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    return f"{h}:{m:02d}:{sec % 60:09.6f}"


def run_seg_download(url: str, out: str, referer: str, ua: str,
                     concurrency: int, max_size_mb: int,
                     progress_file: str, mp4_like: bool = True) -> int:
    """下载 + 合并全流程。stdout 已被 start 重定向到 .log 文件，print 即是日志。"""
    def log(*msg):
        print(*msg, flush=True)

    require("ffmpeg")   # 合并要用；缺了先报，别等分片全下完才发现白干
    concurrency = max(1, min(32, concurrency))

    try:
        text = _fetch(url, referer, ua).decode("utf-8", "replace")
    except Exception as e:
        log(f"拉取 m3u8 失败：{e}")
        return 1
    ok, why = seg_supported(text)
    if not ok:
        log(f"清单不适用分片引擎（{why}）")
        return 1
    segs, aux, local_playlist = _parse_playlist(text, url)
    if not segs:
        log("清单里没有分片")
        return 1
    total = len(segs)

    workdir = os.path.splitext(os.path.abspath(out))[0] + ".seg"
    os.makedirs(workdir, exist_ok=True)
    try:
        for aurl, name in aux:   # 密钥/初始化分片是小文件，串行下即可
            path = os.path.join(workdir, name)
            if not (os.path.exists(path) and os.path.getsize(path) > 0):
                with open(path, "wb") as f:
                    f.write(_fetch(aurl, referer, ua))
    except Exception as e:
        log(f"下载密钥/初始化分片失败：{e}")
        return 1
    with open(os.path.join(workdir, "local.m3u8"), "w", encoding="utf-8") as f:
        f.write(local_playlist)

    state = {"bytes": 0, "sec": 0.0, "done": 0, "abort": ""}
    t0, last_write = time.time(), [0.0]
    cap = max_size_mb * 1024 * 1024 if max_size_mb > 0 else 0

    def write_progress(final: bool = False):
        elapsed = max(time.time() - t0, 0.1)
        with open(progress_file, "a", encoding="utf-8") as f:
            f.write(f"out_time={_fmt_out_time(state['sec'])}\n"
                    f"total_size={state['bytes']}\n"
                    f"speed={state['sec'] / elapsed:.2f}x\n"
                    f"segs_done={state['done']}\nsegs_total={total}\n"
                    f"progress={'end' if final else 'continue'}\n")

    def dl_one(i: int) -> tuple[int, float]:
        seg_url, name, sec = segs[i]
        path = os.path.join(workdir, name)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return os.path.getsize(path), sec        # 续传：已有分片直接复用
        if state["abort"]:
            raise RuntimeError(state["abort"])
        data = _fetch(seg_url, referer, ua)
        tmp = path + ".part"                          # 先写临时名，防半截分片被当成完成
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return len(data), sec

    pending = list(range(total))
    for round_no, conc in enumerate((concurrency, max(2, concurrency // 2), 2)):
        if not pending or state["abort"]:
            break
        if round_no:
            log(f"第 {round_no + 1} 轮补试 {len(pending)} 个失败分片（并发降到 {conc}）…")
        cur, pending = pending, []
        with ThreadPoolExecutor(max_workers=conc) as ex:
            futs = {ex.submit(dl_one, i): i for i in cur}
            for fut in as_completed(futs):
                i = futs[fut]
                try:
                    nbytes, sec = fut.result()
                    state["bytes"] += nbytes
                    state["sec"] += sec
                    state["done"] += 1
                except Exception as e:
                    pending.append(i)
                    if not state["abort"]:
                        log(f"分片 {i + 1}/{total} 失败：{e}")
                if cap and state["bytes"] > cap and not state["abort"]:
                    state["abort"] = f"超出 --max-size-mb 上限（{max_size_mb}MB），中止"
                    log(state["abort"])
                now = time.time()
                if now - last_write[0] >= 1.0:
                    last_write[0] = now
                    write_progress()

    write_progress()
    if state["abort"]:
        return 1
    if pending:
        log(f"仍有 {len(pending)}/{total} 个分片下载失败（如 {sorted(pending)[:5]}）。"
            f"分片没下全不合并；重跑同一条 start 命令会跳过已完成分片续传，"
            f"多次仍失败就换源。")
        return 1

    log(f"全部 {total} 个分片下载完成（{state['bytes'] / 1024 / 1024:.0f} MB），开始合并…")
    argv = [require("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
            "-protocol_whitelist", "file,crypto,data",
            "-allowed_extensions", "ALL",
            "-i", os.path.join(workdir, "local.m3u8"), "-c", "copy"]
    first_ext = os.path.splitext(segs[0][1])[1].lower()
    if mp4_like and first_ext in (".ts", ".m2ts"):
        # TS 里是 ADTS 裸流，进 mp4 容器必须转 ASC；fMP4 分片则不能套这个 bsf
        argv += ["-bsf:a", "aac_adtstoasc"]
    argv.append(out)
    try:
        r = run_hidden(argv, capture_output=True, text=True, timeout=3600)
    except Exception as e:
        log(f"合并失败：{e}")
        return 1
    if r.returncode != 0 or not os.path.exists(out):
        log(f"合并失败（exit {r.returncode}）：\n{(r.stderr or '').strip()[-2000:]}")
        log(f"分片保留在 {workdir}，排查后重跑 start 可续传/重新合并。")
        return 1
    write_progress(final=True)
    shutil.rmtree(workdir, ignore_errors=True)
    log(f"下载完成：{out}（{os.path.getsize(out) / 1024 / 1024:.1f} MB）")
    return 0
