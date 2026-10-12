# mcp-vods 搜索规则

## 命令

一律走 `scripts/mcp_vods.py`：预热、串行锁、失败自愈、分层诊断都在里面，手写命令拿不到这些保护。

```bash
python <技能根>/scripts/mcp_vods.py search "{片名}"                 # 常规，超时 120s
python <技能根>/scripts/mcp_vods.py search "{片名}" --timeout 180   # 慢网
python <技能根>/scripts/mcp_vods.py search "{片名}" --page 2
python <技能根>/scripts/mcp_vods.py search "{片名}" --max-rows 0    # 要完整结果
python <技能根>/scripts/mcp_vods.py search "{片名}" --raw           # 要原始未处理输出
python <技能根>/scripts/mcp_vods.py search "{片名}" --no-cn-mirror  # 海外网络
python <技能根>/scripts/mcp_vods.py search "{片名}" --year 2023 --episodes 39  # 已知年份/集数：排序加权
python <技能根>/scripts/mcp_vods.py detail --id "{id}" --source "{source}" --episode -1
python <技能根>/scripts/mcp_vods.py doctor
```

底层是 `vods_search(keyword, page?)` 和 `vods_detail(id, source, episode?)`。

## 结果已预处理

`search` 输出不是原始返回，脚本做了两件事：

- **省略 `poster`/`intro`/`desc` 列**。封面图占返回体积 32%、简介占 11%，排序时都用不到。一页从约 1.8 万 token 降到 3 千。要简介加 `--with-intro`。
- **按片名相关度排序**，精确匹配在最前，结尾注明总条数和省略了多少（默认留 30 行）。不会静默截断。传了 `--year`/`--episodes` 时，年份、集数命中的候选额外加权——热门片名撞重名时（2018 版和 2023 版《狂飙》片名一样）这是最硬的区分信号。

后处理失败会自动退回原始内容，不会吃掉结果。

**排序不代替判断**：加权只是把最可能的排上来，年份、集数、类型仍要复核。搜"狂飙"精确匹配的是 2023 年 39 集国产剧，60–100 集的"狂飙之X"都是蹭名字的短剧。无精确匹配时脚本会加一行提示，先核对片名写法再下结论。

## 关键词

只用干净片名。加 `全集`、`电视剧`、`2023`、`m3u8`、`全39集` 这类修饰词反而匹配不到，它们只留给网页搜索兜底。已知年份/集数走 `--year`/`--episodes` 参数，不进关键词。

## 冷启动

调用链是 `npx → mcporter → uvx → mcp-vods`，mcp-vods 是 ~89 个包的重环境。**只有每台机器第一次需要下载**，之后秒级复用。冷缓存下载跑输 MCP 握手超时，是新机器上"连接失败 / Connection closed"的头号原因——看着像网络挂了，其实只是没装完。

⚠️ 冷启动 1–5 分钟，可能超过 Bash 工具默认 120 秒超时。**不要单独跑 warmup 干等**——它花同样的时间却不产出结果。新机器直接跑首搜：Bash 的 `timeout_ms` 给 600000、命令加 `--timeout 300`，`search/detail` 会自动预热，同一段等待末尾拿到的是搜索结果。`warmup` 子命令只留给"提前铺机器"的装机脚本用。被打断是正常的，依赖断点续装，加大超时重跑——**别当成引擎不可用而转兜底**。

脚本内置四层对策：

1. **镜像先体检再用**：装依赖前拉一个 ~2MB 真实制品测吞吐（小文件/元数据页会假阳性），通就用镜像、不通自动切官方源，npm 层和 Python 层独立取舍；结论写进预热标记，**后续每次调用沿用同一取舍**（调用环境和预热不一致会出"预热成功、调用超时"的迷惑故障）。镜像不是无条件更快——实测有网络对清华镜像单个 wheel 超时 127 秒、官方源反而 1 秒。强制关镜像用 `--no-cn-mirror` 或 `VODS_NO_CN_MIRROR=1`。
2. **自动预热**：未初始化时先建环境再调用（npm 层和 uv 层并行装），并打印提示语，转述给用户后等它跑完。
3. **串行锁**：并行起多个 `uvx mcp-vods` 会抢 uv 缓存，表现成空结果或 Connection closed，容易误判成"没有资源"。锁是代码强制的。
4. **版本钉死**（`mcporter@0.12.3` / `mcp-vods@0.1.9`）。升级改脚本顶部常量，或用环境变量 `MCPORTER_SPEC` / `MCP_VODS_SPEC` 覆盖。**该升级的信号**：warmup/doctor 报"版本不存在/404/无法解析包"（而非网络超时）时，先用环境变量试最新版（如 `MCP_VODS_SPEC=mcp-vods` 不带版本号），能跑通就回来更新钉死常量。

## 超时和空结果

`MCP error -32001: Request timed out` 是请求被截断，**不代表没有资源**。

1. 用干净片名重试一次，超时 120–180 秒。
2. 仍失败 → 转 [fallback-search](fallback-search.md)。
3. 不要反复重试，脚本已经自己重试过一轮。

## 取全集

**别把 `episodes_newest` 当全集**，那只是最新一集。选最匹配的一行取详情，`--episode -1` 返回全部集。若只回单集，标为不确定并继续兜底，别对用户宣称是全集。

## 候选排序

1. 片名**精确**匹配——只看包含关系必然选错。
2. 年份匹配。
3. 集数匹配。
4. 有真实媒体 URL（`.m3u8`/`.mp4`），不是播放页。
5. 免费源优先于 VIP 平台。

## 失败诊断

脚本失败会自动跑轻量诊断分层定位：

- `npx`/`mcporter --version` 挂 → Node/npm 层。
- `uvx --version` 挂 → uv 真没装（脚本解析工具不看 PATH，注册表和各平台安装位置都查过了，所以这条不是"PATH 没配好"）。跑 `preflight.py --install`，跑完就别再自己找路径。
- 两个都正常 → 大概率是 mcp-vods 自身或网络，加 `--diagnostics` 做全量探测（会触发 ~89 包安装，较重，故不默认跑）。

**无害噪音**：Node < 24 时 npm 会打印 `EBADENGINE ... mcporter@0.12.3 required: node >=24`。只是警告，Node 22 实测正常，别当成故障去修。
