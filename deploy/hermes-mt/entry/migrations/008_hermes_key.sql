-- 实例里的 hermes 是用哪把模型 key 启动的（key 的 sha256，十六进制；不存 key 本身）。
--
-- hermes 连元景 MCP 时把地址里的 ${KEY} 展开成当时的 key，之后只换环境变量换不掉它。企业模式每次登录
-- 都会换设备令牌（平台吊销旧的），入口比对这一列：不一样就调转发器的 /__mt/reload，重写配置并重启 hermes。
-- 新建实例时清空，引导成功、重新加载成功时写入。为空（入口升级前建的实例）就不比对。

ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS hermes_key_sha256 TEXT;
