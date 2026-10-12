#!/usr/bin/env python3
"""媒体探测：判断 m3u8/mp4 是不是真能播的正片（跨平台）。

    python3 scripts/probe_media.py "https://.../index.m3u8" [--expect movie|tv] \
        [--referer PAGE_URL] [--user-agent UA] [--sample] [--json]
    python3 scripts/probe_media.py "{ep1}" "{ep20}" "{ep39}" --expect tv --json

支持一次传多条 URL：并发探测（≤4 并发），抽检首/中/末集一条命令完成——逐条串行探
每条最长要等 2 分钟，串三次就是六分钟，贵到让人想跳过验证，而验证恰恰是可靠性的
底线。

输出一份结构化摘要 + 一句可直接写进结果表的结论，而不是把 ffprobe 原始 JSON 丢回
去让 agent 自己解析。这里替 agent 做完了三件以前要手工做的事：

  1. m3u8 拿不到 duration 时，抓播放列表把 #EXTINF 加起来（HLS 的 duration 经常是
     N/A，直接判"时长未知"会误杀大量好源）。
  2. master playlist 自动挑最高码率/分辨率的子流再探，否则读到的是清单不是视频。
  3. 时长硬门槛判定：预告片/花絮/几分钟的切片是这类搜索最主要的假阳性来源，
     所以时长是门槛不是加分项。

被防盗链挡住时会自动带浏览器 UA 重试一次（大部分源站这一步就过了）；仍然失败再
考虑补 --referer。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True   # 别在用户目录留 __pycache__（这里常是同步盘）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (DEFAULT_UA, hms, http_input_args, require,  # noqa: E402
                     resolve_media_playlist, run_hidden)

# 时长硬门槛（秒）。unknown 只砍明显异常的，避免误杀。
GATES = {
    "movie": (30 * 60, 300 * 60, "电影正片通常 30–300 分钟"),
    "tv": (10 * 60, 180 * 60, "单集通常 10–180 分钟"),
    "unknown": (5 * 60, 600 * 60, "明显过短多为预告/切片"),
}


def resolve_hls(url: str, referer: str, ua: str, depth: int = 0) -> dict:
    """把一条 m3u8 解析成 {url, duration, bandwidth_kbps, note, is_media}。

    下钻/累计逻辑收敛在 _common.resolve_media_playlist（探测与下载共用，避免两处
    实现漂移）。这里做三层事：
      * master playlist 里只有各档子流地址、没有分片，必须先下钻到码率最高的那档，
        否则读到的是清单不是视频，时长恒为 0、好源全被判成不可播。
      * HLS 的 format.bit_rate / format.size 描述的是清单文件本身（实测 29 bps /
        6.7 KB），拿来当画质指标是错的；真正的码率在 master 的 BANDWIDTH 里。
      * 把共享函数"解析失败返回 None"归一化成调用方熟悉的空 dict，避免 main 里
        到处判 None。
    """
    r = resolve_media_playlist(url, referer, ua, depth)
    if r is None:
        return {"url": url, "duration": None, "bandwidth_kbps": None,
                "note": None, "is_media": False}
    r["duration"] = round(r["duration"], 1) if r["duration"] else None
    return r


def ffprobe(url: str, referer: str, ua: str) -> dict | None:
    argv = [require("ffprobe"), "-v", "error",
            *http_input_args(referer, ua, reconnect=False, rw_timeout_s=20),
            "-show_entries", "format=duration,size,bit_rate",
            "-show_streams", "-of", "json", "-i", url]
    try:
        r = run_hidden(argv, capture_output=True, text=True, timeout=120)
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None
    except Exception:
        return None


def sample_play(url: str, referer: str, ua: str, seconds: int = 15) -> bool:
    """真拉一小段，验证"能解析"之外还"真能播"。分片 404、密钥失效这类问题
    只有实际拉流才暴露得出来。"""
    null_dev = "NUL" if os.name == "nt" else "/dev/null"
    argv = [require("ffmpeg"), "-hide_banner", "-y",
            *http_input_args(referer, ua, rw_timeout_s=20,
                             reconnect_max_retries=3),
            "-i", url, "-t", str(seconds), "-c", "copy", "-f", "null", null_dev]
    try:
        return run_hidden(argv, capture_output=True, text=True, timeout=180).returncode == 0
    except Exception:
        return False


def probe_one(url: str, a, ua: str) -> dict:
    out: dict = {"url": url, "notes": []}

    media_url = url
    hls_duration = hls_kbps = None
    is_hls = ".m3u8" in url.lower()
    if is_hls:
        h = resolve_hls(url, a.referer, ua)
        media_url, hls_duration, hls_kbps = h["url"], h["duration"], h["bandwidth_kbps"]
        if h["note"]:
            out["notes"].append(h["note"])
        if media_url != url:
            out["variant_url"] = media_url

    info = ffprobe(media_url, a.referer, ua)
    if info is None and not a.user_agent:
        out["notes"].append("首次探测失败，已带浏览器 UA 重试")
        info = ffprobe(media_url, a.referer, DEFAULT_UA)

    duration = None
    if info:
        fmt = info.get("format", {}) or {}
        try:
            duration = float(fmt.get("duration")) or None
        except (TypeError, ValueError):
            duration = None
        vs = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
        as_ = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), {})
        w, h = vs.get("width"), vs.get("height")
        out.update({
            "reachable": True,
            "width": w, "height": h,
            "resolution": f"{w}x{h}" if w and h else None,
            "quality_label": (
                "4K" if (h or 0) >= 1900 else "1080P" if (h or 0) >= 1000
                else "720P" if (h or 0) >= 700 else "480P" if h else None
            ),
            "video_codec": vs.get("codec_name"),
            "audio_codec": as_.get("codec_name"),
        })
        # 只有非 HLS（mp4 等单文件）的 format.bit_rate/size 才描述视频本身
        if not is_hls:
            try:
                if int(fmt.get("bit_rate")) > 0:
                    out["bitrate_kbps"] = int(fmt.get("bit_rate")) // 1000
            except (TypeError, ValueError):
                pass
            try:
                if int(fmt.get("size")) > 0:
                    out["size_mb"] = round(int(fmt.get("size")) / 1024 / 1024, 1)
            except (TypeError, ValueError):
                pass
    else:
        out["reachable"] = False
        out["notes"].append("ffprobe 无法读取该地址（失效/防盗链/需要 Referer）")

    if not duration and hls_duration:
        duration = hls_duration
    out["duration_seconds"] = round(duration, 1) if duration else None
    out["duration_hms"] = hms(duration) if duration else None

    # HLS 的码率来自 master 的 BANDWIDTH；视频流自报的次之
    if is_hls and hls_kbps:
        out["bitrate_kbps"] = hls_kbps
    elif "bitrate_kbps" not in out and info:
        try:
            vb = int(next((s for s in info.get("streams", [])
                           if s.get("codec_type") == "video"), {}).get("bit_rate"))
            if vb > 0:
                out["bitrate_kbps"] = vb // 1000
        except (TypeError, ValueError, StopIteration):
            pass

    # 预估下载体积，直接喂给 download_media.py 的 --est-size-mb 做磁盘预检，
    # 省得 agent 自己拿码率乘时长再换算（这一步很容易算错单位）
    if duration and out.get("bitrate_kbps"):
        out["est_size_mb"] = int(duration * out["bitrate_kbps"] * 1000 / 8 / 1024 / 1024)

    # 时长门槛
    if duration:
        if a.expect_minutes > 0:
            lo, hi = (a.expect_minutes - 12) * 60, (a.expect_minutes + 12) * 60
            reason = f"已知片长约 {a.expect_minutes:.0f} 分钟，允许 ±12 分钟"
        else:
            lo, hi, reason = GATES[a.expect]
        out["duration_ok"] = bool(lo <= duration <= hi)
        if not out["duration_ok"]:
            out["notes"].append(f"时长 {hms(duration)} 不在合理区间（{reason}），"
                                f"多半是预告片/切片/错误片源")
    else:
        out["duration_ok"] = None
        if out["reachable"]:
            out["notes"].append("拿不到时长：可播但无法做时长核验，最多标 ⚠️")

    if a.sample and out["reachable"]:
        out["sample_playable"] = sample_play(media_url, a.referer, ua)
        if not out["sample_playable"]:
            out["notes"].append("拉流抽样失败：分片可能已失效或需要 Referer")

    if out["reachable"] and out["duration_ok"] is not False:
        out["verdict"] = "pass" if out.get("sample_playable", True) else "fail"
    else:
        out["verdict"] = "fail"
    return out


def render(out: dict) -> None:
    mark = "✅" if out["verdict"] == "pass" else "❌"
    bits = [b for b in (out.get("quality_label"), out.get("duration_hms"),
                        f"{out['bitrate_kbps']} kbps" if out.get("bitrate_kbps") else None) if b]
    print(f"{mark} {' / '.join(bits) if bits else '无法读取'}  {out['url']}")
    for n in out["notes"]:
        print(f"   · {n}")


def main() -> int:
    p = argparse.ArgumentParser(description="探测媒体链接是否为可播正片")
    p.add_argument("urls", nargs="+", metavar="url",
                   help="一条或多条媒体 URL；多条时并发探测（≤4 并发），适合抽检首/中/末集")
    p.add_argument("--expect", choices=["movie", "tv", "unknown"], default="unknown")
    p.add_argument("--expect-minutes", type=float, default=0,
                   help="已知片长（分钟）时给上，按 ±12 分钟严格卡")
    p.add_argument("--referer", default="")
    p.add_argument("--user-agent", default="")
    p.add_argument("--sample", action="store_true", help="额外拉 15 秒验证真实可播")
    p.add_argument("--json", action="store_true", help="只输出 JSON")
    a = p.parse_args()

    ua = a.user_agent or DEFAULT_UA
    if len(a.urls) == 1:
        outs = [probe_one(a.urls[0], a, ua)]
    else:
        # 逐条串行探太慢（死源每条最长 2 分钟），并发跑；≤4 并发防打挂源站
        with ThreadPoolExecutor(max_workers=min(4, len(a.urls))) as ex:
            outs = list(ex.map(lambda u: probe_one(u, a, ua), a.urls))

    all_pass = all(o["verdict"] == "pass" for o in outs)
    payload = outs[0] if len(outs) == 1 else outs
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if all_pass else 1

    for o in outs:
        render(o)
    if len(outs) > 1:
        print(f"# 通过 {sum(1 for o in outs if o['verdict'] == 'pass')}/{len(outs)}")
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
