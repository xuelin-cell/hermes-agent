# 媒体验证

## 挖出真实媒体 URL

优先级：`.m3u8` > `.mp4` > `.flv` > 其它 ffprobe 能读的视频地址。

在这些字段/模式里找：`url`、`play_url`、`vod_play_url`、`video_url`、`source`、`src`、`player_aaaa`、`player_data`、`"url":"..."`。

**播放页 URL 不是媒体 URL。** 把播放页丢给 ffprobe 只会得到一堆 HTML。

## 连续剧分集列表

目标默认是全集。只找到一个播放页时：

1. 解析 `player_data`、`vod_play_url`、`playlist`、`episodes`。
2. 提取分集导航：`第1集`、`第2集`、`/play/{id}-1-1.html`。
3. URL 有规律时可以按规律生成候选，但**只用于验证**，没验证过的拼接链接不能直接输出。
4. 建立 `集数 -> 媒体URL` 映射。
5. 抽检首集、中间集、末集——用**一条** `probe_media.py` 多 URL 命令并发完成，不要逐条串行跑三次。超过 30 集抽这三个就够了——全验一遍很慢，收益却不高。

## 探测

```bash
python <技能根>/scripts/probe_media.py "{media_url}" --expect tv --json
python <技能根>/scripts/probe_media.py "{ep1}" "{ep20}" "{ep39}" --expect tv --json   # 多 URL 并发（≤4），抽检多集用这个
python <技能根>/scripts/probe_media.py "{media_url}" --expect movie --expect-minutes 125 --sample
python <技能根>/scripts/probe_media.py "{media_url}" --referer "{播放页}"      # 防盗链
```

多 URL 时 `--json` 输出数组、退出码 0 = 全部通过；逐条串行探一条死源最长要等 2 分钟，抽检三集并发跑只花一条的时间。

脚本已替你做完三件事，别再自己拼 ffprobe 重复一遍：

- **master playlist 自动下钻**到最高码率子流。master 里只有各档地址没有分片，直接探会得到时长 0，把好源误判成不可播。
- **m3u8 无 duration 时累加 `#EXTINF`**。HLS 的 duration 经常是 N/A，直接判"时长未知"会误杀大批可用源。
- **码率取自 master 的 `BANDWIDTH`**。HLS 的 `format.bit_rate`/`size` 描述的是清单文件本身（实测 29 bps / 6.7 KB），当画质指标是错的。

输出的 `est_size_mb` 可直接传给 `download_media.py --est-size-mb`。

## 时长硬门槛

时长是门槛不是加分项。预告片、花絮、几分钟的切片是这类搜索最主要的假阳性来源，而它们的其它特征（分辨率、码率、能不能播）往往都很正常，只有时长露馅。

| 类型 | 接受 | 拒绝 |
|---|---|---|
| movie | 已知片长 ±12 分钟；未知时一般 30–300 分钟 | 预告、切片、解说、过短或过长 |
| tv | 单集一般 10–180 分钟；全集靠抽检覆盖 | 只有几秒/几分钟，或覆盖明显不全 |
| unknown | 只拒明显异常 | 广告、预告、切片 |

`--expect` / `--expect-minutes` 会让脚本直接给 `duration_ok` 和 `verdict`。探到了时长且不合格 → 排除；探不到时长但媒体 URL 有效 → 最多标 `⚠️`，不能标 ✅。

## 抽样拉流

`--sample` 会真拉 15 秒。分片 404、密钥失效这类问题只有实际拉流才暴露得出来——能 probe 不等于能播。代价是每条十几秒，所以只对最终要推荐的候选做，别对整个候选池做。

（脚本内部按平台选空设备：Windows 用 `NUL`，其它用 `/dev/null`。手写命令时容易漏掉这个差异。）

## 画质排序

1. 分辨率：2160p > 1080p > 720p > 480p
2. 码率
3. 体积 / HLS 估算体积
4. 页面上写的 `4K`/`1080P` 标签——只作弱信号，标签虚标很常见，以探测到的实际分辨率为准。
