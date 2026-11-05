/** 网页预览工具栏集中提供导航、刷新、批注、弹出及调试操作。 */

import { type ReactNode } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { PaneStripGlyph } from '@/components/ui/pane-tab'
import { useI18n } from '@/i18n'
import { ANNOTATE_BLUE } from '@/lib/preview-annotate'

interface PreviewBrowserBarProps {
  actions?: ReactNode
  annotateMode?: boolean
  canGoBack: boolean
  canGoForward: boolean
  commentCount?: number
  consoleOpen: boolean
  devToolsOpen: boolean
  loading: boolean
  onBack: () => void
  onFlushComments?: () => void
  onForward: () => void
  onOpenExternal?: () => void
  onPopIn?: () => void
  onPopOut?: () => void
  onReload: () => void
  onToggleAnnotate?: () => void
  onToggleConsole: () => void
  onToggleDevTools: () => void
}

/** 显示当前网页可用的操作，并按历史及加载状态更新按钮。 */
export function PreviewBrowserBar({
  actions,
  annotateMode = false,
  canGoBack,
  canGoForward,
  commentCount = 0,
  consoleOpen,
  devToolsOpen,
  loading,
  onBack,
  onFlushComments,
  onForward,
  onOpenExternal,
  onPopIn,
  onPopOut,
  onReload,
  onToggleAnnotate,
  onToggleConsole,
  onToggleDevTools
}: PreviewBrowserBarProps) {
  const { t } = useI18n()
  const copy = t.preview.web

  return (
    <div className="flex min-h-(--titlebar-height) shrink-0 items-center gap-1 border-b border-border/60 bg-background px-1.5 py-1">
      <PaneStripGlyph
        disabled={!canGoBack}
        icon={<Codicon name="arrow-left" size="0.8125rem" />}
        label={copy.goBack}
        onSelect={onBack}
      />
      <PaneStripGlyph
        disabled={!canGoForward}
        icon={<Codicon name="arrow-right" size="0.8125rem" />}
        label={copy.goForward}
        onSelect={onForward}
      />
      <PaneStripGlyph
        icon={<Codicon name="refresh" size="0.8125rem" spinning={loading} />}
        label={copy.reload}
        onSelect={onReload}
      />
      <div className="min-w-0 flex-1" />
      {actions}
      {onToggleAnnotate ? (
        <PaneStripGlyph
          active={annotateMode}
          icon={<Codicon name="comment" size="0.8125rem" />}
          label={annotateMode ? copy.annotateOn : copy.annotate}
          onSelect={onToggleAnnotate}
        />
      ) : null}
      {annotateMode ? (
        <span
          className="hidden shrink-0 items-center rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tracking-wide text-white uppercase sm:inline-flex"
          data-annotate-status="commenting"
          style={{ background: ANNOTATE_BLUE }}
        >
          {copy.commenting}
        </span>
      ) : null}
      {commentCount > 0 && onFlushComments ? (
        <button
          className="shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold text-white"
          onClick={onFlushComments}
          style={{ background: ANNOTATE_BLUE }}
          type="button"
        >
          {copy.addComments(commentCount)}
        </button>
      ) : null}
      {onPopIn ? (
        <PaneStripGlyph
          icon={<Codicon name="screen-normal" size="0.8125rem" />}
          label={t.preview.popIn}
          onSelect={onPopIn}
        />
      ) : onPopOut ? (
        <PaneStripGlyph
          icon={<Codicon name="empty-window" size="0.8125rem" />}
          label={t.preview.popOut}
          onSelect={onPopOut}
        />
      ) : onOpenExternal ? (
        <PaneStripGlyph
          icon={<Codicon name="link-external" size="0.8125rem" />}
          label={t.preview.openInBrowser}
          onSelect={onOpenExternal}
        />
      ) : null}
      <PaneStripGlyph
        active={consoleOpen}
        icon={<Codicon name="terminal" size="0.8125rem" />}
        label={consoleOpen ? copy.hideConsole : copy.showConsole}
        onSelect={onToggleConsole}
      />
      <PaneStripGlyph
        active={devToolsOpen}
        icon={<Codicon name="bug" size="0.8125rem" />}
        label={devToolsOpen ? copy.hideDevTools : copy.openDevTools}
        onSelect={onToggleDevTools}
      />
    </div>
  )
}
