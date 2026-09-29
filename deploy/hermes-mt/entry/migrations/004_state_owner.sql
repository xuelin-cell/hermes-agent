-- 持久化存储：PG 记「谁说了算」。
--
-- 用户的状态归档放在他自己的 S3 卷上，按实例分目录（.state/e<编号>-<实例ID>/）。
-- 哪一份归档是权威的、新实例该从哪一代恢复，由这里的记录决定：
--   state_epoch   只增不减的编号，每建一台实例加 1，写进归档目录名。卷上的 OWNER 编号
--                 不小于新实例的编号，就说明这里的记录丢失或回滚过，新实例会拒绝启动。
--   state_owner   当前主人：最近一次成功引导（恢复完成）的实例 ID。
--   state_archive 最近一次确认过的归档文件名；state_manifest 是它的清单摘要（行数、哈希）。
--   template_id   实例是用哪个模板建的；与当前配置的模板不一致就在用户空闲时重建。
--   lifecycle     生命周期阶段：'' / draining / drained / deleting。删实例只能从 drained 走。

ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS state_epoch INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS state_owner TEXT,
    ADD COLUMN IF NOT EXISTS state_archive TEXT,
    ADD COLUMN IF NOT EXISTS state_manifest JSONB,
    ADD COLUMN IF NOT EXISTS state_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS template_id TEXT,
    ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT '';

-- 建过的每一台实例。清理孤儿实例、事后追溯「这台实例是谁的」都靠它。
CREATE TABLE IF NOT EXISTS sandbox_history (
    sandbox_id    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    template_id   TEXT,
    state_epoch   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    delete_reason TEXT
);

CREATE INDEX IF NOT EXISTS sandbox_history_user_idx ON sandbox_history(user_id, created_at DESC);
