-- 数据面流量令牌（network.allowPublicTraffic=false 时平台给每台实例发的 token）。
-- 只在创建响应里返回一次，查询接口不返回，所以入口要自己留一份；Fernet 加密，和容器令牌同一把主密钥。
-- 实例没了（sandbox_id 清空）就一起清掉。
ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS traffic_token_ciphertext BYTEA;
