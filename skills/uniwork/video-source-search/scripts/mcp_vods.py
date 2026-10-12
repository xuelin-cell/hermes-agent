#!/usr/bin/env python3
"""mcp-vods 片源查询客户端（跨平台）。

    python3 scripts/mcp_vods.py search 狂飙 [--page 1] [--timeout 120]
    python3 scripts/mcp_vods.py detail --id 123 --source xxx [--episode -1]
    python3 scripts/mcp_vods.py doctor
    python3 scripts/mcp_vods.py --diagnostics doctor

search 和 detail 走同一条 npx → mcporter → uvx → mcp-vods 调用链，只有工具名和参数
不同，所以合成一个文件——分开写会让预热/自愈/诊断逻辑各存一份，改一处得记得改两处。

内置四件事，agent 不用自己操心：
  1. 冷缓存预热 —— 首次跑先把 ~89 个包的环境建好再发 call，否则依赖下载跑输 MCP
     握手超时，报出来像"连接失败"，其实只是没下完。
  2. 串行锁 —— 同时起多个 uvx mcp-vods 会抢 uv 缓存，返回空结果或 Connection closed。
  3. 失败自愈 —— 清预热标记、重建环境、重试一次。
  4. 分层诊断 —— 失败后轻量探测，定位是 Node 层还是 uv 层。
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True   # 别在用户目录留 __pycache__（这里常是同步盘）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import FileLock, cache_dir, require, run_hidden, which  # noqa: E402

# 钉死实测可用版本：uvx 按版本号确定性复用缓存 env，不会因上游发新版而重新下载。
# 升级时改这里（或用环境变量覆盖），并重新验证一遍。
MCPORTER_SPEC = os.environ.get("MCPORTER_SPEC", "mcporter@0.12.3")
MCP_VODS_SPEC = os.environ.get("MCP_VODS_SPEC", "mcp-vods@0.1.9")

# 国内镜像默认开：主场景在国内，首次 89 包依赖直连 PyPI/npm 必慢易超时。
# 海外环境加 --no-cn-mirror，或设 VODS_NO_CN_MIRROR=1。
CN_MIRROR = {
    "npm_config_registry": "https://registry.npmmirror.com",
    "UV_DEFAULT_INDEX": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "UV_INDEX_URL": "https://pypi.tuna.tsinghua.edu.cn/simple",  # 兼容老版 uv
    "PIP_INDEX_URL": "https://pypi.tuna.tsinghua.edu.cn/simple",
}


def build_env(no_cn_mirror: bool) -> dict:
    env = dict(os.environ)
    if not no_cn_mirror and not os.environ.get("VODS_NO_CN_MIRROR"):
        env.update(CN_MIRROR)
    # 缓存不完整时 --prefer-offline 会放大问题，显式关掉防机器的 npmrc 里开了它
    env["npm_config_prefer_offline"] = "false"
    env["NPM_CONFIG_PREFER_OFFLINE"] = "false"
    return env


def _mirror_fast(url: str, timeout: float = 5.0, min_bytes: int = 1 << 18) -> bool:
    """timeout 内拉完 min_bytes（或整个更小的文件）才算镜像健康。

    必须测真实制品文件的吞吐，不能只 ping 元数据页：实测有网络对清华镜像的
    simple 索引页 1.4 秒就返回，真正下 wheel（packages 路径）却超时 127 秒——
    按元数据页判断会把坏镜像判成好的。
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vods-preflight"})
        deadline = time.time() + timeout
        got = 0
        with urllib.request.urlopen(req, timeout=timeout) as r:
            while got < min_bytes:
                chunk = r.read(1 << 15)
                if not chunk:
                    break                 # 文件本身更小且已读完：健康
                got += len(chunk)
                if time.time() > deadline:
                    return False
        return True
    except Exception:
        return False


# 探针指向真实制品：npm 是 mcporter 自己的 tarball；PyPI 是一个哈希寻址（永不变）
# 的 ~2MB wheel——必须够大才能量出吞吐，小文件在坏网络上也可能侥幸下完，
# 实测就发生过"35KB 探针通过、随后大文件全部卡死"的假阳性。
def _npm_probe_url() -> str:
    name, _, ver = MCPORTER_SPEC.partition("@")
    if ver:
        return f"https://registry.npmmirror.com/{name}/-/{name}-{ver}.tgz"
    return f"https://registry.npmmirror.com/{name}"


_PYPI_PROBE_URL = ("https://pypi.tuna.tsinghua.edu.cn/packages/8d/f0/"
                   "49129b27c43396581a635d8710dae54a791b17dfc50c70164866bbf865e3/"
                   "pydantic_core-2.27.2-cp312-cp312-manylinux_2_17_x86_64."
                   "manylinux2014_x86_64.whl")


def pick_install_env(no_cn_mirror: bool) -> tuple[dict, dict]:
    """装依赖前先给镜像做约 5 秒体检，npm 层和 Python 层独立取舍。

    返回 (环境, 取舍结论)。结论由 warmup 成功后写进标记文件，供 call_env 在
    每次调用时沿用——uvx 即便命中缓存环境，启动时也会向 index 做校验，调用
    环境和预热环境不一致会让"预热成功、调用超时"这种最迷惑的故障复现。

    镜像不是无条件更快：实测有网络对清华镜像单个 wheel 超时 127 秒（uvx 空跑
    9 分半告败），官方源反而 1 秒。装依赖动辄几十 MB，方向选错代价是几分钟到
    彻底失败；花几秒探测，把"哪边通走哪边"变成代码决定而不是赌默认值。
    只在冷启动/自愈路径调用——热路径不装依赖，不付这几秒。
    """
    env = build_env(no_cn_mirror=True)   # 先拿无镜像的干净底
    choice = {"npm_mirror": False, "pypi_mirror": False}
    if no_cn_mirror or os.environ.get("VODS_NO_CN_MIRROR"):
        return env, choice
    if _mirror_fast(_npm_probe_url()):
        choice["npm_mirror"] = True
        env["npm_config_registry"] = CN_MIRROR["npm_config_registry"]
    else:
        print("npm 镜像不可达或过慢，npm 层改用官方源。", flush=True)
    if _mirror_fast(_PYPI_PROBE_URL, min_bytes=1 << 20):
        choice["pypi_mirror"] = True
        for k in ("UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL"):
            env[k] = CN_MIRROR[k]
    else:
        print("PyPI 镜像不可达或过慢，Python 层改用官方源。", flush=True)
    return env, choice


def call_env(no_cn_mirror: bool) -> dict:
    """调用期环境：镜像取舍沿用预热时体检并写进标记的结论。

    这是一次真实事故的修复：预热已正确切到官方源并建好环境，但调用环境仍
    无条件带镜像，uvx 启动时向卡死的镜像 index 做校验，60 秒 MCP 握手超时——
    表现成"预热成功、调用永远超时"。标记是旧格式/缺失时退回镜像默认。
    """
    env = build_env(no_cn_mirror=True)
    if no_cn_mirror or os.environ.get("VODS_NO_CN_MIRROR"):
        return env
    try:
        with open(marker_path(), encoding="utf-8") as f:
            choice = json.load(f)
    except Exception:
        return build_env(False)   # 旧格式标记/尚未预热：维持原默认（镜像开）
    if choice.get("npm_mirror"):
        env["npm_config_registry"] = CN_MIRROR["npm_config_registry"]
    if choice.get("pypi_mirror"):
        for k in ("UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL"):
            env[k] = CN_MIRROR[k]
    return env


def marker_path() -> str:
    key = f"warmup_{MCPORTER_SPEC}_{MCP_VODS_SPEC}.ok"
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in key)
    return os.path.join(cache_dir(), safe)


def cold_start_notice():
    """冷启动前先把话说清楚，而且必须立刻 flush。

    冷启动要装 ~89 个包，可能远超 agent Bash 工具的默认 120s 超时；命令被工具掐断
    时，agent 只看得到已经打印出来的内容。没有这段提示，它看到的就是一次"超时"，
    很容易判定片源引擎不可用而直接转兜底——这正是本 skill 最不想发生的误判。
    """
    print("=" * 60, flush=True)
    print("首次使用，需要下载依赖并构建片源引擎环境（约 1–5 分钟）。", flush=True)
    print("给 agent 的提示：这条命令可能超过工具默认超时。若被超时打断，"
          "这是正常冷启动，", flush=True)
    print("请用更长超时（建议 600000ms）重跑本命令，**不要**判定片源引擎不可用。"
          , flush=True)
    print("依赖会断点续装，重跑不会从零开始。", flush=True)
    print("=" * 60, flush=True)


def warmup(env: dict, choice: dict | None = None) -> bool:
    print("首次使用：正在初始化片源引擎（下载依赖并构建环境，约 1 分钟，"
          "请把这句转述给用户并稍候）…", flush=True)
    npx, uvx = require("npx"), require("uvx")

    def _run(argv) -> bool:
        try:
            # 300s：健康源冷装 1–2 分钟足够；给 900 只会让坏镜像多卡 10 分钟
            # 才轮到自愈换源
            return run_hidden(argv, env=env, capture_output=True, text=True,
                              timeout=300).returncode == 0
        except Exception:
            return False

    # npm 层和 uv 层各下各的缓存、互不相干，并行装：冷启动从两者之和缩到较大值
    with ThreadPoolExecutor(max_workers=2) as ex:
        ok = all(ex.map(_run, (
            [npx, "-y", "--package", MCPORTER_SPEC, "--", "mcporter", "--version"],
            [uvx, MCP_VODS_SPEC, "--help"],
        )))
    if ok:
        # 标记里存镜像取舍结论，call_env 每次调用沿用同一环境
        with open(marker_path(), "w", encoding="utf-8") as f:
            json.dump(choice or {}, f)
        print("片源引擎初始化完成。", flush=True)
    else:
        print("片源引擎初始化未成功（网络/镜像问题?），将继续尝试调用。", flush=True)
    return ok


def diagnostics(full: bool, env: dict):
    """轻量诊断分层定位：mcporter 挂 = Node/npm 层坏；uvx 挂 = uv 没装或不在 PATH。
    含 mcp-vods 的第三层会触发 ~89 包安装，较重，只在 --diagnostics 时跑。"""
    print("== mcp-vods diagnostics ==", flush=True)
    npx, uvx = which("npx"), which("uvx")
    print(f"[npx] {npx or '未找到（Node.js 未安装或不在 PATH）'}")
    print(f"[uvx] {uvx or '未找到（uv 未安装或不在 PATH）'}")
    if npx:
        print("[mcporter --version]", flush=True)
        run_hidden([npx, "-y", "--package", MCPORTER_SPEC, "--", "mcporter", "--version"],
                       env=env, timeout=600)
    if uvx:
        print("[uvx --version]", flush=True)
        run_hidden([uvx, "--version"], env=env, timeout=120)
        if full:
            print(f"[uvx {MCP_VODS_SPEC} --help]", flush=True)
            run_hidden([uvx, MCP_VODS_SPEC, "--help"], env=env, timeout=900)
        else:
            print("[mcp-vods] 已跳过（加 --diagnostics 才做全量探测，"
                  "避免失败路径上重装依赖拖慢弱机）")


# ── 结果瘦身与预排序 ──────────────────────────────────────────────────────
#
# 原始返回一页就有 ~1.8 万 token，实测其中封面图 URL 占 32%、简介占 11%——这两列
# 在排序里从来用不到（没人靠一个 jpg 地址判断片源好坏），却要占掉四成上下文。
# 同时热门片名会混进几十条蹭名字的短剧（搜"狂飙"会返回"狂飙奶爸""末日狂飙"），
# 靠模型逐行读文字规则去筛，既费 token 又容易选错，所以在这里先按片名相关度排好。

DROP_COLUMNS = ("poster", "intro", "desc")


def _norm(s: str) -> str:
    """归一化片名：去掉空格和常见标点，全角转半角，便于精确比对。"""
    s = s.strip().lower()
    return re.sub(r"[\s:：·・\-—_，,。.!！?？'\"“”‘’()（）\[\]【】]", "", s)


def _relevance(title: str, keyword: str) -> int:
    t, k = _norm(title), _norm(keyword)
    if not k:
        return 0
    if t == k:
        return 100          # 精确命中：2023 版《狂飙》这类
    if t.startswith(k) or t.endswith(k):
        return 60           # "狂飙之九龙棋局"——同系列或蹭名字，次选
    if k in t:
        return 40           # "职场狂飙：从一键退票开始逆袭"——基本是蹭名字
    return 0


def _row_bonus(row: list[str], year: int, episodes: int) -> int:
    """年份/集数命中加权。热门片名的同名短剧靠片名分不开（"狂飙"精确匹配也可能
    撞上重名），年份（2023）和集数（39）是最硬的两个复核信号，用户已知时让它们
    直接参与排序，而不是靠模型逐行肉眼比对。"""
    cells = row[1:]   # 跳过 id 列：纯数字 id 很容易撞出个"2023"
    b = 0
    if year and any(re.search(rf"(?<!\d){year}(?!\d)", c) for c in cells):
        b += 15
    if episodes:
        ep = str(episodes)
        if any(c == ep or f"{ep}集" in c for c in cells):
            b += 10
    return b


def shrink_results(text: str, keyword: str, max_rows: int, keep_intro: bool,
                   year: int = 0, episodes: int = 0) -> str:
    """把 mcp-vods 的 CSV 结果瘦身 + 按相关度排序。

    保守策略：只有确实识别出那张带 poster 列的表头才动手，其它输出（detail 的
    分集列表、报错、分页脚注）原样透传。格式一旦变化，最坏情况是不生效，而不是
    把结果吃掉。
    """
    lines = text.splitlines()
    hi = next((i for i, l in enumerate(lines)
               if l.startswith("id,") and "poster" in l), None)
    if hi is None:
        return text

    header = next(csv.reader([lines[hi]]))
    drop = {header.index(c) for c in DROP_COLUMNS if c in header}
    if keep_intro:
        drop = {header.index(c) for c in ("poster",) if c in header}
    try:
        ti = header.index("title")
    except ValueError:
        return text

    kept, passthrough, dropped_malformed = [], [], 0
    for line in lines[hi + 1:]:
        if not line.strip():
            continue
        if not re.match(r"^\d+,", line):      # 分页脚注等非数据行
            passthrough.append(line)
            continue
        row = next(csv.reader([line]), [])
        if len(row) != len(header):
            dropped_malformed += 1
            passthrough.append(line)          # 解析不了就原样留着，不吞数据
            continue
        kept.append(row)

    kept.sort(key=lambda r: -(_relevance(r[ti], keyword)
                              + _row_bonus(r, year, episodes)))   # 稳定排序，同分保持原序

    total = len(kept)
    shown = kept if max_rows <= 0 else kept[:max_rows]
    slim_header = [c for i, c in enumerate(header) if i not in drop]

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(slim_header)
    for r in shown:
        w.writerow([c for i, c in enumerate(r) if i not in drop])

    out = [*lines[:hi], buf.getvalue().rstrip("\n")]
    exact = sum(1 for r in shown if _relevance(r[ti], keyword) == 100)
    sort_desc = "片名相关度"
    weighted = [w_ for w_, v in (("年份", year), ("集数", episodes)) if v]
    if weighted:
        sort_desc += f"（{'/'.join(weighted)}命中加权）"
    note = [f"# 已按{sort_desc}排序；精确匹配 {exact} 条，本页共 {total} 条"]
    if exact == 0:
        note.append("# 无精确匹配：结果可能全是同名/蹭名字条目，先核对片名写法、年份、集数")
    if total > len(shown):
        # 不做静默截断：省了多少必须说出来，否则会被当成"就这么多"
        note.append(f"# 已省略相关度最低的 {total - len(shown)} 条"
                    f"（--max-rows {max_rows}，要全部用 --max-rows 0）")
    if not keep_intro:
        note.append("# 已省略 poster/intro/desc 列以节省上下文（--with-intro 可保留）")
    out += note + passthrough
    return "\n".join(out)


def call_tool(tool: str, params: list[str], timeout_s: int, env: dict,
              post=None) -> int:
    npx = require("npx")
    # 规范形式：npx -y --package mcporter -- mcporter call ...
    # 绝不能写成 npx -y -- call ...（丢了 mcporter，npm 会去下一个叫 call 的包，
    # 报 could not determine executable to run —— 看着像 uvx 环境问题，其实是命令拼错）。
    # 这也正是把命令封进脚本的原因：手写容易漏参数。
    argv = [
        npx, "-y", "--package", MCPORTER_SPEC, "--",
        "mcporter", "call",
        "--stdio", f"uvx {MCP_VODS_SPEC}",
        tool, *params,
        "--timeout", str(timeout_s * 1000),
    ]
    try:
        # 比调用层超时多留 30s 兜底硬杀
        r = run_hidden(argv, env=env, timeout=timeout_s + 30,
                       capture_output=True, text=True)
    except subprocess.TimeoutExpired:
        print(f"片源引擎调用超时（{timeout_s}s）。超时只代表请求被截断，"
              f"不代表没有资源。", file=sys.stderr)
        return 124
    out = r.stdout or ""
    if r.returncode == 0 and post:
        try:
            out = post(out)
        except Exception as e:   # 瘦身只是优化，失败绝不能连累结果
            print(f"# 结果后处理失败（{e}），输出原始内容", file=sys.stderr)
    if out:
        print(out)
    if r.stderr:
        print(r.stderr, file=sys.stderr, end="")
    return r.returncode


def run(tool: str, params: list[str], args, post=None) -> int:
    marker = marker_path()
    # uv 缓存竞争是进程级的，锁必须包住预热和调用全程
    with FileLock(os.path.join(cache_dir(), "mcp_vods.lock"), timeout=args.timeout + 120):
        if not os.path.exists(marker):
            cold_start_notice()
            env, choice = pick_install_env(args.no_cn_mirror)
            warmup(env, choice)
        # 调用环境从标记读镜像取舍，和预热保持一致（不一致会复现
        # "预热成功、调用超时"的事故）
        code = call_tool(tool, params, args.timeout, call_env(args.no_cn_mirror), post)
        if code != 0:
            # 环境可能损坏或被清了缓存：清标记重建（重新体检镜像），再试一次
            try:
                os.remove(marker)
            except OSError:
                pass
            print("片源引擎调用失败，正在自动修复环境并重试一次…", flush=True)
            env, choice = pick_install_env(args.no_cn_mirror)
            warmup(env, choice)
            code = call_tool(tool, params, args.timeout, call_env(args.no_cn_mirror), post)

    if args.diagnostics:
        diagnostics(True, call_env(args.no_cn_mirror))
    elif code != 0:
        diagnostics(False, call_env(args.no_cn_mirror))
        print("\n提示：mcp-vods 已重试仍失败，别再反复重试；按 SKILL.md 的兜底顺序"
              "换搜索引擎兜底。对用户只说「正在用网络搜索为你查找片源」。",
              file=sys.stderr)
    return code


def main() -> int:
    p = argparse.ArgumentParser(description="mcp-vods 片源查询（跨平台）")
    p.add_argument("--timeout", type=int, default=None,
                   help="单次调用超时（秒）。常规 120，首次冷启动可给 600。可放子命令后覆盖。")
    p.add_argument("--no-cn-mirror", action="store_true", help="海外环境：关掉国内镜像")
    p.add_argument("--diagnostics", action="store_true", help="强制做三层全量探测")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="按片名搜索")
    s.add_argument("keyword", help="干净片名，不要加 全集/电视剧/年份/m3u8")
    s.add_argument("--page", type=int, default=1)
    s.add_argument("--max-rows", type=int, default=30,
                   help="最多输出多少行（按相关度排序后取前 N），0=不限")
    s.add_argument("--year", type=int, default=0,
                   help="已知年份（如 2023）：命中的候选排序加权。别塞进关键词")
    s.add_argument("--episodes", type=int, default=0,
                   help="已知总集数（如 39）：命中的候选排序加权。别塞进关键词")
    s.add_argument("--with-intro", action="store_true",
                   help="保留 intro/desc 简介列（默认省略以节省上下文）")
    s.add_argument("--raw", action="store_true", help="原样输出，不瘦身不排序")
    s.add_argument("--timeout", type=int, dest="sub_timeout", default=None,
                   help="覆盖全局超时（秒）；不填沿用全局 --timeout")

    d = sub.add_parser("detail", help="取详情；连续剧用 --episode -1 拿全集")
    d.add_argument("--id", required=True)
    d.add_argument("--source", required=True)
    d.add_argument("--episode", type=int, default=-1)
    d.add_argument("--timeout", type=int, dest="sub_timeout", default=None,
                   help="覆盖全局超时（秒）；不填沿用全局 --timeout")

    sub.add_parser("doctor", help="只跑环境诊断，不查片源")
    sub.add_parser("warmup", help="只构建环境不查片源；仅用于提前铺机器。日常不用跑——"
                                  "search 会自动预热，首搜直接给大超时即可")

    args = p.parse_args()
    # --timeout 可放子命令前（全局 timeout）或后（sub_timeout 覆盖）；都不传回退 120。
    # doctor/warmup 没有子命令级 timeout 参数，必须安全读取。
    args.timeout = getattr(args, "sub_timeout", None) or args.timeout or 120

    if args.cmd == "search":
        post = None if args.raw else (
            lambda t: shrink_results(t, args.keyword, args.max_rows, args.with_intro,
                                     args.year, args.episodes))
        return run("vods_search", [f"keyword={args.keyword}", f"page={args.page}"],
                   args, post)
    if args.cmd == "detail":
        return run("vods_detail",
                   [f"id={args.id}", f"source={args.source}", f"episode={args.episode}"],
                   args)
    if args.cmd == "warmup":
        if os.path.exists(marker_path()):
            print("片源引擎环境已就绪，无需预热。")
            return 0
        cold_start_notice()
        env, choice = pick_install_env(args.no_cn_mirror)
        return 0 if warmup(env, choice) else 1
    diagnostics(True, build_env(args.no_cn_mirror))
    return 0


if __name__ == "__main__":
    sys.exit(main())
