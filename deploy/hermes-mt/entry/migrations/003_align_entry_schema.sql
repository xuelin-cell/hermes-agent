-- 把已经建好的库对齐到 001 的当前内容。
--
-- 为什么需要这一份：迁移是按文件名记录在 schema_migrations 里的，改动
-- 001_initial.sql 只对**还没建过库**的环境生效；已经跑过 001 的库不会重跑，
-- 于是代码期望的结构和库里实际的结构会分叉。分叉的表现不是报错而是插入失败
-- （比如 tenant_credentials.encryption_key_id 是 NOT NULL 且无默认值，
-- 新代码的 INSERT 不再带它，会直接违反约束）。
--
-- 三处对齐，逐条都写成可重复执行的形式：
--   1. users.display_name  重命名为 masked_phone（保留已有数据）
--   2. 删除不再写入的 users.updated_at 和 tenant_credentials.encryption_key_id
--   3. tenant_runtime.state 收敛为 starting / running / stopped，去掉默认值
--
-- ★ 删除 encryption_key_id 不影响已存的密文：那个字段只用于校验密钥版本，
--   从未参与加解密，主密钥仍是同一把，历史凭据照常可解。

-- 1. 重命名。只在「旧列在、新列不在」时动手，重复执行是安全的。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'display_name'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'masked_phone'
    ) THEN
        ALTER TABLE users RENAME COLUMN display_name TO masked_phone;
    END IF;
END
$$;

-- 2. 删掉不再使用的列。
ALTER TABLE users DROP COLUMN IF EXISTS updated_at;
ALTER TABLE tenant_credentials DROP COLUMN IF EXISTS encryption_key_id;

-- 3. 租户运行状态。
--    先把历史上的 'none' 归到 'stopped'，否则新约束加不上去。
UPDATE tenant_runtime SET state = 'stopped' WHERE state = 'none';

ALTER TABLE tenant_runtime ALTER COLUMN state DROP DEFAULT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'tenant_runtime'::regclass
          AND conname = 'tenant_runtime_state_check'
    ) THEN
        ALTER TABLE tenant_runtime DROP CONSTRAINT tenant_runtime_state_check;
    END IF;
    ALTER TABLE tenant_runtime
        ADD CONSTRAINT tenant_runtime_state_check
        CHECK (state IN ('starting', 'running', 'stopped'));
END
$$;
