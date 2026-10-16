import { Fragment } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { DriveFolderLocation } from './drive-directory-index'

interface DriveBreadcrumbsProps {
  root: string
  path: DriveFolderLocation[]
  disabled?: boolean
  onNavigate: (id: string) => void
}

/** 云盘、回收站及目录选择弹窗共用相同字号和字重，分隔符不混入按钮名称。 */
export function DriveBreadcrumbs({ root, path, disabled, onNavigate }: DriveBreadcrumbsProps) {
  const { t } = useI18n()
  const locations = [{ id: root, name: t.cloudLibrary.personal }, ...path]

  return (
    <nav
      aria-label={t.cloudLibrary.breadcrumb}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-normal"
    >
      {locations.map((location, index) => (
        <Fragment key={location.id}>
          {index > 0 && <span aria-hidden="true">/</span>}
          <Button
            aria-current={index === locations.length - 1 ? 'page' : undefined}
            disabled={disabled}
            onClick={() => onNavigate(location.id)}
            size="micro"
            variant="ghost"
          >
            {location.name}
          </Button>
        </Fragment>
      ))}
    </nav>
  )
}
