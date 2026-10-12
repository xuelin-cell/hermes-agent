import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Cloud, Download, Eye, Pencil, Plus, RefreshCw, Search, Trash2 } from '@/lib/icons'

/** 保留云盘展示，接口确认前不读取身份、文件或执行远端操作。 */
export function CloudLibrary() {
  const { t } = useI18n()
  const copy = t.cloudLibrary

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
        <span className="text-xs text-muted-foreground">{copy.personal}</span>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Input
            aria-describedby="cloud-library-unavailable"
            aria-label={copy.search}
            containerClassName="w-52 max-w-full"
            disabled
            placeholder={copy.search}
            prefix={<Search className="size-3.5" />}
          />
          <Button aria-describedby="cloud-library-unavailable" disabled size="sm" variant="outline">
            <Plus />
            {copy.createFolder}
          </Button>
          <div className="flex items-center gap-1">
            <Button
              aria-describedby="cloud-library-unavailable"
              aria-label={copy.refresh}
              disabled
              size="icon-xs"
              variant="ghost"
            >
              <RefreshCw />
            </Button>
            <Button
              aria-describedby="cloud-library-unavailable"
              aria-label={copy.rename}
              disabled
              size="icon-xs"
              variant="ghost"
            >
              <Pencil />
            </Button>
            <Button
              aria-describedby="cloud-library-unavailable"
              aria-label={copy.trash}
              disabled
              size="icon-xs"
              variant="ghost"
            >
              <Trash2 />
            </Button>
            <Button
              aria-describedby="cloud-library-unavailable"
              aria-label={copy.preview}
              disabled
              size="icon-xs"
              variant="ghost"
            >
              <Eye />
            </Button>
            <Button
              aria-describedby="cloud-library-unavailable"
              aria-label={copy.download}
              disabled
              size="icon-xs"
              variant="ghost"
            >
              <Download />
            </Button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-4">
        <div id="cloud-library-unavailable" role="status">
          <Cloud className="mx-auto size-8 text-muted-foreground/60" />
          <EmptyState className="mt-3 min-h-0" description={copy.unavailableDescription} title={copy.unavailable} />
        </div>
      </div>
    </section>
  )
}
