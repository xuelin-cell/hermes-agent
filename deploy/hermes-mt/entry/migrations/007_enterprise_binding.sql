-- 企业模式（入口配了 MT_UNIWORK_SERVER）：每个用户在 UNIWORK 企业管理平台上的绑定。
--
-- 一行 = 平台上的一个设备，也就是这个用户在某个企业里的成员身份。企业模式下的 user_id 由企业 ID 和
-- 元景 uid 组成，同一个人在不同企业里是不同的用户、不同的实例和数据。
-- 设备令牌就是实例用的模型 key，加密存在 tenant_credentials.api_key_ciphertext 里，这里不再存一份。
--
--   access_status    active 才放行。其余是拦截原因：平台给的 pending / not_member / rejected / disabled / no_seat /
--                    tenant_suspended，以及入口自己的 unbound（设备令牌已失效：在别处重新登录、被管理员重置或
--                    已退出），要重新登录。
--   policy_revision  平台策略的版本号，以后长轮询 /api/client/events 时用。
--   checked_at       最近一次从平台拿到状态的时间。

CREATE TABLE IF NOT EXISTS enterprise_binding (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    tenant_code TEXT NOT NULL DEFAULT '',
    tenant_name TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL,
    device_id TEXT NOT NULL,
    member_id TEXT NOT NULL DEFAULT '',
    member_name TEXT NOT NULL DEFAULT '',
    access_status TEXT NOT NULL,
    policy_revision TEXT NOT NULL DEFAULT '',
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
