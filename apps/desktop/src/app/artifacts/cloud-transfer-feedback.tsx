import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2, Loader2, X } from '@/lib/icons'

import { driveTransferText, isDriveTransferActive } from './cloud-transfer-copy'
import type { useCloudTransfer } from './use-cloud-transfer'

/** 沿用数字员工的非模态传输记录浮窗，关闭不停止，结束记录由用户清除。 */
export function CloudTransferFeedback({ transfer }: { transfer: ReturnType<typeof useCloudTransfer> }) {
  const { t } = useI18n()
  const copy = t.cloudLibrary

  if (!transfer.records.length) {
    return null
  }

  return (
    <Popover onOpenChange={transfer.setPopupOpen} open={transfer.popupOpen}>
      <PopoverTrigger asChild>
        <Button aria-label={copy.transfers} size="icon-xs" variant="ghost">
          <IconArrowsUpDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={copy.transfers}
        className="w-96 max-w-[calc(100vw-2rem)]"
        onInteractOutside={event => event.preventDefault()}
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border pb-2 text-xs">
          <strong className="mr-auto">{copy.transfers}</strong>
          {transfer.busy && (
            <Button disabled={transfer.cancelling} onClick={transfer.cancel} size="xs" variant="ghost">
              {transfer.cancelling ? t.common.loading : copy.stopTransfers}
            </Button>
          )}
          <Button disabled={transfer.busy} onClick={transfer.clearFinished} size="xs" variant="ghost">
            {copy.clearFinished}
          </Button>
          <Button
            aria-label={t.common.close}
            onClick={() => transfer.setPopupOpen(false)}
            size="icon-xs"
            variant="ghost"
          >
            <X />
          </Button>
        </header>
        <div aria-live="polite" className="max-h-72 overflow-y-auto" role="status">
          {transfer.records.map(record => {
            const active = isDriveTransferActive(record)
            const done = record.state === 'succeeded'

            const fraction =
              record.total !== null && record.total > 0 ? Math.min(1, record.completed / record.total) : undefined

            return (
              <div
                aria-label={record.name}
                className="flex items-start gap-2 py-2 text-xs"
                key={`${record.batchId}-${record.index}`}
                role="group"
              >
                {done ? (
                  <CheckCircle2 className="size-4 shrink-0 text-primary" />
                ) : active ? (
                  <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                ) : (
                  <AlertCircle className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate" title={record.name}>
                    {record.name}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {driveTransferText(record, copy, t.preview.office.converting)}
                  </p>
                  {active && (
                    <>
                      <Progress
                        aria-label={record.name}
                        className="mt-2"
                        indeterminate={
                          fraction === undefined || record.state === 'verifying' || record.state === 'converting'
                        }
                        size="sm"
                        value={fraction}
                      />
                      {record.total !== null && ['uploading', 'downloading'].includes(record.state) && (
                        <p className="mt-1 text-muted-foreground">
                          {Math.floor(record.completed / 1024)} KiB / {Math.ceil(record.total / 1024)} KiB
                        </p>
                      )}
                    </>
                  )}
                </div>
                {done && <span>100%</span>}
                {active && fraction !== undefined && ['uploading', 'downloading'].includes(record.state) && (
                  <span>{Math.min(record.state === 'verifying' ? 99 : 100, Math.floor(fraction * 100))}%</span>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

import { IconArrowsUpDown } from '@tabler/icons-react'
