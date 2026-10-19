import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ArrowDown, ArrowsSort, ArrowUp } from '@/lib/icons'

import type { CloudFileSort } from './cloud-file-metadata'

interface CloudFileListHeaderProps {
  sort: CloudFileSort
  disabled: boolean
  onSort: () => void
}

/** 元数据标签放入面包屑行；只按修改时间排序，第三次点击恢复服务默认顺序。 */
export function CloudFileListHeader({ sort, disabled, onSort }: CloudFileListHeaderProps) {
  const { cloudLibrary: copy } = useI18n().t
  const Arrow = sort === 'default' ? ArrowsSort : sort === 'asc' ? ArrowUp : ArrowDown
  const description = sort === 'default' ? copy.sortDefault : sort === 'asc' ? copy.sortAscending : copy.sortDescending
  const next = sort === 'default' ? copy.sortDescending : sort === 'desc' ? copy.sortAscending : copy.sortDefault

  return (
    <div className="grid min-w-72 flex-1 grid-cols-[5rem_minmax(1.5rem,1fr)_10rem_minmax(1.5rem,1fr)] items-center text-xs font-normal text-muted-foreground @max-[42rem]/drive:flex @max-[42rem]/drive:min-w-0 @max-[42rem]/drive:flex-none @max-[42rem]/drive:gap-2">
      <span className="w-20 shrink-0 text-right @max-[42rem]/drive:w-auto">{copy.fileSize}</span>
      <Tip label={next}>
        <Button
          aria-description={description}
          aria-label={copy.modifiedTime}
          aria-pressed={sort !== 'default'}
          className="col-start-3 w-max justify-start"
          disabled={disabled}
          onClick={onSort}
          size="micro"
          variant="ghost"
        >
          {copy.modifiedTime}
          <Arrow aria-label={description} />
        </Button>
      </Tip>
    </div>
  )
}
