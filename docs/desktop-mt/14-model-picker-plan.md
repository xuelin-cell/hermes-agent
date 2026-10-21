# 输入框模型选择与上下文用量（对齐 UniWork）

日期：2026-10-21。状态：已按方案实施，验证边界见文末；仅本地提交，不推送。

本文档写给执行改造的编码代理。**一次改完，合并为一个本地提交，不推送。**

## 0. 动手前必读

1. 先读 `AGENTS.md`、`AGENTS.local.md`（本机未跟踪文件，规则同样有效）和 `docs/desktop-mt/README.md` 的“协作规则”一节，全部遵守。重点：
   - 不改 Hermes 核心已有文件（`agent/`、`tools/`、`gateway/`、`hermes_cli/` 等）；
   - 每个新增函数或方法都要有简洁中文注释；
   - 提交标题和正文用中文，正文最后用一句话统计代码变化，格式见 `AGENTS.local.md`；
   - 不使用子 agent，不操作用户正在使用的桌面窗口。
2. 工作区里已有与本次无关的未提交改动：`apps/desktop/scripts/account-*.mjs`、`login-renderer.fixture.mjs` 等账户计时脚本。**不要修改、暂存或提交它们。** 提交时只 `git add` 本次改动的具体文件。
3. 本文档随本次提交一起入库。

## 概述

普通模式下，聊天输入框的模型下拉改成 UniWork 样式：平铺列表，每行显示名字、上下文大小和能看图图标。模型按钮左边加一个 UniWork 样式的上下文圆环，点开是 Hermes 原有的分类明细。

规则方面，在输入框里选的模型只用于当前对话，点“新对话”后回到设置里的默认模型。

底层同时修正三件事：
- 套餐模型的上下文上限；
- 能看图的标记；
- 关闭 Hermes 借用本机 Claude Code 登录的行为。

开发者模式的下拉菜单保持原样。不改 Python。

## 已确认的决定

| 项 | 决定 |
| --- | --- |
| 上下文圆环 | 放在输入框里模型按钮左边，18 像素灰色圆环。悬停显示 `12.3% · 37.0K / 300.0K 上下文已使用`，估算值前加 `~`。点击弹出 Hermes 的分类明细。新对话显示 0。切换模型后立刻按新上限重算。普通模式和开发者模式都显示 |
| 下拉列表（普通模式） | 平铺，不分组。只列设置 → 模型里的模型（套餐模型和自定义模型），顺序与设置页一致，默认模型在第一个。每行依次是名字、上下文大小（如 `300K`）、能看图图标、当前项打勾。超过 8 个模型才显示搜索框 |
| 普通模式去掉的 | 刷新模型、添加自定义模型、编辑模型、多模型混合、价格、悬停调思考强度、钉住小圆点、“使用设置中的默认模型” |
| 保留的 | “模型名 · 思考强度”合一的按钮；`Ctrl+Shift+M` 打开下拉；状态栏里原有的上下文项 |
| 开发者模式 | 下拉菜单不变 |
| 选模型的规则 | 选的模型只用于当前对话；进入新对话（包括重启后的空白对话）回到默认模型；两种模式都这样 |
| 上下文上限 | DeepSeek V4 Flash 30 万、GLM-5.2 24 万写死，与 UniWork `model_policy.py` 相同；其他套餐模型用套餐接口给的 `context_window`（V4.1 Flash 是 30 万）；自定义模型用设置里填的数 |
| 能看图 | 按套餐接口的 `supported_modalities` 写入，V4.1 Flash 标为能看图 |
| 借用外部登录 | 在账号配置里写 `auth.adopt_external_logins: false`。下拉里不再出现 Anthropic，也不会挤掉用户的 Claude Code 登录。已显式写过这个值的不覆盖 |
| 快速模型 | 不处理，当前套餐里没有 |

## 已核实的接口

| 内容 | 位置 |
| --- | --- |
| 套餐接口每个模型带 `context_window`、`supported_modalities`，目前只读了 `id`、`model`、`base_url` | `apps/desktop/electron/login/plan.ts` 的 `parsePlan` |
| 套餐模型写进 `config.yaml` 的 `providers.<desktop-mt-maas-…>.models.<模型名>`，目前是空对象 | `apps/desktop/electron/entry_local/model-config.ts` 的 `mergeMaasModelConfig` |
| Hermes 读 `providers.<id>.models.<模型名>.context_length` 作为上下文上限，优先于自带表 | `hermes_cli/config_providers.py` 的 `get_custom_provider_context_length` |
| 设置页保存自定义模型时，后端同时写端点级和模型级的 `context_length`；看图开关是模型级的 `supports_vision` | `hermes_cli/web_routers/config_env.py`、`models-mt/catalog.ts` 的 `visionOf` |
| 设置页的行、默认行、排序：`rowsFromEndpoints`、`currentRowKey`、`orderRows`；顺序存在 localStorage 的 `uniwork.desktop.models.order.v1:<profile>` | `models-mt/catalog.ts`、`models-mt/models-settings.tsx` 的 `readOrder` |
| 选模型：`useModelMenuController(props)` 返回 `{ activeSessionId, controller, defaultEffort, modelOptions }`；原菜单选中时先 `controller.select` 再 `controller.applyPreset` | `src/app/shell/use-model-menu-controller.ts`、`model-catalog-menu.tsx` 的 `selectFamily` |
| 手动选择会沿用到新对话：手动选过时 `getCurrentModelSource()` 为 `'manual'`，进入空白新对话时 `refreshCurrentModel()` 会跳过 | `src/store/session.ts`、`src/app/contrib/hooks/use-background-sync.ts` 中注释为 “A fresh new-session draft …” 的 `useEffect` |
| 输入框 `ChatBar` 的 props 里有 `gateway` 和 `sessionId`（运行时会话 id），主会话和并排窗格都会传 | `src/app/chat/composer/index.tsx` |
| 上下文明细：`gateway.request('session.context_breakdown', { session_id })`，返回 `ContextBreakdown`；面板组件 `ContextUsagePanel` 可直接复用 | `src/types/hermes.ts`、`src/app/shell/context-usage-panel.tsx` |
| 用量：主会话 `$currentUsage`；并排窗格 `$sessionStates[runtimeId].usage` | `@/store/session`、`@/store/session-states` |
| 名字美化 `prettifyModelId`，三个套餐模型得到 `DeepSeek V4 Flash`、`DeepSeek V4.1 Flash`、`GLM 5.2` | `models-mt/model-name.ts` |
| 本模块文案写法：`registerPluginLocales` + `usePluginI18n`，提供 en、zh、zh-hant | 参照 `models-mt/copy.ts` |

## 1. 改动内容

### 第 1 项：套餐模型补上下文上限和看图标记（Electron）

`apps/desktop/electron/login/plan.ts`：

- `MaasModel` 加可选的 `contextWindow?: number`、`vision?: boolean`。
- 加固定表 `{ 'deepseek-v4-flash': 300_000, 'glm-5.2': 240_000 }`，模型名转小写后查表。
- 上限的取法：
  - 固定表优先；
  - 其次套餐的 `context_window`，接受正整数或纯数字字符串；
  - 都没有就不写这个键。
- 看图：`supported_modalities` 是数组时，按是否含 `image` 给 true 或 false；不是数组时不写这个键。

`apps/desktop/electron/entry_local/model-config.ts`，在每个套餐模型的选项上：

- 有上限就写 `context_length`，没有就删掉旧值（上限由套餐托管）；
- `vision` 为 true 时写 `supports_vision: true`，为 false 时删掉，未声明时不动；
- 选项里的其他键保留；
- 原来“没有才建空对象”的逻辑改为“取已有的普通映射，没有再新建”。

### 第 2 项：关闭借用外部登录（Electron）

还是 `model-config.ts`，写回文件前：

- 没有 `auth` 节点时，写 `auth: { adopt_external_logins: false }`；
- `auth` 是普通映射且没有这个键时，补上 `false`；
- 其他情况（已显式设置、`auth` 不是普通映射）不动。

重复执行时文件字节不变，这个现有性质要保持。

### 第 3 项：读取模型配置（列表和圆环共用）

- `models-mt/catalog.ts`：导出 `providerIdOf`；把 `readOrder` 和 `ORDER_KEY` 从 `models-settings.tsx` 搬过来导出，`models-settings.tsx` 改为导入，行为不变。
- 新增 `src/app/chat/composer/model-mt/model-meta.ts`：
  - 纯函数 `buildComposerModelMeta(response, providers, savedOrder)` 返回有序的模型行，每行含 `key`、`endpointId`、`provider`（`custom:<endpointId>`）、`model`、`name`、`contextWindow`、`vision`、`plan`；
  - 名字：套餐行用 `prettifyModelId`；自定义行用设置里的显示名，空了再美化；
  - 上下文：模型级 `context_length` 优先，其次端点级。
- Hook `useComposerModelMeta()`：
  - 用 `useQuery` 请求，`queryKey` 以 `'model-options'` 开头：`['model-options', 'desktop-mt-meta', profile]`。这样设置页保存后已有的刷新会一起刷新它；
  - profile 用 `$settingsRequestProfile`，与设置页一致，排序的存储键才能对上；
  - 请求与设置页相同：`getCustomEndpoints` 和 `getHermesConfigRecord(profile, { includeDefaults: false })`；
  - 提供 `find(provider, model)`，用 `providerIdOf` 比较 provider。

### 第 4 项：上下文圆环

新增 `src/app/chat/composer/model-mt/` 下三个文件。

**`context-usage.ts`**（纯函数）：

- 数字格式：小于 1000 显示整数；千位保留 1 位小数加 `K`；百万位保留 1 位小数加 `M`。例如 `37.0K`、`300.0K`、`1.5M`。
- 上限取法：先用配置上限（第 3 项），没有再用后端的 `context_max`，都没有就不显示圆环。
- 已用取法：新对话为 0；否则先用明细的 `context_used`，其次用量里的 `context_used`。
- 百分比保留 1 位小数；圆环进度封顶 100。

**`use-context-usage.ts`**：

- 按 `useSessionView()` 区分主会话和并排窗格，取对应的用量。
- 不忙时自己请求 `session.context_breakdown`，依赖里包含模型和 provider，切换模型后会重新取。上游的 `useContextBreakdown` 不改也不用。
- 交给面板的 `usage` 用圆环的数字覆盖 `context_used`、`context_max`、`context_percent`、`context_estimated`，保证面板头部和圆环一致。

**`context-ring.tsx`**：

- 外观照 UniWork `ContextUsageRing`：SVG `viewBox="0 0 32 32"`，`r=11.5`，线宽 3.5，旋转 -90°；底圈用 `--ui-stroke-tertiary`，进度圈用当前文字色 `--ui-text-tertiary`，圆头。
- 样式写在组件里，不改 CSS 文件。
- 悬停用 `Tip`；点击用 `Popover` 弹出 `ContextUsagePanel`。
- 写好 `aria-label`。

接入（上游文件，标注 `// desktop-mt:`）：

- `composer/controls.tsx`：加可选 prop `contextRing`，放在 `data-slot="composer-model-group"` 之前，`compactModelPill` 时不显示。
- `composer/index.tsx`：传入 `<ComposerContextRing busy gateway sessionId />`。

### 第 5 项：普通模式的模型列表

新增 `src/app/chat/composer/model-mt/model-list.tsx`，组件 `ComposerModelList`，props 与 `ModelMenuPanel` 相同，但没有 `onFollowDefaultModel`。

- 行只来自第 3 项的配置行，不渲染 `modelOptions` 里的其他提供方。当前模型不在配置里时，在最前面补一行，保证打勾和按钮一致。
- 每行用 `DropdownMenuItem` 和 `dropdownMenuRow` 类：
  - 名字（截断）；
  - 上下文小标签：规则同 UniWork `formatContextSize`，如 `300K`、`1M`；
  - 能看图时显示 `ImageIcon`；
  - 当前项 `Check`，非当前项留同宽空位。
- 当前项判断：`providerIdOf` 后的 provider 和模型名都相同。
- 选中时与原菜单 `selectFamily` 一致：先 `controller.select`，成功后 `controller.applyPreset`。思考强度和快速模式按 `currentModelCapabilities` 判断给不给。
- 超过 8 个才显示 `DropdownMenuSearch`，按名字和模型 id 过滤。
- 加载中显示“正在加载模型…”，没有模型显示“暂无可用模型”，搜索无结果显示“未找到模型”，都是禁用行。

接入（上游文件，标注 `// desktop-mt:`）：

- `contrib/surfaces.tsx` 和 `chat/session-tile.tsx` 的 `modelMenuContent`：开发者模式用原 `ModelMenuPanel`，普通模式用 `ComposerModelList`，参数照原样传。思考强度菜单不动。
- `composer/model-pill.tsx`：
  - 普通模式不显示钉住小圆点；
  - 普通模式下模型为空时显示“正在加载模型…”文字，代替转圈；
  - 按钮文字不改。

### 第 6 项：选的模型只用于当前对话

新增 `src/app/chat/composer/model-mt/new-chat-model.ts`：

- `resetComposerModelForNewChat()`：来源是 `'manual'` 时改成 `'default'`。
- `useResetComposerModelOnNewChat(activeSessionId, freshDraftReady)`：只在“不是新对话 → 新对话”的那一刻调用一次重置。用 `useRef` 记上一次的状态。

`contrib/hooks/use-background-sync.ts`（上游，标注 `// desktop-mt:`）：

- 在注释为 “A fresh new-session draft …” 的 `useEffect` **之前**调用这个 hook。
- React 按声明顺序执行 effect，所以会先清掉“手动”记号，随后的 `refreshCurrentModel()` 就会读回默认模型。

已知边界：已经在空白新对话里再点一次“新对话”，或者断线重连，都不算“进入新对话”，刚选的模型不会被重置。

### 第 7 项：文案

新增 `src/app/chat/composer/model-mt/copy.ts`，作用域 `desktop-mt.composer-model`。

| 键 | 简体 |
| --- | --- |
| loading | 正在加载模型… |
| empty | 暂无可用模型 |
| search | 搜索模型 |
| noMatch | 未找到模型 |
| contextTooltip | `{百分比}% · {已用} / {上限} 上下文已使用` |
| contextAria | `上下文已使用 {百分比}%，{已用} / {上限} tokens` |
| contextChip | `{大小} 上下文` |

繁体、英文对应翻译。

## 2. 测试要求

每项都要有自动测试，测试标题用中文。

| 项 | 测试位置 | 必须覆盖 |
| --- | --- | --- |
| 1 | `electron/login/plan.test.ts` | 固定表覆盖套餐值（V4 Flash 给 10 万仍得 30 万）；GLM-5.2 得 24 万；V4.1 Flash 用套餐的 30 万；数字字符串接受；`0`、负数、小数、非数字不产生键；`["text","image"]` 为 true，`["text"]` 为 false，缺字段不产生键 |
| 1、2 | `electron/entry_local/model-config.test.ts` | 写入上限和看图；套餐不再给上限时删掉旧值；看图未声明时保留原值；选项里其他键保留；新文件和没有 `auth` 的旧文件写入 `false`；已写 `true` 的保持；连续执行两次字节不变。已有断言只为新字段做必要调整 |
| 3 | `model-mt/model-meta.test.ts` | 默认排第一、其余按保存顺序；名字规则；模型级上限优先于端点级；看图 |
| 4 | `model-mt/context-usage.test.ts` | `999`、`37.0K`、`300.0K`、`1.5M`；百分比 1 位小数；圆环封顶；没有上限不显示；新对话为 0；配置上限优先于后端；估算标记 |
| 4 | `composer/controls.test.tsx` | 传了圆环时显示；`compactModelPill`、`minimal`、`hideModelPill` 时不显示 |
| 5 | `model-mt/model-list.test.tsx` | `modelOptions` 里有 Anthropic 也只显示配置行；超过 8 个才有搜索；选中时收到 `custom:<id>` 和模型名；当前项打勾；加载中、空列表的文案；当前模型不在配置里时补一行 |
| 5 | `composer/model-pill.test.tsx` | 普通模式没有小圆点；普通模式无模型时显示加载文字；开发者模式原有测试全部通过 |
| 6 | `model-mt/new-chat-model.test.tsx` | 从会话进入新对话时 manual 变 default；新对话里重新渲染不重置；新对话里选了模型后重新渲染仍是 manual；进入会话不重置 |

## 3. 不在本次范围（不要改）

| 内容 | 不改的原因 |
| --- | --- |
| 开发者模式的模型菜单、状态栏上下文项 | 保留 Hermes 原样 |
| 模型按钮的文字和思考强度按钮 | 2026-10-20 已按 Claude 样式调整过，保持现状 |
| 隐藏快速模型 | 当前套餐没有快速模型 |
| 套餐模型显示名用套餐的 `display_name` | 美化后的名字已与 UniWork 一致 |

## 4. 验证与提交

1. 桌面端（`apps/desktop/`）：
   - 用 vitest 运行改动涉及的测试文件，以及 `src/app/chat/composer/`、`src/app/settings/models-mt/`、`src/app/shell/`、`src/app/contrib/`、`electron/login/plan.test.ts`、`electron/entry_local/model-config.test.ts`；
   - `npm run typecheck`；
   - 对改动文件运行 ESLint，要求零警告；
   - `git diff --check`。
2. 只提交一个 commit，标题建议：`feat(desktop): 输入框模型选择和上下文用量对齐 UniWork`。正文按 `AGENTS.local.md` 的要求分段写清：原来的问题、现在的处理、边界、实际验证结果、未验证的部分，最后一句统计代码变化。
   - 未验证的部分至少包括：登录后的桌面窗口里没看过；没有发真实消息看圆环的实际数字。
   - 已有账号要在下次启动或登录、重新写入套餐配置后，才会带上上限和 `auth` 设置。这一点也要写进正文。
3. **不要推送。**

## 5. 预计改动规模

| 类别 | 新增 | 删除 |
| --- | --- | --- |
| 产品代码 | 约 680 行，九成以上在新文件里；上游已有文件约 20 行，分布在 `controls.tsx`、`composer/index.tsx`、`surfaces.tsx`、`session-tile.tsx`、`model-pill.tsx`、`use-background-sync.ts` | 少量 |
| 测试 | 约 430 行 | 少量 |
| 文档 | 本文件 | 无 |

如果实际改动明显超出预计，在提交正文中说明原因。

## 6. 实施与验证记录

- 已完成套餐元数据和账号配置写入、普通模式模型列表、上下文圆环、新对话恢复默认模型，以及三种语言文案。开发者菜单、思考强度入口和状态栏保持原逻辑，未修改 Python 核心。
- 定向测试 9 个文件、52 项通过；另补齐既有剪贴板和路由测试的受控模型依赖，5 个文件、9 项复测通过，原行为断言未降低。
- 完整 TypeScript 检查、改动文件 ESLint 零警告、Prettier 和 Git 差异检查通过。
- 扩大回归发现既有套餐卡片日期断言受本机时区影响：本机时区下 3 项通过、1 项失败；仅测试进程改用 UTC 后 4 项通过。本次不修改该产品行为或日期断言。
- 补齐上述测试依赖后，以 `TZ=UTC` 重跑本文第 4 节指定的全部目录和两个 Electron 文件：129 个文件、928 项全部通过。最终完整 TypeScript 检查再次通过。
- 没有操作登录后的用户桌面窗口，没有发送真实模型消息确认圆环数字。已有账号要在下次启动或登录并成功重新写入套餐配置后，才带上新的上限和 auth 设置；已有显式 auth 值不覆盖。
