import { isBrowserShell } from '@/lib/browser-shell'
import { Cloud } from '@/lib/icons'

import { CloudLibrary } from './cloud-library'

// The 个人云盘 tab. Browser build: the cloud drive is not connected yet, so the
// tab says so instead of calling the drive API (see lib/browser-shell).
export function CloudDriveTab() {
  if (!isBrowserShell()) {
    return <CloudLibrary />
  }

  return (
    <div className="grid h-full place-items-center p-4 text-center">
      <div>
        <Cloud className="mx-auto size-8 text-muted-foreground/60" />
        <p className="mt-3 text-sm font-medium">功能开发中</p>
      </div>
    </div>
  )
}
