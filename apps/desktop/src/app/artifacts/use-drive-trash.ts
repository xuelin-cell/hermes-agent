import { useEffect, useRef, useState } from 'react'

import { type DriveAsset, driveRequest } from '@/api/drive'
import { useI18n } from '@/i18n'
import { confirm } from '@/store/confirm'

import { notifyDriveMutationFailure, runVerifiedDriveMutation } from './use-drive-mutation'

/** 单项和多选删除共用确认与一次性请求；只移入回收站，不开放永久删除。 */
export function useDriveTrash(onChanged: () => void) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const state = useRef({ active: true, busy: false })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const lifecycle = state.current
    lifecycle.active = true

    return () => {
      lifecycle.active = false
    }
  }, [])

  /** 捕获所选项目后一次发送文件 ID 和文件夹 ID，失败或结果未知时不自动重发。 */
  async function trash(source: DriveAsset | readonly DriveAsset[]): Promise<void> {
    const assets = 'asset_id' in source ? [source] : source
    const lifecycle = state.current

    if (lifecycle.busy || !assets.length || assets.some(asset => asset.permissions?.delete === false)) {
      return
    }

    lifecycle.busy = true
    setBusy(true)

    try {
      const folders = assets.some(asset => asset.kind === 'directory')

      const confirmed = await confirm({
        title: assets.length > 1 ? copy.deleteSelectionTitle : folders ? copy.deleteFolderTitle : copy.deleteFileTitle,
        description: [
          assets.map(asset => asset.name).join('、'),
          copy.deleteSelectionHint(assets.length),
          ...(folders ? [copy.deleteFolderHint] : [])
        ].join('\n'),
        destructive: true
      })

      if (!confirmed || !lifecycle.active) {
        return
      }

      try {
        await runVerifiedDriveMutation(
          verifying =>
            driveRequest(
              '/assets/trash',
              'POST',
              {
                file_ids: [...new Set(assets.filter(asset => asset.kind === 'file').map(asset => asset.asset_id))],
                directory_ids: [
                  ...new Set(assets.filter(asset => asset.kind === 'directory').map(asset => asset.asset_id))
                ]
              },
              verifying
            ),
          () => lifecycle.active
        )
      } catch (failure) {
        if (lifecycle.active) {
          notifyDriveMutationFailure(failure, copy.trash, copy)
        }
      } finally {
        if (lifecycle.active) {
          onChanged()
        }
      }
    } finally {
      lifecycle.busy = false

      if (lifecycle.active) {
        setBusy(false)
      }
    }
  }

  return { busy, trash }
}
