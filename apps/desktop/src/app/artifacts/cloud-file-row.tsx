import type { ReactNode } from 'react'

import { Button, buttonVariants } from '@/components/ui/button'
import { FileText, FolderOpen } from '@/lib/icons'
import { cn } from '@/lib/utils'

/** 云盘与回收站共享列表行间距，未提供复选框时保留相同的名称起始位置。 */
export function CloudFileRow({ name, leading, children }: { name: string; leading?: ReactNode; children: ReactNode }) {
  return (
    <div aria-label={name} className="flex items-center gap-2 border-b border-border/50 py-2 text-sm" role="group">
      {leading ?? <span aria-hidden="true" className="size-4 shrink-0" />}
      {children}
    </div>
  )
}

/** 文件类型图标和名称使用相同控件排版；回收站名称只展示，不伪装成可打开的文件。 */
export function CloudFileName({
  name,
  kind,
  disabled,
  onOpen
}: {
  name: string
  kind: 'file' | 'directory'
  disabled?: boolean
  onOpen?: () => void
}) {
  const content = (
    <>
      {kind === 'file' ? <FileText /> : <FolderOpen />}
      <span className="truncate">{name}</span>
    </>
  )

  const className = 'min-w-0 flex-1 justify-start'

  return onOpen ? (
    <Button className={className} disabled={disabled} onClick={onOpen} variant="ghost">
      {content}
    </Button>
  ) : (
    <div className={cn(buttonVariants({ variant: 'ghost' }), className, 'cursor-default')}>{content}</div>
  )
}
