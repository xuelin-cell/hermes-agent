"""构建基础镜像前，把它要从外网下载的大文件先在部署机上备好，构建过程不再连 GitHub / Playwright 的 CDN。

部署机连不上 GitHub 和 Playwright 的 CDN（10-15 实测），而根目录 Dockerfile 里：
  - pm 要下 uv、Python、Chromium、node、npm、ffmpeg、ripgrep（pm/lock.json 按 sha256 锁定）；
    pm 只在出错时才退到 hermes 的公开镜像，慢而不断就一直等。
  - s6-overlay 的三个包直接从 GitHub 下（版本和 sha256 写在 Dockerfile 的 ARG 里）。
pm 的文件按 sha256 依次试 hermes 的公开镜像、npmmirror、原地址；s6-overlay 的三个包公开镜像上没有，
放在仓库里（deploy/hermes-mt/vendor/s6-overlay/v<版本>/，随代码一起拉到部署机），先取仓库里的。
每个文件都核对 sha256，已经备好且对得上的不重下：
  <种子目录>/pm/fetch-<sha256>/<文件名>  —— pm 见到这里有一个 sha256 对得上的文件就不再下载
  <种子目录>/s6/v<版本>/<文件名>          —— 构建时 S6_OVERLAY_BASE_URL 指到 file:///tmp/s6-seed
再生成 <种子目录>/Dockerfile：根目录 Dockerfile 加两行 COPY（上游文件本身不改）。deploy.sh base 用它构建：
  docker build -f <种子目录>/Dockerfile --build-context seed=<种子目录> \\
      --build-arg S6_OVERLAY_BASE_URL=file:///tmp/s6-seed -t <标签> <仓库根>

用法: python3 base_seed.py <仓库根> <种子目录>
部署机是 CentOS 7 的 Python 3.6：只用标准库和 3.6 有的写法；下载交给 curl（断点续传、重试、太慢就换来源）。
"""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys

# 根目录 Dockerfile 里 pm 装的包（ensure 那一行）加上它们依赖的 python、node。漏了的 pm 会照常自己下。
PM_PACKAGES = ("uv", "python", "chromium", "node", "npm", "ffmpeg", "ripgrep")

S6_FILES = (("s6-overlay-noarch.tar.xz", "S6_OVERLAY_NOARCH_SHA256"),
            ("s6-overlay-x86_64.tar.xz", "S6_OVERLAY_X86_64_SHA256"),
            ("s6-overlay-symlinks-noarch.tar.xz", "S6_OVERLAY_SYMLINKS_SHA256"))

PAYLOAD_COPY = "COPY scripts/bundles/payload.py scripts/bundles/payload.py\n"
S6_LAST_ARG = "ARG S6_OVERLAY_SYMLINKS_SHA256="

# 部署机连 deb.debian.org 只有十几到几十 KB/s（10-29 实测：装 build-essential 一个多小时只下了 48 个包），
# 每个 Debian 阶段开头换成国内镜像，和 Dockerfile.cube 的做法一样；安全更新源同一个主机名，一起换。
# 要用官方源就传 --build-arg APT_MIRROR=（留空）。
DEBIAN_FROM = "FROM debian:"
APT_MIRROR_LINES = (
    "ARG APT_MIRROR=mirrors.aliyun.com\n",
    'RUN if [ -n "$APT_MIRROR" ]; then \\\n'
    "        for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \\\n"
    '            if [ -f "$f" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g" "$f"; fi; \\\n'
    "        done; \\\n"
    "    fi\n",
)


def say(msg):
    print("  " + msg, flush=True)


def die(msg):
    print("  [停止] " + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def npmmirror(url):
    """同一个文件在 npmmirror 上的地址（目录结构对得上的几类），没有就是 None。"""
    rules = (
        ("https://nodejs.org/dist/", "https://cdn.npmmirror.com/binaries/node/"),
        ("https://registry.npmjs.org/", "https://registry.npmmirror.com/"),
        ("https://cdn.playwright.dev/builds/cft/", "https://cdn.npmmirror.com/binaries/chrome-for-testing/"),
        ("https://github.com/astral-sh/python-build-standalone/releases/download/",
         "https://registry.npmmirror.com/-/binary/python-build-standalone/"),
    )
    for prefix, mirror in rules:
        if url.startswith(prefix):
            return mirror + url[len(prefix):]
    return None


def derive_dockerfile(dockerfile):
    """根目录 Dockerfile 加两行 COPY：pm 的预置文件放进它的下载目录，s6 的包放到 /tmp/s6-seed；
    每个 FROM debian: 阶段开头换 apt 镜像源。COPY 的插入点各只能出现一次、Debian 阶段至少一个，
    否则说明上游改了结构，要人来看。"""
    lines = dockerfile.splitlines(True)
    if dockerfile.count(PAYLOAD_COPY) != 1 or sum(1 for line in lines if line.startswith(S6_LAST_ARG)) != 1:
        raise ValueError("根目录 Dockerfile 的结构变了，找不到插入预置文件的位置")
    if not any(line.startswith(DEBIAN_FROM) for line in lines):
        raise ValueError("根目录 Dockerfile 的结构变了，找不到换 apt 镜像源的 Debian 阶段")
    out = ["# 由 deploy/hermes-mt/scripts/base_seed.py 从根目录 Dockerfile 生成，别手改。\n"]
    for line in lines:
        out.append(line)
        if line.startswith(DEBIAN_FROM):
            out.extend(APT_MIRROR_LINES)
        elif line == PAYLOAD_COPY:
            out.append("COPY --from=seed pm/ /opt/hermes/tools/\n")
        elif line.startswith(S6_LAST_ARG):
            out.append("COPY --from=seed s6/ /tmp/s6-seed/\n")
    return "".join(out)


def fetch(dest, sha, sources, hint=""):
    """按顺序试 sources（本机文件或网址），直到 dest 是 sha256 对得上的文件。"""
    if os.path.isfile(dest) and sha256_of(dest) == sha:
        say("已备好 " + os.path.basename(dest))
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # 各来源是按 sha256 对上的同一个文件，上一个来源下了一半的，下一个接着续。
    part = dest + ".part"
    for url in sources:
        if os.path.isfile(part) and sha256_of(part) == sha:
            break
        if not url.startswith("https://"):
            if os.path.isfile(url) and sha256_of(url) == sha:
                say("取仓库里的 " + os.path.basename(dest))
                shutil.copyfile(url, part)
                break
            continue
        say("下载 " + os.path.basename(dest) + " ← " + url)
        # -C - 续传；低于 2KB/s 持续 60 秒就放弃这个来源，换下一个。
        rc = subprocess.call(["curl", "-fL", "--retry", "5", "--retry-delay", "3", "--connect-timeout", "15",
                              "--speed-limit", "2048", "--speed-time", "60", "-C", "-", "-sS", "-o", part, url])
        if rc == 0 and sha256_of(part) == sha:
            break
        if (rc == 0 or rc in (33, 36)) and os.path.exists(part):  # 内容不对，或这个来源续不上：残片作废
            say("这个来源没拿到对的文件（curl 退出码 %d），换下一个" % rc)
            os.remove(part)
    if os.path.isfile(part) and sha256_of(part) == sha:
        os.replace(part, dest)
        return
    die(os.path.basename(dest) + " 所有来源都没下成（sha256 " + sha + "）" + ("。" + hint if hint else ""))


def main():
    if len(sys.argv) != 3:
        die("用法: python3 base_seed.py <仓库根> <种子目录>")
    repo, seed = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    if platform.machine() not in ("x86_64", "AMD64"):
        die("只按 x86_64 备文件，这台是 " + platform.machine())

    with open(os.path.join(repo, "pm", "lock.json"), encoding="utf-8") as f:
        lock = json.load(f)
    with open(os.path.join(repo, "pm", "artifact-mirror.json"), encoding="utf-8") as f:
        layout = json.load(f)
    mirror = layout["origin"] + "/" + layout["prefix"]
    with open(os.path.join(repo, "Dockerfile"), encoding="utf-8") as f:
        dockerfile = f.read()
    try:
        derived = derive_dockerfile(dockerfile)  # 先看插入点在不在，再花时间下载
    except ValueError as exc:
        die(str(exc))

    for name in PM_PACKAGES:
        artifacts = lock["packages"][name]["artifacts"]
        art = artifacts.get("linux-x64") or artifacts.get("any")
        if not art:
            die("pm/lock.json 里 " + name + " 没有 linux-x64 的文件")
        url, sha = art["url"], art["sha256"]
        sources = [mirror + sha] + [u for u in (npmmirror(url), url) if u]
        fetch(os.path.join(seed, "pm", "fetch-" + sha, url.rsplit("/", 1)[-1]), sha, sources)

    def arg(key):
        m = re.search(r"^ARG " + key + r"=(\S+)$", dockerfile, re.M)
        if not m:
            die("Dockerfile 里找不到 ARG " + key)
        return m.group(1)

    version, base = arg("S6_OVERLAY_VERSION"), arg("S6_OVERLAY_BASE_URL")
    vendor = os.path.join(repo, "deploy", "hermes-mt", "vendor", "s6-overlay", "v" + version)
    for filename, key in S6_FILES:
        sha = arg(key)
        fetch(os.path.join(seed, "s6", "v" + version, filename), sha,
              [os.path.join(vendor, filename), mirror + sha, base + "/v" + version + "/" + filename],
              hint="上游换了 s6-overlay 版本的话，把新版的三个包放进 " + vendor + " 再提交")

    with open(os.path.join(seed, "Dockerfile"), "w", encoding="utf-8", newline="\n") as f:
        f.write(derived)
    say("预置齐了：" + seed)


if __name__ == "__main__":
    main()
