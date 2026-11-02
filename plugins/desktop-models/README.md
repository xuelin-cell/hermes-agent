# 桌面模型连接检测

`POST /api/plugins/desktop-models/validate?profile=<当前 Profile>` 接收原版 `CustomEndpointUpdate`，复用原版模型目录与传输路由探测，不修改 Hermes 核心。

- 页面填写了新 Key：只用于本次草稿检测，不保存。
- 没有新 Key：按本 Profile 的端点 ID 读取已保存凭据，密钥不返回页面。
- 修改了端点地址：需要重新填写 Key；不将旧地址的凭据带到新地址。
- 真实的鉴权拒绝、网络错误与传输检测结果仍由原版探测返回。检测不等于完整模型聊天验收。

插件由正式后端插件发现机制挂载，源码启动构建会将其纳入现有 Python 插件资源；完整退出并重开开发版后生效。

验证：`scripts/run_tests.sh tests/plugins/test_desktop_models_validation.py -j 1 --file-retries 0 -q --tb=short`。7 项通过，使用临时 Profile、真实路由发现和原版探测，外部服务由受控 HTTP 传输回答；覆盖 A→B→A、新 Key、地址更换、鉴权失败、文件不变和响应不泄露密钥。另有页面与 API 路由测试 4 项通过。未调用真实模型或操作用户桌面。
