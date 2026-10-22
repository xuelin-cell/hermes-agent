# 桌面连接器：MCP 适配实施计划

日期：2026-10-14。代码核查基线：`desktop-mt @ b26fd5a6c7`。

状态：M01～M05 实现完成；M06 模拟回归与文档收尾完成，真实桌面、元景连接及模型调用仍待人工验收。本文不授权推送。

## 1. 目标与范围

界面参考 UniWork，MCP 配置、连接、工具发现和调用复用 Hermes 原生能力。内置 MCP 参考 Web 版（`origin/feat/hermes-ch`）的做法，保持简单。

- 只面向 Windows 桌面本地多账号、源码开发运行。
- MaaS 账号之间隔离；同一账号内按 Hermes Profile 管理 MCP，不自动跨 Profile 同步。
- 页面沿用 Hermes 组件、主题和国际化；自定义 MCP 的新增、JSON 编辑、启禁用、测试、删除、OAuth 和工具过滤全部用原生能力。
- 首批内置项只做 UniAI-Toolkit（元景 MCP）。
- 实施中有问题及时讨论，不自行扩大范围，不用临时回退掩盖问题。

本轮不做：

| 项目 | 原因 |
| --- | --- |
| Playwright | 浏览器操作已由 Hermes 内置工具提供（`browser_exec` 等），不再另装浏览器 MCP |
| arXiv | 由 Hermes 原版 `arxiv` 技能提供，是否随发行包保留另行决定 |
| 推荐连接器、OpenConnector、小红书 | 独立待办 |
| 本地文件上传（UniWork 的附件预上传或技能引导） | 与 Web 版一致不做：远程服务读不到本机文件，需要文件的工具只能使用已有的远程地址 |
| `oss_mode=internal` | 只用于云端内网，桌面版不带 |

## 2. 原生行为与复用原则

| 操作 | 原生行为 | 处理 |
| --- | --- | --- |
| 新增 | 保存配置，再异步重载并探测连接；默认启用 | 复用 |
| 编辑 | 原生 JSON 编辑，保存后重载 | 复用 |
| 启用／禁用 | 保存启用标志，再重载 | 测试失败不自动改回，不等于关闭远程服务 |
| 删除 | 删除配置记录，再重载 | 只移除配置 |
| 重载 | 重建连接、发现工具并刷新已创建的会话 Agent | 不另建重载策略 |

关键边界：

- 保存成功不等于重载完成，更不等于工具调用成功。
- 重载异步执行，可能影响在途 MCP 调用和提示词缓存；本轮不做空闲等待。
- 后端运行期间通过原生 MCP API 修改配置；Electron 只在后端启动前写入内置记录，两者不会并发写 `config.yaml`。
- `mcp_servers` 中的 `${VAR}` 由 Hermes 在读取时从 `.env` 展开（`tools/mcp_tool_config.py`），配置文件不存明文密钥。
- MCP 工具由原生 `tool_search` 按需加载；远程 HTTP 读取超时在 `tools/mcp_tool_transport.py` 固定为 300 秒，单服务的 `timeout` 不能突破它。

## 3. 修改位置与上游边界

遵循 AGENTS.md「desktop-mt 新功能放在哪里」：不修改 Hermes Python 后端，不新增 Python 接口或插件路由。

| 职责 | 位置 |
| --- | --- |
| 写入内置 MCP 记录 | Electron 主进程，新增 `electron/entry_local/uniai-toolkit-config.ts`，由 `prepare-account.ts` 调用 |
| 密钥打码 | 移植 Web 版 `mcp-secrets.ts` 为 `electron/mcp-secrets.ts`，在 `electron/preload.ts` 的 `api` 接入点处理 |
| 页面 | `src/app/capabilities/mcp-mt/` 与 M02 新增的文案 |

唯一要改的上游已有文件是 `electron/preload.ts` 的 `api` 接入点及其模块导入：界面读写配置的所有请求都经过 `window.hermesDesktop.api`，在别处接入会漏掉 `/api/config` 或 `/api/mcp/servers` 中的某一条。提交说明中写明这一点。

## 4. 分步实施与验收

### M01～M03（已完成）

- **M01 原生链路验证：** 新增 `tests/hermes_cli/mcp_stdio.fixture.py` 与 `test_desktop_mcp_native.py`，用真实 stdio 子进程验证新增、编辑、启禁用、删除、发现和调用，以及两个 Profile 同名服务隔离（`61c57c499f`）。
- **M02 页面组织：** 新增 `src/app/capabilities/mcp-mt/`，内置／自定义／插件分组，复用原生控制器、JSON 编辑、OAuth 与工具视图；连接器不再要求开发者模式。
- **M03 复用原生管理：** 撤回自建的结构化编辑和凭据补存，只修正保存后重载的 Profile 目标（`src/api/mcp.ts`、`use-mcp-servers.ts`，`77daafefae`）。

详细验证记录见第 7 节。

### M04：写入内置 UniAI-Toolkit 记录

照搬 Web 版 `tenants.py::_mcp_servers` 和 `mtstate.py::_apply_mcp_servers` 的规则，在 `prepareLocalEnvironment` 中、写模型配置和 `.env` 密钥之后执行：

```yaml
mcp_servers:
  UniAI-Toolkit:
    url: https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=${DESKTOP_MT_MAAS_API_KEY}&client_id=UniWork
    timeout: 1000
timeouts:
  tools:
    sequential_calls:
      mcp__UniAI_Toolkit__doc_translate: 1030
      mcp__UniAI_Toolkit__ai_podcast_generate: 930
      mcp__UniAI_Toolkit__txt2vid_generate: 390
      mcp__UniAI_Toolkit__img2vid_generate: 390
```

整体 `timeout` 和单工具上限对齐 UniWork（翻译 1000、播客 900、视频 360 秒，单工具再加 30 秒让工具箱自己的超时先返回）；其他元景工具沿用 Hermes 默认上限。单工具上限只在缺失时补写，旧版写入的 630 秒升级为新值，用户改过的值保留；已装专家由 `uniwork-kits` 的专家同步抄过去。

| 套餐状态 | 处理 |
| --- | --- |
| 有套餐 | 写入或更新 `url`、`timeout`；这条记录中的其他字段原样保留（如用户停用后的 `enabled: false`、工具过滤） |
| 明确无套餐 | 删除这条记录 |
| 查询失败 | 不改动 |

- 只写账号默认 Home 的 `config.yaml`，与模型配置一致；其他 Profile 不自动写入。
- YAML 读写沿用 `model-config.ts` 的方式：文件无效时报错且不覆盖，其他节点、注释和格式保留，内容不变时不写盘。
- 这条记录不是普通映射（例如使用共享引用）时保持原状，不阻断启动。
- 不做专门的所有权判断：按名称 `UniAI-Toolkit` 管理，与 Web 版一致。用户删除后，下次启动会重新写入。

验收：单元测试覆盖新建、更新时保留其他字段、其他服务不变、无套餐删除、查询失败不动、重复执行不写盘、无效文件不覆盖。

### M05：密钥打码与页面清理

- 移植 Web 版 `apps/desktop/src/dev/mcp-secrets.ts`（`3cffcc2937`）及其测试。读取 `GET /api/config`、`GET /api/mcp/servers`、`POST /api/mcp/servers` 的响应时，把密钥换成 `sk-••••••` 加后 4 位；保存 `PUT /api/mcp/servers`、`PUT /api/config`、`POST /api/mcp/servers` 时还原。遇到不是本窗口发出的打码值，拒绝保存并提示，避免把点号写进配置。
- 错误提示改为固定中文文案，不依赖 Web 版的 `browser-shell`。
- 删除连接器页的 Playwright 占位块和不再使用的文案。UniAI-Toolkit 与其他服务一样显示在列表中，可开关、测试、查看工具。
- 不做专门卡片、删除保护或保留名称校验。

验收：打码测试（移植自 Web 版）、页面测试、文案完整性测试、TypeScript 与 ESLint 通过；界面上看不到完整密钥，原样保存不会改坏 `${DESKTOP_MT_MAAS_API_KEY}` 引用。

### M06：模拟回归、人工验收与文档收尾

按用户“模拟测试即可、保持简单”的要求，实现方复用现有定向测试，不另建夹具、不启动额外 Electron 或真实远程服务。模拟检查和真实验收分别记录。

| 执行方 | 内容 |
| --- | --- |
| 实现方 | 复测账号准备、内置记录维护、打码与 preload 接线、原生管理作用域、页面及文案；更新使用文档 |
| 用户 | 登录真实账号，确认配置与页面打码、原样保存及连接测试；实际调用一次工具，再试一次远程文件长任务，观察 300 秒读取超时 |

具体人工步骤见 [USAGE.md 的 MCP 人工验收](USAGE.md#mcp-人工验收)。真实检查未执行前不标为通过，不创建 `ACCEPTANCE.md`。

## 5. 必须中途讨论的问题

遇到以下情况，停止受影响步骤，先给出证据、影响和推荐方案，等用户决定：

1. 需要修改 Hermes Python 后端、原生 MCP 路由或保存／重载／调用行为（包括放宽 300 秒读取超时）。
2. 原生链路无法满足 Profile 隔离、配置安全或密钥不外露。
3. 需要覆盖用户已有配置、移动或清理用户数据。
4. 需要修改 Hermes 后端已有文件，或增加长期维护机制（桌面前端已有文件可按需修改，见 AGENTS.md）。
5. 元景服务的地址、参数或鉴权与本文不符。

普通实现错误在范围内修复并如实汇报。无法完成的验收保留为失败或待验收，不降低断言。

## 6. 协作与交付

- 不使用子 agent，不操作用户正在使用的桌面窗口。真实运行验证使用独立目录、窗口与端口。
- 不发送真实短信、不调用付费模型；需要时由用户操作。
- 每轮只实施一个阶段，完成定向验证和本地提交后停止，用户确认后再进入下一阶段。推送每次另行授权。
- 新增命名函数附简洁中文注释。测试验证行为，不以扫描源码字符串代替。
- 按涉及范围执行 TypeScript、ESLint 和定向测试；Python 测试走 `scripts/run_tests.sh`，不直接运行裸 `pytest`。
- 提交标题用简洁中文，正文写明改动、复用点、上游文件改动原因、实际验证和限制。
- 只提交本次相关文件，保留用户已有改动、计时代码、启动器和官方版数据。

## 7. 进度与验证记录

| 步骤 | 状态 | 验证与提交 |
| --- | --- | --- |
| M01 原生链路验证 | 完成 | 原生定向 2 项通过，`61c57c499f` |
| M02 页面组织 | 完成，待人工核验 | 页面、翻译、入口定向测试通过；`77daafefae` |
| M03 复用原生管理 | 完成，待人工核验 | 控制器 3 项、页面 2 项、翻译 20 项通过；与 M02 同一提交 |
| M04 写入内置记录 | 实现完成，待实际验证 | 新模块 2 项、账号准备 2 项通过；默认 Home 接线完成 |
| M05 打码与页面清理 | 实现完成，待实际验证 | 打码及 preload 模拟 11 项、页面 2 项、文案 20 项通过 |
| M06 回归与文档收尾 | 模拟完成，真实待验收 | 复用现有 7 个文件、40 项定向测试；未启动真实服务 |

### M01（2026-10-14）

测试入口：`scripts/run_tests.sh tests/hermes_cli/test_desktop_mcp_native.py -v --tb=short --file-timeout 150 --file-retries 0`，2 项通过，无跳过和重试。

覆盖：新增配置、连接测试、WS 重载后发现并调用工具；编辑后结果更新；禁用后工具消失、再启用恢复；替换为空映射后配置与工具移除；同名服务在两个 Profile 中分别保存、测试和调用，A→B→A 结果正确；删除一个 Profile 的配置不影响另一个。

证据边界：REST／WS 使用 TestClient 与真实处理器，工具链使用真实 stdio 子进程和原版 `handle_function_call`；未启动完整 Electron 或真实 TCP 服务，未验证会话 Agent 刷新、在途调用、HTTP MCP 和 OAuth。

### M02（2026-10-14）

- 已有产品文件只改 `src/app/capabilities/index.tsx`（页面挂载、Profile 展示、连接器可见性）和 `src/i18n/{types,en,zh,zh-hant}.ts`。
- 插件声明的 MCP 单独展示为只读，不显示删除控件；折叠列表不展示命令、参数或凭据。
- 配置读取失败显示错误和重试并禁用新增；插件读取失败单独提示。
- 验证：页面 2 项、翻译 20 项、入口定向 2 项通过；完整 TypeScript、ESLint 零警告；隐藏 Electron 下浅色／深色、1000／460 像素四张截图检查通过。
- 既有失败：`index.test.tsx` 中 `keeps installed skills on their toggle and installs new cards into the pinned remote profile` 在改动前已失败（查询 `web-research` 开关时遇到两个同名元素），与本页无关，未修改。

### M03（2026-10-14）

- 修正：保存指定 Profile 的配置时，旧接线向当前聊天的 gateway 发重载；改为在 `src/api/mcp.ts` 解析同一作用域后调用已有 `requestGatewayForAgent`。修改前复现失败，修改后通过。
- 撤回尚未提交的结构化编辑、Bearer Header 补存和额外状态，直接复用原生表单与 JSON 编辑。
- HTTP 同时需要 Bearer 和其他 Header 时，原生 Bearer 输入会替换 Header；这种情况在 JSON 中填写，凭据用环境变量引用。
- 证据边界：控制器测试使用真实控制器与 API 函数、受控传输和内存配置，不是磁盘持久化或真实 Electron 端到端证明。

### M04（2026-10-14）

- 新增 `electron/entry_local/uniai-toolkit-config.ts`，在已有账号准备中、模型配置和专用 Key 写入后调用；只接收套餐状态，配置地址使用 `${DESKTOP_MT_MAAS_API_KEY}`，不接收或写入明文 Key。
- 按名称维护默认 Home 的 `UniAI-Toolkit`：有套餐更新地址和 600 秒超时，保留其他字段；空套餐删除；查询失败不动。共享或非映射记录原样跳过，无效 YAML 报错且不覆盖，内容未变不写盘。
- 复用已有 `yaml` 文档节点读写和原子文件保存，没有新依赖、Python 修改或新管理接口。只改本分支已有 `prepare-account.ts` 的调用及对应测试，不动上游 preload。
- 定向检查：新模块 2 项、已有账号准备 2 项，共 4 项通过；TypeScript、相关 ESLint 零警告和差异检查通过。测试使用临时目录与受控套餐响应，没有启动桌面、连接元景 MCP 或调用模型。
- 页面打码、删除 Playwright 占位仍属于 M05，本轮未实施。记录写入不等于远程工具可用，HTTP 300 秒读取限制不变。

### M05（2026-10-14）

- 移植 Web 版 `3cffcc2937` 的 MCP 打码规则与 9 项测试，新增模块只使用 JavaScript，不依赖 Web 桥接或 Node 能力。真实值与打码值的对应关系只留在当前窗口的隔离 preload 内存中，不写文件、不通过新增 IPC 返回页面。
- 原生 API 读取配置、服务列表及新增服务响应时打码；保存 MCP 配置、整份设置或新增服务时先还原。保留普通参数、Header、配置编辑和环境变量引用；未知打码值以固定中文提示拒绝保存，不发出 IPC 请求。没有修改 Python 保存、重载或工具运行逻辑。
- 删除 Playwright 占位及 4 个无用文案字段。UniAI-Toolkit 按普通配置显示，沿用原生开关、连接测试和工具视图，不增加特殊卡片或删除保护。
- 定向模拟共 33 项通过：移植打码 9 项、真实 preload 模块配受控 IPC 2 项、页面 2 项、文案完整性 20 项；TypeScript、相关 ESLint 与差异检查通过。
- 没有启动 Electron、连接真实元景 MCP 或调用模型。测试确认引用原样保留及展开值还原，不等于完成真实后端落盘和工具调用验收；这些保留在 M06。

### M06（2026-10-14）

- 核查基线 `0e54ac1592`，包含 M04 `30d24c8a4a`、M05 `4158867a7c`；本轮没有新增产品代码、测试或依赖，没有修改用户配置或运行实例。
- 复用已有 7 个测试文件，共 40 项通过：内置记录 2 项、账号准备 2 项、打码 9 项、preload 接线 2 项、页面 2 项、原生控制器作用域 3 项、文案完整性 20 项。配置读写使用独立临时目录；MaaS、Electron IPC 和控制器传输为受控响应。
- 覆盖套餐三态的配置维护、保留其他服务和用户停用、无效文件不覆盖、环境变量引用、密钥打码还原、未知打码值拒绝发请求、指定 Profile 保存及重载，以及原生增删改与页面控件复用。本轮未重新执行 M01 的 Python／stdio 检查，不重复计入通过数。
- 同步 README 和 USAGE，删除“打码待 M05”等过时说明，补充默认 Profile、原样保存、连接测试、工具调用和长任务的人工验收步骤。差异检查通过。
- 本轮没有启动真实 Electron、发送短信、连接元景、调用模型、执行 OAuth 或长任务；没有声称已通过完整桌面端到端验证。真实后端落盘后引用保留、元景工具发现与调用、HTTP 300 秒限制的实际影响仍待人工确认。

复测命令（在 `apps/desktop` 执行）：

```powershell
npx --no-install vitest run --project electron --project ui `
  electron/entry_local/uniai-toolkit-config.test.ts electron/entry_local/prepare-account.test.ts `
  electron/mcp-secrets.test.ts electron/mcp-secrets.preload.test.ts `
  src/app/capabilities/mcp-mt/connectors-tab.test.tsx `
  src/app/capabilities/mcp-mt/use-mcp-servers.scope.test.tsx src/i18n/catalog-completeness.test.ts
```
