-- 沙箱后端：记住每个用户当前那个实例的平台 ID。
--
-- Docker 后端不用这一列（容器名是我们按用户算出来的，不需要存）；
-- 沙箱后端必须存，因为实例 ID 是平台下发的不透明值，我们算不出来。
--
-- ★ 这一列是**易变的**：实例会因为闲置回收、节点维护、崩溃而换一个新 ID。
--   用户的数据不在实例上，而在按用户 ID 命名的持久卷上 —— 卷名我们自己定，
--   所以不需要再存一份「用户 → 卷」的映射。
--   详见 docs/Hermes多租户-Cube架构说明.html §4.3。

ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS sandbox_id TEXT;

-- 按实例 ID 反查用户：平台回调或巡检时会拿着实例 ID 来问「这是谁的」。
CREATE INDEX IF NOT EXISTS tenant_runtime_sandbox_idx
    ON tenant_runtime(sandbox_id)
    WHERE sandbox_id IS NOT NULL;
