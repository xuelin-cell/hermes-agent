---
name: video-source-search
description: "搜索影视片源、提取全集列表并验证或下载播放链接."
version: "1.0.0"
author: "UniWork"
license: Proprietary
platforms: [linux, macos, windows]
tags: [影视, 搜索, 下载]
---

# 影视片源搜索 VOD

## 🚫 第 0 条铁律：技能目录只读，产物写用户工作目录

本文开头那行 `Base directory for this skill: <路径>` 就是**技能根**，下文写作 `<技能根>`。

- **绝不 `cd` 进技能目录**，调技能脚本一律用绝对路径：`python <技能根>/scripts/xxx.py`。下文命令都这么写，照抄时别省掉 `<技能根>/`。
- **所有产物写用户工作目录**：下载的视频（`--out`）、日志、临时清单，一个都不进技能目录。视频动辄几百 MB，写进技能安装目录会被技能更新连锅端。
- 开工前 `pwd` 确认自己在哪；下载前执行 `python -c "import os; print(os.path.abspath(r'{文件名}.mp4'))"` 得到当前执行环境认可的绝对路径，`--out`、后台登记和最终附件交付都使用这一条路径。


## Quick Workflow

1. 首次使用先跑环境检查（见 Setup）。
2. 提取干净片名和类型：`tv` / `movie` / `unknown`。
3. `mcp_vods.py search` 搜索；连续剧再用 `detail --episode -1` 取全集。见 [mcp-vods](references/mcp-vods.md)。
4. 连续 empty/timeout 就换兜底搜索，别在 mcp-vods 上反复重试。见 [fallback-search](references/fallback-search.md)。
5. 按 [output-rules](references/output-rules.md) 过滤付费墙、聚合页、非影视站、错误片名。
6. `probe_media.py` 验证时长、清晰度、可播性。见 [media-verify](references/media-verify.md)。
7. 要下载就 `download_media.py start`；启动成功后立即调用 `VideoDownloadJob` 登记后台监控，然后结束当前轮次。见 [download-progress](references/download-progress.md)。
8. 输出结果，连续剧优先给全集链表。
9.下载如果一直进度为0证明这个片源下载不了，这个时候你对这个视频任务重新换源再重新下载。

## Setup

脚本是 Python 3（只用标准库），Windows / macOS / Linux 通用。命令统一写 `python`。

```bash
python <技能根>/scripts/preflight.py --json              # 体检：node/npx、uv/uvx、ffmpeg/ffprobe
python <技能根>/scripts/preflight.py --install          # 缺什么装什么
```

ffmpeg/ffprobe 缺失：**只跑 `python <技能根>/scripts/preflight.py --install` 这一条命令**，失败就原样重跑——脚本幂等自愈（断点续传、魔数校验自动丢弃 HTML 错误页、损坏文件自动重装），不需要任何手动准备或清理。平台差异脚本自己处理：Windows 走 OSS exe 直连，Linux（含无 root 的 sandbox）从国内镜像装静态构建到 `~/.local/bin` 全程免 root，macOS 走 brew。

**工具路径不用你操心**：preflight 验真后把 ffmpeg/ffprobe/npx/uvx 的绝对路径写进 `tools.json`，probe/download/搜索脚本共用同一套解析（注册表 → PATH → 各平台已知安装位置），**不依赖 PATH**，所以「preflight 说 ✅、脚本说找不到」这种矛盾不会再出现。真缺了脚本会自己调 preflight --install 装完续跑，你什么都不用做。

以下手搓行为**一律禁止**——实测每一条都翻过车：

- ❌ `where` / `Get-Command` / `shutil.which` 自己找 ffmpeg 路径：agent 子进程 PATH 和用户终端不同，找不到是正常的，**不代表没装**，脚本内部已经查过更多位置。
- ❌ 看到「找不到 ffprobe」就重跑 preflight 或换 winget/PowerShell 重装：脚本已经自动装过一次了，再来一遍只是浪费几分钟。报错文案里写了唯一该跑的命令，照做即可。
- ❌ `sudo` / `apt-get install`：sandbox 无 root，只会卡密码或 Permission denied。
- ❌ 自己 curl GitHub/ghproxy/OSS 拼链接下"静态包"：常拿到 HTML 错误页，执行报 `syntax error near unexpected token`。
- ❌ `pip install ffmpeg-python`：那是 Python 包装库，不是 ffmpeg 本体，装完 `ffmpeg` 命令依然不存在。
- ❌ `rm -rf` 缓存目录再重试：sandbox 的 /tmp 常删不动（Operation not permitted）；脚本重跑本来就不需要清缓存。

（Windows 的 OSS exe 直连地址，仅供核对，preflight 已内置：
https://obs-nmhhht6.cucloud.cn/app-agent-prod/video-search/ffmpeg-9.0-essentials/bin/ffmpeg.exe
https://obs-nmhhht6.cucloud.cn/app-agent-prod/video-search/ffmpeg-9.0-essentials/bin/ffprobe.exe ）


缺工具时故障会伪装成别的问题——uvx 不在 PATH 看着像"片源引擎连接失败"，ffprobe 缺失看着像"这个源不可播"。所以先体检。需要 sudo 的安装命令 preflight 只打印不执行（agent 里会卡在密码提示），转给用户跑。

冷启动要建 mcp-vods 环境（~89 个包，1–5 分钟），**可能超过 Bash 工具默认 120 秒超时**。被打断是正常的，依赖断点续装，加大超时重跑即可——**不要据此判定引擎不可用而转兜底**，这是本 skill 最常见的误判。

## Scripts

优先用脚本，别手写底层命令：命令拼错是历史最高频故障，而且报错会伪装成环境问题。

```bash
# 搜索：默认已按片名相关度排序、省略封面图和简介列（省约 80% 上下文）
python scripts/mcp_vods.py search "{片名}" [--page 1] [--max-rows 30] [--timeout 120]
python scripts/mcp_vods.py search "{片名}" --raw       # 要原始完整输出
python scripts/mcp_vods.py detail --id "{id}" --source "{source}" [--episode -1]
python scripts/mcp_vods.py doctor                      # mcp 链路分层诊断

# 探测：结论可直接写进结果表
python scripts/probe_media.py "{m3u8|mp4}" [--expect movie|tv] [--expect-minutes 120] \
    [--referer "{播放页}"] [--sample] [--json]

# 下载：start 立即返回；成功后必须调用 VideoDownloadJob.register，
# 由后端在当前轮次结束后继续监控并把最终结果送回本会话。
# HLS master 清单会在 start 内自动下钻到最高码率分片清单，不用手动传 probe 的 variant_url；
# 已是分片清单或 non-HLS 不受影响；解析失败自动回退原 URL（--no-resolve 可关）。
python scripts/download_media.py start --url "{m3u8}" --out "{文件.mp4}" \
    --duration {秒} [--est-size-mb {probe 给的}] [--referer "{播放页}"]
python scripts/download_media.py status --out "{文件.mp4}"
python scripts/download_media.py stop   --out "{文件.mp4}"
```

`probe_media.py --json` 的 `est_size_mb` 可直接喂给 `download start --est-size-mb`。

## When To Read References

- `mcp-vods.md`：搜索空/超时、取全集、候选排序。
- `fallback-search.md`：mcp-vods 失败后的兜底梯子和对用户话术。
- `media-verify.md`：挖真实媒体 URL、时长门槛。
- `download-progress.md`：进度汇报节奏、分段下载、失败处理。
- `output-rules.md`：过滤、排序、结果表格式。


## Background Download

`download_media.py start` 会让实际下载进程独立运行并立即返回。启动成功后必须：

1. 使用下载文件和脚本的绝对路径调用 `VideoDownloadJob`：
   `{"action":"register","title":"{片名/集数}","output_path":"{输出文件绝对路径}","status_script":"<技能根>/scripts/download_media.py"}`。
2. 只有工具返回 `success=true` 和 `job_id` 后，才能回复用户“下载已开始，可继续处理其他问题”，然后结束当前轮次。
3. 不创建 CronJob，不在当前轮次调用 `wait-status` 等待完成，也不通过伪造用户提问续接一轮对话。
4. 后端会静默记录进度；完成、失败或取消后，在原会话追加独立的后台任务结果卡片。该卡片不是普通 Assistant transcript 消息。
5. `VideoDownloadJob.register` 失败时，立即执行 `download_media.py stop`，并明确说明后台监控未启动；不得留下无人监控的下载进程。

查询或取消时先调用 `VideoDownloadJob` 的 `list` 找到当前会话任务，再使用 `status` 或 `cancel`，不要创建定时任务。页面暂时断开不等于用户取消，后台监控会继续运行。


## Critical Rules

- 关键词只用干净片名，不加 `全集/电视剧/年份/m3u8`——加了反而匹配不到，修饰词留给网页搜索。
- 不对用户暴露 `mcp-vods`/`uvx`/`连接失败` 等内部术语；需要兜底只说"正在用网络搜索为你查找片源"。
- 连续剧默认找全集。只验证了单集就不能标成"全集可用"。
- 时长是硬门槛不是加分项：预告片和切片是最主要的假阳性来源。
- 正版平台有授权版本时一并给出入口，不挤占免费结果。
- 播放地址必须是 Markdown 可点击链接，不能是纯文本或反引号 URL。
- 不伪造链接：URL 必须来自搜索、页面、接口或探测输出。
- 下载启动后必须调用 `VideoDownloadJob.register`；登记成功即可结束当前轮次，让用户继续聊天。禁止创建 CronJob 或在本轮循环等待。
- 后台管理器负责验证成品、复制 VM/云端文件并生成附件卡片；Skill 不得在登记成功后继续等待并重复交付。
- 防盗链源站给 probe/download 传 `--referer`（UA 已默认带）。探测失败先怀疑缺 Referer。



## Self-Test

- `找一下狂飙的资源`：给全集链表，不只第 1 集。
- 搜"狂飙"会混进几十条同名短剧。脚本已按相关度预排序，但仍要用年份（2023）和集数（39）复核，别把 60–100 集的短剧当正剧。
- mcp-vods 两次 empty：走兜底，不直接回"无结果"。
- `我想看流浪地球`：用 `--expect movie --expect-minutes` 排掉时长不对的候选。
- `下载狂飙第1集`：启动并登记后台任务后结束本轮；用户可继续聊天，完成后原会话出现结果和附件卡片。
- 结果表里播放地址是 `[播放链接](https://...)` 形式。
- `推荐几部好看的刑侦剧`：不触发本 skill。
