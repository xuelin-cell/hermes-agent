-- 统一登录（MT_SSO=1，见 entry/sso.py）。
--
-- device_token_revocations：企业员工退出时平台连不上，设备令牌没吊销掉。令牌加密转存到这里由后台重试，
--   直到平台确认吊销（或回 401：令牌本来就失效了）；入口自己不再用它（tenant_credentials 里清掉了）。
--   attempts / last_error 只给排查看；next_attempt_at 按次数退避。
--
-- enterprise_binding 按（企业, 成员 ID）查：统一登录后身份头里只有成员 ID，要靠它找回以前登录过的员工。

CREATE TABLE IF NOT EXISTS device_token_revocations (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_ciphertext BYTEA NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_token_revocations_due_idx ON device_token_revocations(next_attempt_at);
CREATE INDEX IF NOT EXISTS device_token_revocations_user_idx ON device_token_revocations(user_id);
CREATE INDEX IF NOT EXISTS enterprise_binding_member_idx ON enterprise_binding(tenant_id, member_id);
