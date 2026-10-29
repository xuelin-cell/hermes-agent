-- 每个租户当前使用的沙箱规格（slug，如 1c2g）。登录时选，下次登录可改。
-- 改了规格 = 改了模板 ID = 走原来的「模板不一致就重建」流程，不需要新生命周期。
ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS spec TEXT;
