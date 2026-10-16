import type { ReactNode } from 'react'

/** 云盘与回收站共用固定行高及勾选列位置，多选出现时不推移文件列表。 */
export function CloudLocationBar({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-border/70 px-4">
      {leading ?? <span aria-hidden="true" className="size-4 shrink-0" />}
      {children}
    </div>
  )
}
