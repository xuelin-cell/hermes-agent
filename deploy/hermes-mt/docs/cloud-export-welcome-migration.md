# 导出与首页配置的云端适配（2026-10-27）

## 导出

继续复用 Markdown 预览中的导出按钮、原文读取、Markdown 快照和已渲染 PDF 快照。
三个格式不是把已有文件改后缀：

- Markdown：浏览器用原文生成 UTF-8 Blob，交付下载。
- Word：桌面与浏览器共用 `apps/shared/src/preview-export.ts`，使用既有 OOXML altChunk/MHT 封装，包含内嵌图片；浏览器不依赖 Node Buffer 或 Electron。
- PDF：浏览器将既有 `captureRenderedHtml` 生成的 HTML 快照 POST 到当前用户实例的
  `/__mt_user/preview-export`，实例用 Chromium 按 A4 打印，再把字节直接交给浏览器。

PDF 请求走现有 cookie 会话和租户代理；只把实例令牌送进实例，不需要 MaaS Bearer。
转换子进程使用 Hermes Python 中已安装的 Playwright/Chromium，环境中不继承模型 Key、实例令牌或入口密钥。
关闭 JavaScript、Service Worker 和网络访问，CSP 只允许内嵌的样式、图片及字体，所有资源请求也被拦截。

单次原文/HTML 上限 8 MiB；PDF 输出上限 32 MiB；每实例同时只运行一个转换，请求体有读取超时，
转换进程有 40 秒超时。成功、失败和取消都回收子进程组及临时目录，不往会话工作区写导出中间文件。
浏览器不会在账号切换后交付迟到的 PDF，返回 `handed-off` 只表示交给浏览器下载，不表示用户已经保存到磁盘。
未能内联的外部资源在 PDF 中不再联网获取，这与桌面隔离打印策略相同。

## 首页分类与模板

页面、分类切换、模板选择和提示词填充继续复用现有实现。浏览器补齐 `getWelcomeCatalog`，
通过固定 Entry 业务路由 `/__entry/welcome/zh-CN`、`/__entry/welcome/en`，复用桌面
`WelcomeCatalogClient` 的 V3 记录选择、8 秒请求超时、版本字段和目录校验。

入口校验 cookie + Bearer + 加密登录关联证明，请求前后检查登录是否仍有效。
语言只接受 `zh-CN`、`en`，不接受用户传上游 URL、配置 key 或其他账号信息。
页面缓存改为按云端登录代次和语言隔离；桌面缓存键不变。失败保留本登录上次成功的目录，
不清空输入框，不认领旧桌面缓存或其他登录的目录；账号变化时丢弃旧请求结果。
首次无有效缓存且请求失败时仍按现有页面显示缺少配置，不伪造服务端模板。

## 验证与发布

验证包括桌面导出封装/IPC、浏览器下载、已有首页交互、缓存 A→B→A 和迟到响应；
入口用真实 PG/Node 客户端和本地 MaaS 协议替身验证首页鉴权，PDF 用真实 Chromium 和实际转发器 HTTP 接口验证。
真实公司 MaaS 配置和 Cube 模板仍需部署后验收。

两项需要配套更新前端与入口。PDF 还新增了实例 seed 文件 `mtexport.py`，并修改转发器；
必须提交推送新增文件，再执行 `deploy.sh all --branch cloud-adaptation` 更新实例模板。
Docker 后端的运行文件分发也已加入新文件；不新增数据库迁移。
部署后用测试账号验证首页中英文目录、模板填入，并用含中文、图片、公式和代码块的 Markdown
分别导出三种格式；最后核对 PDF 与页面内容、Word 在目标办公软件中的显示。
