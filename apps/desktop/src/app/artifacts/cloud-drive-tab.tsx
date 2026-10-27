import { isBrowserShell } from '@/lib/browser-shell'
import { Cloud } from '@/lib/icons'

import { CloudLibrary } from './cloud-library'

interface CloudDriveTabProps {
  onDraftReady?: (route: string) => void
}

/** 桌面云盘加入草稿后由外层导航；浏览器继续显示占位，不调用原生云盘接口。 */
export function CloudDriveTab({ onDraftReady }: CloudDriveTabProps) {
  if (!isBrowserShell() || window.hermesDesktop?.prepareCloudDriveTurn) {
    return <CloudLibrary onDraftReady={onDraftReady} />
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
