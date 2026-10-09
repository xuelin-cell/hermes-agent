-- 定时任务：实例停着（暂停或已删）时由入口按时叫醒。
--
--   next_cron_at    实例最近一次暂停或删除时，转发器报的最早下次执行时间（hermes 的 cron/jobs.json）；
--                   没有待执行的任务就是 NULL。入口在它之前一点把实例叫起来，由 hermes 自己的调度线程去跑。
--   cron_woken_for  上一次为哪个时间点叫醒过。同一个时间点只叫一次：hermes 不肯跑的任务
--                   不会让实例被反复叫醒。

ALTER TABLE tenant_runtime
    ADD COLUMN IF NOT EXISTS next_cron_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cron_woken_for TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tenant_runtime_next_cron_idx
    ON tenant_runtime(next_cron_at) WHERE next_cron_at IS NOT NULL;
