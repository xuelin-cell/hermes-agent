# Protocol client provenance

Ported from UniClaw `uniwork_release` at `ce575e5cfb7972925f245ecfec3f5e0feaa02e60`:
`libs/hexagent_demo/backend/hexagent_api/channels/uniagentgate/{auth,protocol,stream}.py`.

Original changes include `ef0feece` (initial connector), `559a6f05` (binding),
`65627938` (request headers), `610c667c` (heartbeat/reconnection), and
`872beb42` (bounded authentication recovery). The later protocol/client changes
were authored by lijiyang. This port retains the source protocol/client structure;
the Hermes adapter, health observer and account integration are new.

`X-Agent-Version` reports Hermes's base release version when it is at least
`1.0.0`. Older migration builds (including `0.0.0`) and unknown or invalid
versions send `1.0.0` to satisfy the gateway's minimum; newer versions are
preserved. The registration body's `version` remains the connector version.

The desktop build combines the official bundled plugins and this plugin in
`dist/python-plugins`. Packaging places that complete tree in `resources/python-plugins`,
outside Electron's `app.asar`, and the desktop sets the existing
`HERMES_BUNDLED_PLUGINS` discovery root before starting the backend. Accounts do not
copy or link plugin code. Config, secrets, caches, connections and the control socket
record remain scoped to each account's Hermes home. Legacy account-local copies or
directory links are moved to `plugin-backups/`, outside discovery, before startup so
they cannot shadow the bundled plugin. Fresh accounts need no migration or backups.
Inbound file staging and outbound native-media/link rules are adapted from the same
source commit's `libs/hexagent_demo/backend/hexagent_api/channels/runtime.py`
(`_stage_uniagentgate_attachment`, `_build_uniagentgate_media`). The Hermes media cache,
`MEDIA:` artifact extraction, scoped MCP registry and PM-managed transcoder replace the
old Claw conversation, VM downloader and pre-upload singleton.

This distribution supports text, inbound attachments, combined final text/media replies
and account-scoped manual reconnect and live binding updates. Multiple independently
bound Agents are outside this distribution's single-personal-binding scope; busy input
continues to use Hermes's configured processing policy.

## 元景生成结果的本机交付

5G 消息通过已启用的 `desktop-deliverables` 复用生成结果下载：只处理该插件支持的生成工具，
成功文件保存到当前账号会话工作区的 `outputs`，再由原有 `MEDIA` 提取和本插件一次最终下行发送。
图片识别提示与桌面、微信、飞书、企业微信、钉钉共用规则；普通消息不扫描工作目录猜测产物。
翻译、播客沿用现有后台完成回传；本次不增加视频后台委派策略。

下载器仍限制单文件 32 MiB；下载失败不补不存在的文件引用，原链接留在工具结果中。
下载成功但超过 20 MiB 的成品也保留原链接并提示模型转交，程序不强制把链接追加到最终回复。
5G 原生图片、音视频仍限制 20 MiB，其他文件继续使用已有上传后的下载链接。
普通本地文件没有原链接时不新建备用托管方案，不因发送失败删除本机成品。

文件读取／下载、音频转换、上传、路径检查或大小限制失败时，最终同一条回复包含失败数量及原因类别，
成功附件和附带文字照常发出，不展示完整本机路径或原始异常。全部附件失败也发送明确通知。
收到下行确认后，账本按实际已受理回复收尾，附件失败另报告为处理失败，不能因此重放整条回复。
直接附件发送返回失败并保留已确认下行的 ID；现有 ACK 不确定时不自动重发的规则保持不变。
网关受理不等于手机已经展示或用户已读。

源码更新后需完整退出并重开桌面及其托管网关；后台委派提示的更新在新会话生效。
人工验收从 5G 发起“用元景生成一张图片”，核对本机 `outputs` 文件、手机图片展示、正确收件会话及无重复消息。
自动化使用独立 Home、本机 HTTP／WebSocket／MCP 和受控模型响应，不证明真实元景与运营商链路已通过。

本轮定向回归：`scripts/run_tests.sh tests/apps/desktop/test_uniagentgate.py
tests/plugins/test_desktop_deliverables_image_hints.py tests/plugins/test_desktop_deliverables_messaging.py
tests/plugins/test_uniwork_background_rules.py`（合并为一条命令执行）。80 项通过、1 项失败、1 项跳过。
通过项包含生成图片、后台翻译自动补附件、下载失败保留链接、超限保留链接、A→B→A 上传归属、
部分／全部附件失败提示、附文保留、图片提示及既有 ACK 丢失不自动重发；模型和服务响应受控。
失败项为原有重连测试用 JSON 解析已写成 YAML 的配置；使用修改前的测试及四个业务文件单独复现，
本轮未调整该测试或重连产品实现。FFmpeg 不在隔离测试 PATH，真实 WAV 转码检查跳过。
Ruff、Python 编译及 Git 差异检查通过；不把这组结果记为全绿。
