-- 平台调用云端运行智能体（docs/企业版对接/15）：每个运行环境一行。
--
-- 运行环境在云端就是一个「用户」：user_id = svc:<企业ID>:<runtimeKey>，卷、实例、网络和成员一样隔离；
-- 设备令牌由平台在每次 PUT 里给，和成员一样加密存在 tenant_credentials.api_key_ciphertext。
--
--   persona         平台策略 agentProfile.instructions，写进实例的 SOUL.md（每次同步都覆盖）
--   spec_sha256     实例里当前生效的人设 + 模型 + 令牌的摘要；变了就重新加载实例
--   current_run_id  正在跑的那次运行（hermes 的 run_id）；同一个运行环境同时只跑一个

CREATE TABLE IF NOT EXISTS service_runtime (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    tenant_code TEXT NOT NULL DEFAULT '',
    runtime_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL DEFAULT '',
    spec_sha256 TEXT NOT NULL DEFAULT '',
    current_run_id TEXT,
    run_started_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, runtime_key)
);
