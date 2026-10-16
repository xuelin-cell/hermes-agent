import { PanelEmpty } from '@/app/overlays/panel'
import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import type { DriveIndexSnapshot } from './drive-directory-index'

interface CloudDirectoryEmptyProps {
  snapshot: DriveIndexSnapshot
  parent?: string
  query: string
}

/** 沿用桌面加载器，并显式显示原版文案，避免提示只存在于无障碍标签中。 */
export function CloudDriveLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8">
      <PageLoader className="h-auto" label={label} />
      <p className="text-sm">{label}</p>
    </div>
  )
}

/** 复用统一空态区分空目录和搜索无结果；已确认的空目录在后台刷新时保持原内容。 */
export function CloudDirectoryEmpty({ snapshot, parent, query }: CloudDirectoryEmptyProps) {
  const { cloudLibrary: copy } = useI18n().t
  const searching = !!query.trim()
  const known = !!parent && snapshot.loadedDirectories.includes(parent)

  if (!snapshot.error && !snapshot.complete && !known && (!searching || !snapshot.items.length)) {
    return <CloudDriveLoading label={copy.loading} />
  }

  if (!searching && known) {
    return <PanelEmpty icon="folder-opened" title={copy.emptyFolder} />
  }

  if (searching) {
    return (
      <PanelEmpty
        description={snapshot.complete ? copy.noResultsHint : copy.partialHint}
        icon="search"
        title={snapshot.complete ? copy.noResults : copy.partialResults}
      />
    )
  }

  if (snapshot.complete && !known) {
    return <p role="alert">{copy.loadFailed}</p>
  }

  return null
}
