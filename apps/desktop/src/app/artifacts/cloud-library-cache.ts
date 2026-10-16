import type { DriveCapabilities, DriveSpace } from '@/api/drive'

import type { DriveIndexSnapshot } from './drive-directory-index'
import type { DriveUsage } from './use-drive-usage'

export interface CloudLibraryCache {
  space: DriveSpace
  capabilities: DriveCapabilities | null
  snapshot: DriveIndexSnapshot
}

// 主进程为账号创建独立窗口和分区，退出后重启；桥接对象限定该账号窗口的内存生命周期。
// 与数字员工一致，只保留展示元信息，不持久化目录、凭据或本机文件内容。
const windows = new WeakMap<object, { generation: number; data?: CloudLibraryCache }>()
// 容量与目录同属账号窗口，但独立更新，避免目录扫描覆盖刚刷新的容量。
const usageWindows = new WeakMap<object, Map<string, DriveUsage>>()

/** 按账号桥和云盘空间同步读取容量，退出窗口后不保留磁盘缓存。 */
export function readCloudUsageCache(bridge: object | undefined, spaceId?: string): DriveUsage | null {
  return bridge && spaceId ? usageWindows.get(bridge)?.get(spaceId) ?? null : null
}

/** 只保存服务确认的容量，调用方在写入前检查请求是否仍属于当前窗口。 */
export function writeCloudUsageCache(bridge: object | undefined, spaceId: string, usage: DriveUsage): void {
  if (!bridge) {
    return
  }

  let spaces = usageWindows.get(bridge)

  if (!spaces) {
    spaces = new Map()
    usageWindows.set(bridge, spaces)
  }

  spaces.set(spaceId, usage)
}

/** 同一账号窗口往返页面可同步读缓存，替换原生桥或重新打开应用时不复用旧数据。 */
export function readCloudLibraryCache(): CloudLibraryCache | undefined {
  const bridge = window.hermesDesktop

  return bridge ? windows.get(bridge)?.data : undefined
}

/** 仅最新页面实例发布缓存，已卸载或较早的并发扫描不能覆盖新页面快照。 */
export function claimCloudLibraryCache(): (data: CloudLibraryCache) => void {
  const bridge = window.hermesDesktop

  if (!bridge) {
    return () => undefined
  }

  const entry = windows.get(bridge) ?? { generation: 0 }
  const generation = ++entry.generation
  windows.set(bridge, entry)

  return data => {
    if (entry.generation === generation) {
      entry.data = data
    }
  }
}
