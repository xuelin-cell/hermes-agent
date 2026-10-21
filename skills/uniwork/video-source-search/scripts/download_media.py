#!/usr/bin/env python3
"""m3u8/mp4 下载 + 聊天可见进度（跨平台）。

    python3 scripts/download_media.py run --url "https://.../index.m3u8" \
        --out "狂飙E01.mp4" --duration 2625 [--referer PAGE] [--est-size-mb 900]
    python3 scripts/download_media.py status --out "狂飙E01.mp4"
    python3 scripts/download_media.py wait-status --out "狂飙E01.mp4" --notify-after 600
    python3 scripts/download_media.py stop   --out "狂飙E01.mp4"

设计要点：

  * run 等待真实下载结束，由 Hermes terminal(background=true, notify_on_complete=true)
    跟踪整棵进程树；start 保留旧版 detached 行为，不用于 Hermes 完成通知。
  * status 直接吐一句能贴给用户的中文进度 —— 进度文件是 ffmpeg 的 key=value 流，
    每轮让 agent 自己解析既费 token 又容易把 out_time_ms（实际是微秒，ffmpeg 的
    历史遗留坑）算错 1000 倍。
  * HLS master→分片清单自动下钻 —— 把 master 直接喂 ffmpeg 在部分源站上会卡在
    解析阶段（进程活着但 0% 进度、进度文件空），start 里先解析到最高码率分片清单
    再下载，根治这类死状态。
  * 并发分片引擎（默认 --engine auto）—— HLS VOD 清单走 _seg.py 并发下载分片再
    合并：源站普遍按单连接限速，ffmpeg 逐分片串行常被压到 0.5–2x，并发在限速源
    上快数倍，还自带失败降并发补试和断点续传。直播/BYTERANGE/非 HLS 自动回退
    ffmpeg 串行，进度输出两套引擎共用同一格式，status 无感知。
  * 看门狗防跑飞 —— 直播源/循环播放列表会无限拉流，写爆磁盘。
  * 磁盘预检 + 并发闸 —— 下载失败最常见的两个非网络原因。
"""

from __future__ import annotations

import argparse
import contextlib
import glob
import io
import json
import math
import os
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True   # 别在用户目录留 __pycache__（这里常是同步盘）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (DEFAULT_UA, detached_popen, hms, http_input_args,  # noqa: E402
                     is_alive, require, resolve_media_playlist, run_hidden)
from _seg import run_seg_download, seg_supported  # noqa: E402

MP4_LIKE = {".mp4", ".m4v", ".mov"}


def sidecars(out: str) -> dict:
    """伴生文件路径。键名一律带 _file 后缀，免得和 meta 里的数值字段（尤其是
    pid）撞名——撞了会把进程号悄悄写成一个路径字符串。"""
    base = os.path.splitext(out)[0]
    return {"progress_file": base + ".progress.txt", "pid_file": base + ".pid.txt",
            "meta_file": base + ".meta.json", "log_file": base + ".log"}


# ── start ────────────────────────────────────────────────────────────────

def check_disk(out: str, duration: float, est_mb: int, min_free_mb: int,
               assumed_kbps: int, factor: float = 1.2) -> str | None:
    """shutil.disk_usage 各平台通用，取代原来只认 Windows 盘符的 DriveInfo。
    factor：分片引擎峰值要同时容纳全部分片和合并输出，传 2.2；ffmpeg 串行 1.2。"""
    d = os.path.dirname(os.path.abspath(out)) or "."
    os.makedirs(d, exist_ok=True)
    try:
        free = shutil.disk_usage(d).free
    except OSError:
        return None  # 量不到就放行：预检是护栏，不该自己变成拦路虎
    if est_mb > 0:
        est = est_mb * 1024 * 1024
    elif duration > 0:
        est = int(duration * assumed_kbps * 1000 / 8)
    else:
        est = 0
    need = int(est * factor) + min_free_mb * 1024 * 1024
    if free < need:
        return (f"磁盘预检未通过：{d} 剩余 {free // 1024 // 1024}MB < 需要 "
                f"{need // 1024 // 1024}MB（预估 {est // 1024 // 1024}MB ×{factor:g} + "
                f"保留 {min_free_mb}MB）。清理磁盘或换输出目录后重试。")
    return None


def concurrency_ok(out: str, limit: int) -> tuple[bool, int]:
    """扫同目录 pid 文件数活着的下载进程，顺手清僵尸 pid 文件。
    进程名从伴生 meta 读（ffmpeg 引擎是 ffmpeg，分片引擎是 python worker）。
    并发数由 I/O 余量决定，和 CPU 核数无关；开太多会把弱机/HDD 拖到假死。"""
    d = os.path.dirname(os.path.abspath(out)) or "."
    alive = 0
    for f in glob.glob(os.path.join(d, "*.pid.txt")):
        try:
            pid = int(open(f, encoding="utf-8").read().strip())
        except Exception:
            continue
        name = "ffmpeg"
        try:
            with open(f[:-len(".pid.txt")] + ".meta.json", encoding="utf-8") as mf:
                name = json.load(mf).get("proc_name") or "ffmpeg"
        except Exception:
            pass
        if is_alive(pid, name):
            alive += 1
        else:
            try:
                os.remove(f)
            except OSError:
                pass
    return alive < limit, alive


def cmd_start(a) -> int:
    a.out = os.path.abspath(a.out)
    sc = sidecars(a.out)

    if a.cmd == "run" and os.path.isfile(sc["pid_file"]):
        with open(sc["pid_file"], encoding="utf-8") as recorded:
            old_pid = int(recorded.read().strip())
        if is_alive(old_pid):
            print("该输出路径已有下载进程，请先查询或停止原任务。")
            return 2

    if a.max_concurrent > 0:
        ok, alive = concurrency_ok(a.out, a.max_concurrent)
        if not ok:
            print(f"并发已达上限：{alive} 个下载进行中 >= {a.max_concurrent}。"
                  f"先等已有下载完成，或用 stop 结束后重试。")
            return 2

    # master playlist 自动下钻到真实分片清单，再交给下载引擎——这是"进程活着但 0%
    # 进度、进度文件空、mp4 没生成"这类死状态最常见的根因（ffmpeg 直接喂 master
    # 在部分源站上会卡在解析阶段）。解析失败则回退用原 URL，不影响下载尝试。
    feed_url = a.url
    resolved = None
    if not a.no_resolve and ".m3u8" in a.url.lower():
        resolved = resolve_media_playlist(a.url, a.referer, a.user_agent)
        if resolved and resolved.get("is_media"):
            feed_url = resolved["url"]
            if feed_url != a.url:
                print(f"HLS master 已解析到分片清单：{feed_url}")
        else:
            print("未能解析 HLS 清单，回退用原 URL 下载。")
    if a.duration <= 0 and resolved and resolved.get("duration"):
        # 忘了传 --duration 时用清单累计时长补上：percent/安全帽/看门狗都靠它
        a.duration = float(resolved["duration"])
        print(f"未传 --duration，已按清单累计时长 {hms(a.duration)} 估算进度")

    # 引擎选择：HLS VOD（有 ENDLIST、非 BYTERANGE）默认走并发分片引擎——源站普遍
    # 按单连接限速，ffmpeg 逐分片串行常被压到 0.5–2x，分片并发在限速源上快数倍，
    # 还自带失败降并发补试和断点续传。直播/BYTERANGE/非 HLS 回退 ffmpeg 串行。
    engine = "ffmpeg"
    if a.engine != "ffmpeg" and resolved and resolved.get("is_media"):
        seg_ok, why = seg_supported(resolved.get("text"))
        if seg_ok:
            engine = "seg"
        elif a.engine == "seg":
            print(f"分片引擎不适用（{why}），回退 ffmpeg 串行下载。")
    elif a.engine == "seg":
        print("分片引擎只支持 HLS 分片清单，回退 ffmpeg 串行下载。")

    if not a.skip_disk_check and a.min_free_mb > 0:
        err = check_disk(a.out, a.duration, a.est_size_mb, a.min_free_mb,
                         a.assumed_kbps, factor=2.2 if engine == "seg" else 1.2)
        if err:
            print(err)
            return 3

    for f in (sc["progress_file"], sc["log_file"]):
        try:
            os.remove(f)
        except OSError:
            pass

    if engine == "seg":
        conc = max(1, min(32, a.seg_concurrency))
        argv = [sys.executable, os.path.abspath(__file__), "_segworker",
                "--url", feed_url, "--out", a.out,
                "--referer", a.referer, "--user-agent", a.user_agent,
                "--concurrency", str(conc), "--max-size-mb", str(a.max_size_mb),
                "--progress-file", sc["progress_file"]]
        proc_name = "python"
        print(f"HLS VOD：使用并发分片引擎（{conc} 并发；失败自动降并发补试，"
              f"重跑同一条 start 可断点续传）。")
    else:
        in_args = http_input_args(a.referer, a.user_agent, rw_timeout_s=a.read_timeout)
        out_args = ["-c", "copy"]
        if os.path.splitext(a.out)[1].lower() in MP4_LIKE:
            # HLS 的 TS 里是 ADTS 裸流，进 mp4 容器必须转 ASC，否则播放器认不出音轨
            out_args += ["-bsf:a", "aac_adtstoasc"]
        if a.duration > 0:
            # 时长安全帽：直播源/循环列表不会自己停
            out_args += ["-t", str(int(a.duration * 1.15 + 120))]
        if a.max_size_mb > 0:
            out_args += ["-fs", str(a.max_size_mb * 1024 * 1024)]
        out_args += ["-progress", sc["progress_file"], "-stats_period", "1", a.out]

        # 日志只留 error：进度已经走 -progress 文件，stats 行和 HLS 重封装每帧都报的
        # "Invalid DTS ... replacing by guess" 会把日志撑到几百 MB（实测 14 秒 820KB），
        # 真正的失败原因反而被淹没。这个日志的用途只有一个——下载失败时回答"为什么"。
        argv = [require("ffmpeg"), "-hide_banner", "-nostats", "-loglevel", "error",
                "-y", *in_args, "-i", feed_url, *out_args]
        proc_name = "ffmpeg"

    if a.cmd == "run":
        from _managed import run_download

        wall = a.max_wall if a.max_wall > 0 else int(a.duration * 4 + 900) if a.duration > 0 else 7200
        return run_download(
            argv, out=a.out, sidecars=sc,
            metadata={"duration": a.duration, "engine": engine, "proc_name": proc_name},
            max_wall=wall, stall_after=a.stall_after,
        )

    # stderr 落盘：原来 detach 后 ffmpeg 的报错随隐藏窗口一起丢了，下载失败时
    # 完全无从查起（防盗链？分片 404？编码不兼容？），现在 status 能直接回读。
    log = open(sc["log_file"], "w", encoding="utf-8", errors="replace")
    proc = detached_popen(argv, stdout=log, stderr=subprocess.STDOUT)

    # 启动判定：等到"明确成功（已有进度产出）"或"明确失败（进程退出）"，而不是
    # 固定短窗口——慢源要几十秒才拉起首个分片，真失败也常拖到一个读超时后才退。
    # 进度文件一有产出就提前放行，健康启动几秒即返回，不再前台傻等满 30s。
    wait_cap = int(a.read_timeout) if a.read_timeout > 0 else 30
    deadline = time.time() + wait_cap + 5
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            if os.path.getsize(sc["progress_file"]) > 0:
                break
        except OSError:
            pass
        time.sleep(0.5)
    if proc.poll() is not None and proc.returncode != 0:
        tail = read_log_tail(sc["log_file"])
        print(f"下载启动失败（engine={engine}，exit {proc.returncode}）：\n{tail}")
        try:
            os.remove(sc["pid_file"])
        except OSError:
            pass
        return proc.returncode

    # 进程还在跑：落 pid/meta，并起一个 exit-watcher，进程一旦退出就把退出码和
    # 失败原因写进 meta。这样启动判定之后才偶发失败的下载，status 能报清楚
    # "exit N + 原因"，而不是干巴巴的"未在运行且无进度"。
    with open(sc["pid_file"], "w", encoding="utf-8") as f:
        f.write(str(proc.pid))
    with open(sc["meta_file"], "w", encoding="utf-8") as f:
        json.dump({"url": a.url, "feed_url": feed_url if feed_url != a.url else "",
                   "out": os.path.abspath(a.out),
                   "duration": a.duration, "pid": proc.pid,
                   "engine": engine, "proc_name": proc_name,
                   "started": time.time(), **sc}, f, ensure_ascii=False)
    detached_popen([sys.executable, os.path.abspath(__file__), "_exitwatcher",
                    "--pid", str(proc.pid), "--proc-name", proc_name,
                    "--meta-file", sc["meta_file"],
                    "--log-file", sc["log_file"]])

    if not a.no_watchdog:
        wall = (a.max_wall if a.max_wall > 0
                else int(a.duration * 4 + 900) if a.duration > 0 else 7200)
        detached_popen([sys.executable, os.path.abspath(__file__), "_watchdog",
                        "--pid", str(proc.pid), "--proc-name", proc_name,
                        "--pid-file", sc["pid_file"],
                        "--max-wall", str(wall)])

    print(f"已在后台开始下载（engine={engine}）：pid={proc.pid}")
    print(f"用这条命令查进度（不要前台等待）："
          f"\n  python3 {os.path.basename(__file__)} status --out \"{a.out}\"")
    return 0


# ── status ───────────────────────────────────────────────────────────────

def read_progress(path: str) -> dict:
    """取进度文件里最后一个完整块。ffmpeg 是不断追加 key=value 的。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return {}
    cur, last = {}, {}
    for line in lines:
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        cur[k.strip()] = v.strip()
        if k.strip() == "progress":
            last, cur = cur, {}
    return last or cur


def parse_out_time(p: dict) -> float:
    """out_time 是 HH:MM:SS.ffffff，最可靠；out_time_ms 名字叫 ms、实际是微秒，
    直接当毫秒用会差 1000 倍。"""
    t = p.get("out_time")
    if t and ":" in t:
        try:
            h, m, s = t.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
        except ValueError:
            pass
    for k in ("out_time_us", "out_time_ms"):
        if p.get(k, "").lstrip("-").isdigit():
            return int(p[k]) / 1_000_000
    return 0.0


def read_log_tail(path: str, n: int = 12) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        return "\n".join(lines[-n:]) or "(无输出)"
    except OSError:
        return "(无日志)"


def cmd_status(a) -> int:
    sc = sidecars(a.out)
    meta = {}
    try:
        meta = json.load(open(sc["meta_file"], encoding="utf-8"))
    except Exception:
        pass
    duration = a.duration or float(meta.get("duration") or 0)
    pid = int(meta.get("pid") or 0)
    proc_name = meta.get("proc_name") or "ffmpeg"
    running = bool(pid) and is_alive(pid, proc_name)

    p = read_progress(sc["progress_file"])
    done_time = parse_out_time(p)
    size_mb = int(p.get("total_size", 0) or 0) / 1024 / 1024
    speed = p.get("speed", "").rstrip("x")
    managed = meta.get("managed", False)
    finished = bool(meta.get("completed")) and not running if managed else p.get("progress") == "end"
    out_exists = os.path.exists(a.out)
    segs_done, segs_total = p.get("segs_done"), p.get("segs_total")

    st = {"running": running, "finished": finished,
          "processed_seconds": round(done_time, 1), "size_mb": round(size_mb, 1),
          "speed": speed, "duration": duration}
    if segs_total:
        st["segs_done"], st["segs_total"] = int(segs_done or 0), int(segs_total)
    if duration > 0:
        st["percent"] = round(min(100.0, done_time / duration * 100), 1)

    if a.json:
        print(json.dumps(st, ensure_ascii=False))
        return 0

    if finished or (not managed and not running and out_exists and done_time > 0):
        real = os.path.getsize(a.out) / 1024 / 1024 if out_exists else size_mb
        print(f"下载完成：{a.out}，共 {hms(done_time)}，{real:.1f} MB")
        return 0
    if managed and not running:
        print(f"下载未完成：{meta.get('error') or read_log_tail(sc['log_file']) or '下载进程已退出。'}")
        return 1
    if not running and not done_time:
        # exit-watcher 已把"为什么退出"写进 meta，比现场读日志更完整（退出到查
        # status 之间可能又刷了几百行）。给出可执行的下一步，而不是干巴巴报"没进度"。
        reason = meta.get("exit_tail") or read_log_tail(sc["log_file"])
        hint = ""
        if "403" in reason or "forbidden" in reason.lower():
            hint = "；疑似防盗链，试加 --referer 播放页"
        elif "timeout" in reason.lower() or "timed out" in reason.lower():
            hint = "；源站响应太慢/被限速，试 --read-timeout 调大或换源"
        elif "404" in reason or "not found" in reason.lower():
            hint = "；分片或列表 404，试换源"
        print(f"下载未完成（进程已退出）。ffmpeg 最后输出：\n{reason}{hint}")
        return 1

    pct = f"{st['percent']}%" if "percent" in st else "进度未知"
    total = f" / {hms(duration)}" if duration > 0 else ""
    line = f"下载进度：{pct}，已处理 {hms(done_time)}{total}，速度 {speed or '?'}x，文件 {size_mb:.0f} MB"
    if segs_total:
        line += f"，分片 {segs_done}/{segs_total}"
    try:
        sp = float(speed)
        if duration > 0 and sp > 0:
            line += f"，预计剩余 {hms((duration - done_time) / sp)}"
    except ValueError:
        pass
    print(line)

    if not running:
        print(f"⚠️ 下载进程已退出但未完成，可能中断。最后输出：\n{read_log_tail(sc['log_file'])}")
        return 1
    # 卡死检测：进程活着但进度长时间不动。分两种情况——
    #   1) 进度文件存在但 2 分钟没更新：多半是源站限速/分片挂了/防盗链。
    #   2) 进度文件压根没生成或为空：ffmpeg 连首个分片都还没拉到（可能卡在打开
    #      输入、或该源起流极慢）。这类最容易误判成"正在下"，给个明确线索。
    prog_age = None
    try:
        prog_age = time.time() - os.path.getmtime(sc["progress_file"])
    except OSError:
        prog_age = None
    if prog_age is not None and prog_age > 120:
        print("⚠️ 进度已超过 2 分钟没有变化，源可能已卡死；"
              "可以 stop 后换源重试（检查是否缺 --referer）。")
    elif prog_age is None:  # 进度文件从未生成/读取失败
        try:
            with open(sc["progress_file"], encoding="utf-8", errors="replace") as f:
                empty = not f.read().strip()
        except OSError:
            empty = True
        if empty:
            print("⚠️ 下载进程存活但尚无任何进度产出，可能卡在打开源开始拉流之前。"
                  "通常是源站慢、需防盗链 Referer，或该 m3u8 是 master 清单未解析成"
                  "分片清单。可以再等一会，或 stop 后带 --referer 换源重试。")
    return 0


def _status_snapshot(out: str, duration: float = 0) -> dict:
    """Return ``status --json`` data without exposing intermediate output."""
    buf = io.StringIO()
    args = argparse.Namespace(out=out, duration=duration, json=True)
    with contextlib.redirect_stdout(buf):
        cmd_status(args)
    output = buf.getvalue().strip()
    if not output:
        raise RuntimeError("status 未返回结果")
    return json.loads(output.splitlines()[-1])


def _progress_stalled_seconds(out: str) -> float | None:
    """Return seconds since the latest progress signal, if it can be determined."""
    sc = sidecars(out)
    now = time.time()
    try:
        if os.path.getsize(sc["progress_file"]) > 0:
            return max(0.0, now - os.path.getmtime(sc["progress_file"]))
    except OSError:
        pass

    try:
        with open(sc["meta_file"], encoding="utf-8") as f:
            started = float(json.load(f).get("started") or 0)
        if started > 0:
            return max(0.0, now - started)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return None


def cmd_wait_status(a) -> int:
    """Silently poll until a reminder is due or the download reaches a terminal state.

    This keeps frequent process checks inside one CLI invocation so the agent does
    not create a visible chat message for every poll.
    """
    notify_after = max(1, int(a.notify_after))
    poll_seconds = max(1, min(int(a.poll_seconds), notify_after))
    stall_after = max(1, int(a.stall_after))
    max_wait_seconds = max(1, min(int(a.max_wait_seconds), notify_after))
    deadline = time.monotonic() + notify_after
    slice_deadline = time.monotonic() + max_wait_seconds

    while True:
        try:
            status = _status_snapshot(a.out, a.duration)
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
            print(json.dumps({"wait_reason": "status_error", "error": str(exc)},
                             ensure_ascii=False))
            return 1

        if status.get("finished") or not status.get("running"):
            status["wait_reason"] = "terminal"
            print(json.dumps(status, ensure_ascii=False))
            return 0

        stalled_seconds = _progress_stalled_seconds(a.out)
        if stalled_seconds is not None and stalled_seconds >= stall_after:
            status["wait_reason"] = "stalled"
            status["stalled_seconds"] = round(stalled_seconds, 1)
            print(json.dumps(status, ensure_ascii=False))
            return 0

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            status["wait_reason"] = "reminder_due"
            print(json.dumps(status, ensure_ascii=False))
            return 0

        slice_remaining = slice_deadline - time.monotonic()
        if slice_remaining <= 0:
            status["wait_reason"] = "continue_waiting"
            status["remaining_seconds"] = max(1, math.ceil(remaining))
            print(json.dumps(status, ensure_ascii=False))
            return 0

        time.sleep(min(poll_seconds, remaining, slice_remaining))


# ── stop / watchdog ──────────────────────────────────────────────────────

def kill(pid: int, name: str = "ffmpeg") -> bool:
    if not is_alive(pid, name):
        return False
    try:
        if os.name == "nt":
            # /T 连子进程一起杀：分片引擎合并阶段会挂一个 ffmpeg 子进程
            run_hidden(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=30)
        else:
            try:
                os.killpg(pid, 9)   # detached 进程是组长，连合并用的子 ffmpeg 一起杀
            except OSError:
                os.kill(pid, 9)
        return True
    except Exception:
        return False


def cmd_stop(a) -> int:
    sc = sidecars(a.out)
    name = "ffmpeg"
    try:
        name = json.load(open(sc["meta_file"], encoding="utf-8")).get("proc_name") or "ffmpeg"
    except Exception:
        pass
    try:
        pid = int(open(sc["pid_file"], encoding="utf-8").read().strip())
    except Exception:
        print("没有找到运行中的下载记录，无需清理。")
        return 0
    print(f"已结束下载进程 pid={pid}" if kill(pid, name)
          else f"pid={pid} 不是存活的下载进程（已退出或 PID 被回收），跳过。")
    try:
        os.remove(sc["pid_file"])
    except OSError:
        pass
    return 0


def cmd_watchdog(a) -> int:
    deadline = time.time() + a.max_wall
    finished = False
    while time.time() < deadline:
        time.sleep(30)
        if not is_alive(a.pid, a.proc_name):
            finished = True  # 正常结束
            break
    if not finished:
        kill(a.pid, a.proc_name)  # 超墙钟：直播源/循环列表跑飞了，强杀
    try:
        os.remove(a.pid_file)  # 两种情况都清 pid 文件，免得占着并发名额
    except OSError:
        pass
    return 0


def cmd_exitwatcher(a) -> int:
    """启动判定之后才退出的下载（偶现失败的主因）：等进程结束，把"已退出 + 失败
    原因（日志尾部）"写进 meta，让 status 报得出"为什么没下完"，而不是只看得到
    "没在运行、没进度"。退出码对已 detach 的非子进程用 stdlib 读不到，这里不硬编。"""
    while is_alive(a.pid, a.proc_name):
        time.sleep(5)
    try:
        with open(a.meta_file, encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        meta = {}
    meta["exited"] = True
    meta["exit_at"] = time.time()
    meta["exit_tail"] = read_log_tail(a.log_file, n=20)
    try:
        with open(a.meta_file, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
    except OSError:
        pass
    return 0


def cmd_segworker(a) -> int:
    """分片引擎的后台工作进程（由 start 以 detach 方式拉起，stdout 已重定向到 .log）。"""
    mp4_like = os.path.splitext(a.out)[1].lower() in MP4_LIKE
    return run_seg_download(a.url, a.out, a.referer, a.user_agent,
                            a.concurrency, a.max_size_mb, a.progress_file,
                            mp4_like=mp4_like)


def main() -> int:
    p = argparse.ArgumentParser(description="下载 m3u8/mp4 并提供可见进度")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("start", aliases=["run"])
    s.add_argument("--url", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--duration", type=float, default=0, help="ffprobe 探到的秒数，用于算百分比和安全帽")
    s.add_argument("--referer", default="")
    s.add_argument("--user-agent", default=DEFAULT_UA)
    s.add_argument("--read-timeout", type=int, default=30, help="网络读写卡死自动退（秒）")
    s.add_argument("--max-size-mb", type=int, default=0, help="输出大小硬上限，0=不限")
    s.add_argument("--max-wall", type=int, default=0, help="墙钟上限（秒），0=按时长推算")
    s.add_argument("--max-concurrent", type=int, default=2)
    s.add_argument("--est-size-mb", type=int, default=0, help="预估大小；由 bit_rate×时长 最准")
    s.add_argument("--assumed-kbps", type=int, default=5000)
    s.add_argument("--min-free-mb", type=int, default=5120, help="下完后至少保留，0=关预检")
    s.add_argument("--skip-disk-check", action="store_true")
    s.add_argument("--no-watchdog", action="store_true")
    s.add_argument("--stall-after", type=int, default=120, help="run 模式无进度上限（秒），0=关闭")
    s.add_argument("--no-resolve", action="store_true",
                   help="跳过 HLS master→分片清单自动下钻（默认开启；已是分片清单时 "
                        "不会误伤，仅在解析失败时回退原 URL）")
    s.add_argument("--engine", choices=["auto", "ffmpeg", "seg"], default="auto",
                   help="下载引擎：auto=HLS VOD 走并发分片引擎（快数倍、断点续传），"
                        "直播/BYTERANGE/非 HLS 回退 ffmpeg 串行")
    s.add_argument("--seg-concurrency", type=int, default=16,
                   help="分片引擎并发连接数（钳在 1–32；弱机/HDD 建议 4–8）")

    t = sub.add_parser("status")
    t.add_argument("--out", required=True)
    t.add_argument("--duration", type=float, default=0)
    t.add_argument("--json", action="store_true")

    n = sub.add_parser("wait-status")
    n.add_argument("--out", required=True)
    n.add_argument("--duration", type=float, default=0)
    n.add_argument("--notify-after", type=int, required=True,
                   help="正常运行多久后返回一次进度（秒）")
    n.add_argument("--poll-seconds", type=int, default=15,
                   help="内部静默检查完成/失败状态的间隔（秒）")
    n.add_argument("--stall-after", type=int, default=120,
                   help="进度文件无更新多久后立即返回 stalled（秒，默认 120）")
    n.add_argument("--max-wait-seconds", type=int, default=540,
                   help="单次命令最多静默等待多久（秒，默认 540，低于 Bash 10 分钟上限）")

    k = sub.add_parser("stop")
    k.add_argument("--out", required=True)

    w = sub.add_parser("_watchdog")
    w.add_argument("--pid", type=int, required=True)
    w.add_argument("--proc-name", default="ffmpeg")
    w.add_argument("--pid-file", required=True)
    w.add_argument("--max-wall", type=int, required=True)

    e = sub.add_parser("_exitwatcher")
    e.add_argument("--pid", type=int, required=True)
    e.add_argument("--proc-name", default="ffmpeg")
    e.add_argument("--meta-file", required=True)
    e.add_argument("--log-file", required=True)

    g = sub.add_parser("_segworker")
    g.add_argument("--url", required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--referer", default="")
    g.add_argument("--user-agent", default=DEFAULT_UA)
    g.add_argument("--concurrency", type=int, default=8)
    g.add_argument("--max-size-mb", type=int, default=0)
    g.add_argument("--progress-file", required=True)

    a = p.parse_args()
    return {"start": cmd_start, "run": cmd_start, "status": cmd_status,
            "wait-status": cmd_wait_status,
            "stop": cmd_stop, "_watchdog": cmd_watchdog,
            "_exitwatcher": cmd_exitwatcher,
            "_segworker": cmd_segworker}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
