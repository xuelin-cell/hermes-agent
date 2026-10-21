# 推荐连接器完整接入

基线：`hermes-sub @ 601c4927a5`（已合并 release）。

目标：Hermes Python 后端保持不变，迁入独立 OpenConnector 服务，Electron 管理账号／Profile 隔离、进程和受限 IPC，使用原生 MCP 管理接口登记服务；推荐页的加号用于连接，卡片详情采用 HexAgent 的连接按钮和使用示例。

实现顺序：

- [ ] 将 HexAgent 中实际使用的 OpenConnector 运行时代码及推荐 Provider 迁入 `apps/desktop/services/open-connector`，保留来源、许可证及锁文件；不带用户数据和依赖目录。
- [ ] Electron 新增独立连接器模块：认证服务进程、加密存储、启动探活与退出、原生 MCP 配置接入、账号／Profile 路由。
- [ ] 受限 IPC 暴露列表、连接、OAuth 和解绑；不向 Renderer 暴露管理令牌、任意请求 URL 或本机目录。
- [ ] 对齐 HexAgent 的卡片加号、连接凭据表单、OAuth 轮询、详情、使用示例和已连接状态。
- [ ] 独立临时目录验证真实服务握手／MCP 调用、隔离与退出；前端定向测试、类型和视觉验证。真实第三方账号授权由用户验收，不调用付费模型。

范围说明：OpenConnector 属于独立服务模块，Electron 只管理它，不把第三方适配逻辑放入 Hermes 核心。先支持本机连接；远程 Hermes 无法访问本机回环服务，不把它写到远端配置。
