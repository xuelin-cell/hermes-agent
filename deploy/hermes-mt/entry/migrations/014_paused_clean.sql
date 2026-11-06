-- 实例是不是「干净地暂停着」：空闲回收先归档成功、再暂停成功时记 true，之后实例只要成功跑起来一次就清掉。
-- 为 true 时那份归档就是全部数据，实例坏了（在跑但转发器不应答）可以直接删掉从归档重建（tenants._discard_unresponsive）。
-- 以前拿 state_changed_at 和归档时间比，入口启动时按平台状态校正 state 就会把它改掉（11-06 真机）。
-- 老数据一律 false：不知道的当作不干净，不自动删。
ALTER TABLE tenant_runtime ADD COLUMN IF NOT EXISTS paused_clean BOOLEAN NOT NULL DEFAULT false;
