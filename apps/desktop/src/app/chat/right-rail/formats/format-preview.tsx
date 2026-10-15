import { type ComponentProps, Suspense, useCallback, useEffect, useState } from 'react'

import { RichBoundary } from '@/components/assistant-ui/embeds/rich-boundary'
import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { LocalFilePreview, PreviewEmptyState } from '../preview-file'

import type { PreviewFailure } from './failure'
import { previewFormat, type PreviewFormat } from './kinds'
import { type FormatRendererProps, formatRenderers } from './registry'
import { usePreviewSource } from './source'

type FilePreviewProps = ComponentProps<typeof LocalFilePreview>

/** 接管已登记格式；原版文件预览的参数和行为原样保留。 */
export function FormatPreview(props: FilePreviewProps) {
  const source = usePreviewSource(props.target)
  const kind = previewFormat(props.target)

  return kind ? (
    <RegisteredPreview
      key={JSON.stringify([source.key, source.path, props.reloadKey])}
      {...props}
      kind={kind}
      source={source}
    />
  ) : (
    <LocalFilePreview {...props} />
  )
}

interface RegisteredPreviewProps extends FilePreviewProps {
  kind: PreviewFormat
  source: ReturnType<typeof usePreviewSource>
}

/** 按登记顺序降级，文件不存在时停止尝试，并提供原文件出口。 */
function RegisteredPreview({ kind, onClose, source, ...props }: RegisteredPreviewProps) {
  const { t } = useI18n()
  const [attempt, setAttempt] = useState<{ failure?: PreviewFailure; index: number }>({ index: 0 })
  const { index } = attempt
  const Renderer = attempt.failure?.code === 'not_found' ? undefined : formatRenderers(kind, source.path)[index]

  // 只接受当前候选的失败，旧候选迟到的回调不能跳过新候选。
  const onFailure = useCallback(
    (failure: PreviewFailure) => {
      setAttempt(current => (current.index === index ? { failure, index: index + 1 } : current))
    },
    [index]
  )

  if (!Renderer) {
    return (
      <PreviewEmptyState
        body={
          <>
            {t.preview.formatFailure[attempt.failure?.code || 'unavailable']}
            {(kind === 'word' || kind === 'slides') && source.exit === 'reveal' && attempt.failure?.code === 'unavailable' && (
              <p className="mt-2">{t.preview.office.installConverter}</p>
            )}
          </>
        }
        primaryAction={{
          label: source.exit === 'download' ? t.fileMenu.download : t.fileMenu.revealFileManager,
          onClick: () => void source.open()
        }}
        secondaryAction={onClose ? { label: t.preview.closePane, onClick: onClose } : undefined}
        title={t.preview.unavailable}
      />
    )
  }

  return (
    <RichBoundary fallback={<FailedRenderer onFailure={onFailure} />} key={index}>
      <Suspense fallback={<PageLoader label={t.preview.loading} />}>
        <Renderer {...props} onClose={onClose} onFailure={onFailure} path={source.path} />
      </Suspense>
    </RichBoundary>
  )
}

/** 懒加载或渲染异常也经过同一降级流程，不能拖垮预览面板。 */
function FailedRenderer({ onFailure }: Pick<FormatRendererProps, 'onFailure'>) {
  const { t } = useI18n()

  useEffect(() => onFailure({ code: 'unavailable' }), [onFailure])

  return <PageLoader label={t.preview.loading} />
}
