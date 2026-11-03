-- 用户手动指定的模板 ID（tpl-…）。非空 = 用它建实例，忽略 spec；空 = 走规格下拉。
-- 与 spec 互斥：登录时填了 manual_tpl_id 就把 spec 清空，反之亦然。
ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS manual_tpl_id TEXT;
