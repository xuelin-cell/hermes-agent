import { useEffect, useState } from 'react'

import { driveRequest } from '@/api/drive'

export interface DriveUsage {
  used_bytes: number | null
  total_bytes: number | null
}

/** 容量必须来自服务，不将缺失或损坏数值伪装成零用量。 */
function parseUsage(value: unknown): DriveUsage {
  const usage = value as DriveUsage

  if (
    !usage ||
    !['used_bytes', 'total_bytes'].every(key => {
      const bytes = usage[key as keyof DriveUsage]

      return bytes === null || (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0)
    })
  ) {
    throw new Error('Invalid drive usage')
  }

  return { used_bytes: usage.used_bytes, total_bytes: usage.total_bytes }
}

/** 容量按当前云盘空间归属；暂时刷新失败保留旧值，切换空间丢弃迟到响应。 */
export function useDriveUsage(spaceId?: string) {
  const [revision, setRevision] = useState(0)

  const [state, setState] = useState<{ spaceId?: string; usage: DriveUsage | null; failed: boolean }>({
    usage: null,
    failed: false
  })

  useEffect(() => {
    if (!spaceId) {
      return
    }

    let cancelled = false

    void driveRequest<unknown>(`/asset-spaces/${encodeURIComponent(spaceId)}/usage`)
      .then(value => {
        const usage = parseUsage(value)

        if (!cancelled) {
          setState({ spaceId, usage, failed: false })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(previous => ({ spaceId, usage: previous.spaceId === spaceId ? previous.usage : null, failed: true }))
        }
      })

    return () => {
      cancelled = true
    }
  }, [spaceId, revision])

  return {
    usage: state.spaceId === spaceId ? state.usage : null,
    failed: state.spaceId === spaceId && state.failed,
    refresh: () => setRevision(value => value + 1)
  }
}

/** 与原数字员工一样用一位小数展示容量，未知值显示破折号。 */
export function driveBytes(value: number | null): string {
  if (value === null) {
    return '—'
  }

  if (value < 1024) {
    return `${value} B`
  }

  const unit = Math.min(3, Math.max(0, Math.floor(Math.log(value || 1) / Math.log(1024))))

  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`
}
