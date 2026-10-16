import { useState } from 'react'

import type { DriveAsset } from '@/api/drive'

/** 选择只属于当前目录、筛选和搜索范围，已隐藏或失效的文件不参与批量操作。 */
export function useDriveSelection(scope: string, rows: readonly DriveAsset[]) {
  const [state, setState] = useState<{ scope: string; ids: Set<string> }>({ scope, ids: new Set() })
  const chosen = rows.filter(row => state.scope === scope && state.ids.has(row.asset_id))
  const selected = new Set(chosen.map(row => row.asset_id))

  /** 以业务 ID 切换当前范围内的单项选择。 */
  function toggle(id: string): void {
    setState(previous => {
      const ids = new Set(previous.scope === scope ? previous.ids : [])

      if (ids.has(id)) {
        ids.delete(id)
      } else {
        ids.add(id)
      }

      return { scope, ids }
    })
  }

  /** 全选只覆盖已经显示的项目，不能选择尚未展示或尚未扫描到的文件。 */
  function selectAll(checked: boolean): void {
    setState({ scope, ids: new Set(checked ? rows.map(row => row.asset_id) : []) })
  }

  return { chosen, selected, toggle, selectAll, clear: () => setState({ scope, ids: new Set() }) }
}
