# 会话标题优化

2026-11-06；目标 `/Users/tessieji/Desktop/hermes-agent` 的 `release`，基线 `745bda133a61da86cf6285c3f9ee86462e806c67`。只迁移标题增量，保留本基线发送、分享、未读状态和模型选择逻辑；不包含数字员工 Projects 功能。未提交，真实模型及完整桌面验收待完成。

## 用户行为

发送后立即显示临时名称：文字使用净化后的输入；纯文件或图片使用原文件名，多附件显示首个名称与数量；纯粘贴即使变成 txt 附件，也优先保留原始 `titlePreview`。临时名称最多24个可见字符，超出省略。

正式标题概括用户意图，中文优先，目标8–12个可见字符、整体上限16（英文、数字、标点也计入），清楚的短标题不凑字数。纯附件等待主流程提供已读取的正文、识图结果或必要的主回答描述，不直接拼接“查看＋文件名”。无法确定主题就保留临时名称。正式自动命名只成功一次，用户手动改名优先，旧正式名称、定时执行名称、隐藏会话和业务固定名称保持。

## 接线和资源

- Renderer：`src/lib/conversation-title.ts` 格式化临时名并管理带版本的显示观测；提交确认后，`src/api/conversation-titles.ts` 按固定后端和Profile向插件发送最小元数据。
- Electron：`electron/conversation-titles/service.ts` 只取当前数字员工登录套餐的 `mainModelIndex`、模型端点及Key，不接受页面传入这些字段。未核实独立低价标题模型，当前使用套餐默认模型；不会更改主聊天模型选择。
- 本机桥：`bridge.ts` 仅监听127.0.0.1，短期随机凭证只交给本进程启动的后端，套餐Key留在主进程。拒绝重定向及任意额外字段。
- 产品插件：`assets/uniwork-titles` 随桌面安装到账号及受管Profile，使用原生插件HTTP接口和 `pre_llm_call` / `pre_api_request` / `post_tool_call` / `post_llm_call` 观察钩子。只读取已有内容，不增加识图、上传、读取文件或主模型工具回合，不修改主消息、历史和系统提示。
- 启动准备：`install.ts` 保留原配置，启用产品插件并通过既有 `auxiliary.title_generation.enabled=false` 停止旧命名。已有同账号Profile启动前准备，后续启动按目标Profile准备。显式禁用产品插件时不恢复Hermes辅助命名。

无套餐、额度不足、认证失败时保留临时标题；不回退到 `llm.oneshot`、`ctx.llm`、个人Key、Nous、OpenRouter或 `solar-pro4:free`。不另外向用户索取Key。标题请求可能消耗现有数字员工额度，不能宣称免费；原生主会话usage不自动包含这笔独立调用，真实计费以模型服务为准。

## 调度与材料

主执行到达 `pre_api_request` 后才放行标题队列；这说明主请求已进入发出阶段，不声称服务端已经接收。每个桌面进程标题网络并发最多2；每个Profile最多两个后台工作线程，复用原有SQLite事务领取任务，避免重复执行，主聊天不使用此锁。已有明确意图时只发最多1800字符的输入；纯材料或先前判断不足时再带最多2400字符的已读片段。输出预算512 token（正式标题显示最多16个可见字符，不要求用满预算），HTTP超时8秒，最多3次实际调用及12次队列检查；429退让30秒；单次超时只让当前任务退让2秒，不启动全局冷却；网络/服务故障仍退让10秒，刷新/重启不重置预算。

只取得首段材料并不能保证主题充分；无材料且模型返回NONE时等待。已有材料但仍返回NONE，或出现格式无效等可恢复生成失败时，在原有3次请求/12次检查预算内重试，耗尽后保留临时名。纯图片直接由主模型理解时可能要等其描述返回，不能保证首答前改名。当前没有服务端抢占或通用并发压力遥测；应用有限并发和已知限流退让不等于零资源竞争。迟到结果保存前重新核验，手动改名或会话删除会让它失效；已发出的HTTP不因手动改名保证取消或停止计费。

## 保存与一致显示

临时 `derived` 和正式 `llm` 标题都使用原生 `SessionDB.set_auto_title` 保存，原生事务保证只从临时升级一次及手动优先；不绕过手动改名接口伪装来源。不建立第二份正式标题库。相比原定稿“插件保存临时标题”，实施将两种标题统一到已有原生字段，插件SQLite仅保存命名待办和有界重试状态。

待办按账号Home/Profile/压缩谱系根定位；执行前后按当前tip核对，正式标题的冲突编号计入16字符上限；临时标题仍为24字符。持久启用时间只创建一次，启动恢复只补启用后新建、已有首条消息且无标题的会话，不批量命名历史。已有正式名称直接终止任务；完成后清除暂存意图和材料，保留去重状态。

原生落盘后发送 `plugin.uniwork-titles.changed`；前端按事件归属重读原生记录，同一会话事件合并且串行刷新。侧栏、会话顶部/标签复用原生会话状态及原生工作目录项目缓存；不迁入业务Projects缓存或页面。观察版本阻止旧列表回执把新标题改回去，后续权威读取仍允许其他窗口的手动变更。重启后读原生会话库，事件丢失不丢标题。

后台线程显式绑定本任务Profile及空原生密钥scope，使用 `spawn_context_thread`，不继承其它Profile的模型资源。未受管远端保留原路径；独立后台无桌面桥时只积累待办，桌面恢复后处理，不宣称桌面退出后持续生成正式标题。标题仍仅随本机会话保存，不加入项目云端配置。

## 验证与边界

定向验证使用临时Home、真实SessionDB、原生插件注册/钩子和FastAPI接口、本机HTTP桥及外部模型替身；覆盖A→B→A Profile切换、真实multiplex scope、首条提交后恢复、手动与自动竞争、压缩tip、随机附件内容、纯粘贴、同名长度、失败限流、重复调用及普通侧栏迟到回执。主消息前后保持一致。

运行命令（从仓库根进入对应目录；测试解释器需已有原生运行依赖）：

```sh
scripts/run_tests.sh tests/apps/desktop/test_conversation_titles.py -j 1 -q
cd apps/desktop
../../node_modules/.bin/vitest run --project electron electron/conversation-titles --project ui src/lib/conversation-title.test.ts src/api/conversation-titles.test.ts src/api/sessions.test.ts src/app/session/hooks/use-message-stream/gateway-event/title-events.test.ts src/app/session/hooks/use-message-stream/gateway-event/session-info.test.ts src/app/chat/sidebar/session-actions-menu.test.tsx src/app/session/hooks/use-prompt-actions/detached-create-submit.test.tsx
../../node_modules/.bin/tsc -p tsconfig.electron.json --noEmit
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
```

不修改Hermes Python核心；Python新增代码是桌面分发的产品插件及隔离测试。已按用户明确授权完成2次独立真实标题请求对照，结果及局限见下文；未进行正式账号消息收发、完整Electron重启/多窗口或Windows验收，未全面覆盖真实模型的中文质量、首字时延和费用；隔离测试通过不能替代这些验收。用户当前窗口及既有运行环境未被重载。

## 接口与验收限制

当前插件仍使用原生SessionDB、内部标题输入清理和Profile解析函数；这些已按本基线核查，不宣称是稳定ctx契约。安装失败仍可能影响受管后端启动；卸载注销钩子不等于取消已发出的HTTP或所有后台任务，需继续验证生命周期。标题机制测试与真实用户模型质量、费用及完整Electron体验分开记录。

## 本基线实际验证

2026-11-06：10个TypeScript测试文件55项通过，Python统一入口16项通过；定向ESLint、Electron类型检查和`npm run build`（含postbuild产物检查）通过。Renderer完整类型检查仍有4条既有错误：侧栏emptyState、会话列表测试2条类型错误、邮件页面调用参数；在干净745bda133a副本复现，未在本次标题迁移中修改这些模块。构建只生成本机产物，没有启动用户桌面，没有调用真实收费模型。

集成探针使用本基线PluginManager实际发现、注册、分发和注销钩子，以及真实FastAPI、SessionDB与本机HTTP桥；外部模型仍为替身。覆盖注册注销不代表卸载中途取消后台任务已通过。旧feat-projects及误建worktree均未参与本次运行，原有源码改动保留。

## 图片材料与失败处理修复

实际识图工具 `mcp__UniAI_Toolkit__analyze_image`（及既有元景/1号同能力名称）由标题插件的 `post_tool_call` 观察器直接复用；不改变工具执行、不增加识图或上传，不修改主回答。其他编辑、生成工具不因本修复成为材料来源。

标题服务区分 `no_topic`、`truncated`、`invalid_title`、`malformed_response`、`missing_body`、`response_too_large`、`invalid_finish`、`timeout`、`network_error`、`rate_limited`、`auth_or_quota` 等固定原因。真正缺材料才等待；已有材料但生成失败使用原有有限重试，失败耗尽仅结束任务，不把临时标题标成正式成功。主请求、输入限长、8秒超时和数字员工资源约束不变；输出预算512 token。输出截断直接结束命名任务，保留临时标题，不以同一预算反复请求。

启动时仅恢复已有材料且 attempts<3、checks<12 的旧waiting任务；不清零次数、不批量命名历史、不重复读图。已完成或用户手动命名仍由原生保存优先级保护。

日志复用现有入口：桌面 `uniwork-titles` 记录状态、固定原因、耗时与长度；Python `uniwork.titles` 记录会话ID、材料来源、重试计数及任务状态，不记录输入、材料、完整模型回复、端点或Key。没有新数据库表、新队列、新hook/ctx或核心业务分支。

修复后定向验证：70项TypeScript/桥接测试、22项Python测试通过；原生插件集成覆盖明确附件的终端读取结果，MCP识图工具名另有回归，模拟首个标题格式无效、随后成功，并验证输出截断不重复请求。旧waiting恢复、三次耗尽、手动优先和脱敏日志有回归。Electron类型与定向规范通过；Renderer仍仅有先前4条基线错误。真实模型效果待完整重启后验证，未代操作用户窗口或消耗真实模型额度。

本修复 `npm run build` 与 postbuild 产物检查通过；未启动窗口。完整重启Electron后安装新版标题插件，符合条件的旧等待任务才会续跑。

## 明确意图标题的输出预算

真实日志显示：09:46的名言任务连续三次finish_reason=length后耗尽；域名任务前两次length，第三次才在主回答结束后成功。不是统一等待主回答完成。之前96 token预算过低；旧日志没有usage，无法据此断言服务实际启用了推理。现改为512 token上限，提示只命名、不回答问题、不访问链接；明确任务不必等材料。仍用当前数字员工套餐默认模型、thinking disabled、最多2并发和8秒超时。此上限不代表实际消耗或速度承诺。

响应日志仅增加正文/推理字符数及服务返回的completion/reasoning token数，不记录内容和凭据。达到输出上限后停止相同请求，不接受半截标题。已经耗尽或正式成功的旧任务不重置，新版本真实效果需完整重启后用新会话验证。

当前70项TS、22项Python、定向ESLint和Electron类型检查通过。Electron main/preloads已重新打包，语法及既有Renderer产物检查通过，本次未重新构建Renderer；原先4条Renderer类型错误保持。测试使用外部模型替身，未代发真实收费请求，未启动用户窗口，不宣称真实时延或额度改善已验收。

## 附件材料与单次超时

重启后实际日志：名言和婺源意图标题分别在约2.3秒和4.1秒内完成；纯Excel从发送至命名约94秒，已有终端读取结果被漏过，直到主回答才供给材料；绘图请求两次8秒超时，加上各10秒等待，约38秒后成功。这批请求没有busy_or_cooldown记录，不能归因于并发排队；该批运行时仍为标题单并发；当前源码已调整为最多2并发。

标题插件通过已有post_tool_call观察终端结果，仅在读取命令明确引用本会话首条消息的附件路径、成功退出且无错误时提取已有output；不执行命令、不再读文件、意图排除目录列表、依赖安装或其他文件输出；但已发现unzip -l | head目录输出会误命中，目前尚未修复。识别目前覆盖cat/head/tail/pdftotext及open/read_csv/read_excel/load_workbook，未知读取方式继续等待已有读文件工具或主回答；不宣称覆盖所有脚本。模型仍需判断实际主题，纯附件不将助手的澄清、建议或处理状态当作用户意图。

超时不等于服务端限流，8秒超时后释放槽位，仅当前任务等2秒后按既有最多3次预算重试；429仍退让30秒，其他网络/服务故障保持10秒冷却。主聊天与标题保存规则不变。未新增队列、表、通用接口或核心分支。

旧参数的实际标题响应已观察到非零reasoning token。用户明确授权2次真实请求后，使用当前有效登录账号套餐deepseek-v4-flash和相同简短命名提示：仅thinking disabled的一次8秒超时；另加chat_template_kwargs.enable_thinking=false的一次2.414秒成功，输出11 token、reasoning_content为空。当前登录账号与报告问题的旧会话账号不同；这不是同账号生产提示的完整桌面验收，也不能归因所有时延或保证恒定速度。现仅对准确元景主机maas-api.ai-yuanjing.com及已验证模型deepseek-v4-flash的标题请求增加模板参数，其他端点/模型和主聊天保持原样。未更换套餐资源，没有第3次模型调用；超时请求实际费用未知。当前隔离回归70项TS、22项Python通过；Electron类型、ESLint通过，Renderer原先4条类型错误仍在。未改Python核心，未提交，未代重启用户实例。

## 两并发与16字符正式标题

标题网络槽位由1改为2，并同步调整插件同Profile后台处理，避免网络层放宽但插件仍逐项等待。主请求不等待标题结果，模型资源来源和有限重试预算不变，不新增队列、表或核心扩展。正式标题提示目标8–12、硬上限16个可见字符；超长响应判无效并沿用有限重试，未直接截半句。保存冲突编号也计入16，临时文件名、手动名称及已成功的旧标题保持。

定向回归70项TS与22项Python通过；真实插件HTTP/钩子/SessionDB/本机桥验证同Profile两项请求重叠到达且各自保存，第三项在两槽占满时退让、释放后可进入。外部模型为替身；覆盖16/17字符、中英混排、复合emoji与冲突编号。本次未调用真实模型，完整重启后的服务速度、标题质量与主聊天体验仍待验收。PPT目录输出误当正文的问题未包含在此次两项调整中。
