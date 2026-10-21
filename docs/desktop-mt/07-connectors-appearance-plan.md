# HexAgent 连接器页面外观迁移

目标：保持 Hermes Python 后端不变，将桌面连接器页面调整为 HexAgent 的推荐卡片与 MCP 双标签布局。

实现：新增 `mcp-mt/connectors-page.tsx` 和推荐目录组件；复用现有 `McpConnectorsTab`，所有 MCP 操作仍走原生控制器。推荐卡片只展示目录和详情，明确提示授权服务尚未接入，不收集凭据或模拟已连接。

- [x] 迁入 HexAgent 本地图标及中英文目录文案，补齐繁体中文。
- [x] 实现推荐卡片、搜索、详情弹窗、双标签，保留 MCP 深链和 Profile 范围。
- [x] 定向验证搜索、切换、详情及原生 MCP 操作；执行 TypeScript、ESLint 和独立隐藏窗口视觉检查。
- [x] 记录实际验证结果并创建本地中文提交，不推送。

范围：只修改桌面 Renderer、静态资源及本文档；不实现 OpenConnector 安装、授权、状态查询或边车。

## 验证记录（2026-10-16）

- 基线：`hermes-sub @ 447e6587bc`，当时与 `origin/release` 对齐。
- 4 个定向文件共 28 项通过：推荐目录交互 2 项、原生 MCP 页面 3 项、控制器作用域 3 项、文案完整性 20 项。覆盖搜索、尚未接入的详情、深链、键盘切换、保留草稿及原生开关／测试／插件只读边界。
- `npm.cmd run typecheck` 完整通过；相关 TypeScript 文件 ESLint 零错误、零警告；`git diff --check` 通过。
- 扩展已有 `scripts/mcp-connectors.renderer.mjs`，使用独立临时目录、随机端口、受控配置和隐藏 Electron 窗口，实际渲染页面及原生工具视图；浅／深色 × 1400／1000／460 像素六种组合、图标加载、详情及 MCP 入口通过，无页面异常和横向溢出。人工查看三列浅色、窄屏深色及详情截图。首次在受限环境启动 Electron 时 GPU 子进程失败，获准在沙箱外运行后通过；Vite 的依赖动态导入提示不影响验收。
- 未操作用户已打开的桌面窗口，未连接真实 MCP、调用模型或验证推荐项授权。Python 后端和 Electron 产品代码均未修改。

复测命令（`apps/desktop`）：

```powershell
npx.cmd --no-install vitest run --project ui src/app/capabilities/mcp-mt/connectors-page.test.tsx src/app/capabilities/mcp-mt/connectors-tab.test.tsx src/app/capabilities/mcp-mt/use-mcp-servers.scope.test.tsx src/i18n/catalog-completeness.test.ts
npm.cmd run typecheck
node scripts/mcp-connectors.renderer.mjs
```
