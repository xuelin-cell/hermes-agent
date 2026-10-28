# MaaS DeepSeek 工具参数兼容

通过官方 `ProviderProfile.create_client()` 插件入口接入，不修改 Hermes 核心、工具定义、权限检查或执行流程，不增加依赖或代理服务。

只在以下条件同时满足时启用：

- 自定义提供方地址为 `https://maas-api.ai-yuanjing.com/openapi/compatible-mode/token-plan/v1`。
- Chat Completions 请求模型为 `deepseek-v4-flash`。
- 服务端明确以 `finish_reason: tool_calls` 完成工具调用。
- 参数为一个完整 JSON 对象，后面恰好多出一份 JSON 空字符串 `""`（允许对象与尾缀间有空白）。

例如，`{}""` 转为 `{}`，`{"category":"office"}""` 转为原对象。对象内字段、字符串和数值不改动；正常参数原样保留。第二个对象、非空字符串、任意文字、不完整参数、`length`、缺少结束信号或流中错误均不据此修复。后续继续由 Hermes 处理校验、重试和工具执行。

流式处理即时传递正文、思考和工具身份；参数等到结束原因明确后交回原版累加器。缓存仅属于当前请求，不跨账号或轮次共享；HTTP 关闭、取消和错误继续沿用 SDK。其它地址和模型不启用修正。

## 原因与验收

2026-10-28 的本机诊断中，MaaS 原始 SSE 将 `skills_list` 参数依次返回为 `{}`、`""`，正常结束原因为 `tool_calls`，输出仅 55 tokens。Hermes 原版无法解析拼接后的 `{}""`，继而将其标为截断并重复请求。这份证据不能区分缺陷位于模型还是 MaaS 服务端转换层，也不能推断总体发生概率。

使用独立测试环境运行：

```bash
scripts/run_tests.sh tests/plugins/model_providers/test_maas_tool_arguments.py -j 1 --file-retries 0 -q --tb=short
```

测试经过正式提供方发现、真实 OpenAI SDK、原版参数累加器，并完整执行原版 Agent 的 `skills_list` → 工具结果 → 后续回答，供应商响应与凭据受控。覆盖分片、交错工具、请求隔离、真正截断、错误与提前关闭；不代表真实 MaaS 修复后的人工聊天已经验收。

2026-10-28 最终定向检查：新增 30 项通过；原有自定义提供方、客户端插件入口和禁用 SDK 叠加重试的 29 项回归通过。Ruff、格式、语法及 Git 差异检查通过。修复前三个异常参数用例均复现截断；补充测试曾因夹具误用 SDK 原始响应的关闭接口失败，修正夹具后复跑通过，没有改变产品断言。

源码开发版完整退出并重开后加载插件，无需修改账号配置；本次没有制作安装包。
