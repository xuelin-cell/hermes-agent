import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { CloudDriveClient } from './cloud-drive'
import type { ResolveDriveArtifact } from './cloud-drive-artifact-source'
import { CloudDriveTransfers } from './cloud-drive-transfers'
import type { CloudDriveTransferRequest } from './contract'

/** 传输复用账号主框架校验，文件源由原生选择框或主进程会话核对确定。 */
export function installCloudDriveTransferIpc(
  drive: CloudDriveClient,
  cacheRoot: string,
  trusted: (event: IpcMainInvokeEvent, args: unknown[]) => boolean,
  resolveArtifact?: ResolveDriveArtifact
): CloudDriveTransfers {
  const transfers = new CloudDriveTransfers(drive, cacheRoot)

  const previewOwners = new Set<number>()
  app.once('will-quit', () => transfers.cancelAll())

  ipcMain.handle('hermes:maas-drive:cancel', (event, ...args) => {
    if (trusted(event, []) && args.length === 1 && typeof args[0] === 'string') {
      transfers.cancel(event.sender.id, args[0])
    }
  })

  ipcMain.handle('hermes:maas-drive:transfer', async (event, ...args) => {
    if (!trusted(event, []) || args.length !== 1) {
      throw new Error('云盘传输请求无效')
    }

    const window = BrowserWindow.fromWebContents(event.sender)!
    const cancel = () => transfers.cancel(event.sender.id)

    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) {
        cancel()
      }
    }

    let lastProgress = 0
    event.sender.once('destroyed', cancel)
    event.sender.on('did-start-navigation', navigation)

    try {
      const input = args[0] as CloudDriveTransferRequest

      if (input.operation === 'preview' && !previewOwners.has(event.sender.id)) {
        previewOwners.add(event.sender.id)

        /** 主框架重载或关闭时释放临时文件，SPA 切页不影响仍打开的预览标签。 */
        const release = () => {
          transfers.cancel(event.sender.id)
          void transfers.clearPreviews(event.sender.id)
        }

        /** 只在真实主框架导航时清理，内部锚点和子页面不夺走预览文件。 */
        const leave = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
          if (mainFrame && !inPlace) {
            release()
          }
        }

        event.sender.on('did-start-navigation', leave)
        event.sender.once('destroyed', () => {
          release()
          event.sender.removeListener('did-start-navigation', leave)
          previewOwners.delete(event.sender.id)
        })
      }

      return await transfers.run(event.sender.id, input, {
        selectUpload: async signal => {
          if (input.operation === 'upload' && input.artifact !== undefined) {
            if (!resolveArtifact) {
              throw new Error('Artifact upload unavailable')
            }

            return await resolveArtifact(input.artifact, signal)
          }

          const result = await dialog.showOpenDialog(window, { properties: ['openFile'] })

          return !result.canceled && result.filePaths.length === 1 ? result.filePaths[0] : null
        },
        selectDownload: async name => {
          const result = await dialog.showSaveDialog(window, { defaultPath: name })

          return result.canceled ? null : result.filePath || null
        },
        progress: progress => {
          if (!event.sender.isDestroyed() && trusted(event, [])) {
            if (Date.now() - lastProgress >= 200 || progress.completed === progress.total) {
              lastProgress = Date.now()
              event.sender.send('hermes:maas-drive:progress', progress)
            }
          } else {
            cancel()
          }
        }
      })
    } finally {
      event.sender.removeListener('destroyed', cancel)
      event.sender.removeListener('did-start-navigation', navigation)
    }
  })

  return transfers
}
