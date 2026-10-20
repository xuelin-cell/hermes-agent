import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { ArtifactShareService } from './service'

/** Every artifact operation shares the same trusted-window check. */
export function registerArtifactShareIpc(
  ipc: IpcMain,
  service: ArtifactShareService,
  assertWindow: (event: IpcMainInvokeEvent) => void
): void {
  ipc.handle('hermes:artifact-share:inspect', (event, query) => {
    assertWindow(event)

    return service.inspect(query)
  })
  ipc.handle('hermes:artifact-share:eligibility', (event, source) => {
    assertWindow(event)

    return service.eligibility(source)
  })
  ipc.handle('hermes:artifact-share:markUploaded', (event, sessionId) => {
    assertWindow(event)
    service.markUploaded(sessionId)
  })
  ipc.handle('hermes:artifact-share:publish', (event, input) => {
    assertWindow(event)

    return service.publish(input)
  })
  ipc.handle('hermes:artifact-share:revoke', (event, key, shareId) => {
    assertWindow(event)

    return service.revoke(key, shareId)
  })
  ipc.handle('hermes:artifact-share:expiration', (event, key, shareId, ttlDays) => {
    assertWindow(event)

    return service.setExpiration(key, shareId, ttlDays)
  })
}
