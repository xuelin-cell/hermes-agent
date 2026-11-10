import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { collectDeliveredLocalArtifacts } from '@/app/artifacts/local-artifact-delivery'
import { TreeSkeleton } from '@/components/chat/skeletons'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { useI18n } from '@/i18n'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import { $panesFlipped } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'
import {
  $activeSessionId,
  $messages,
  $selectedStoredSessionId,
  $sessions
} from '@/store/session'

import { SidebarPanelLabel } from '../shell/sidebar-label'
import { EmptyState, PaneEmptyState, RightSidebarSectionHeader } from './index'

/** A normalized artifact row ready for rendering. */
interface SessionArtifactRow {
  /** Stable id for React keys: session id + resolved path. */
  id: string
  /** Display label (file name). */
  label: string
  /** The raw artifact value (path / url) before preview normalization. */
  value: string
  /** Resolved absolute path on disk, when known. */
  resolvedPath?: string
  /** File size in bytes, when known. */
  byteSize?: number
  /** True when the artifact points at a remote/external resource. */
  isExternal: boolean
}

/**
 * SessionArtifactsPane — the right-sidebar pane for office/study work modes.
 *
 * It lists the files the current visible session has explicitly delivered,
 * scoping every read to the session the user is looking at. Switching
 * sessions resets the list immediately and discards any late-arriving result
 * from the previous session (A→B→A race protection).
 *
 * The pane reuses the existing preview rail: clicking a row calls
 * `normalizeOrLocalPreviewTarget` and `openPreview`, so artifacts open in the
 * same preview pane as file-tree clicks and tool results.
 */
export function SessionArtifactsPane() {
  const { t } = useI18n()
  const r = t.rightSidebar
  const panesFlipped = useStore($panesFlipped)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const activeSessionId = useStore($activeSessionId)
  const sessions = useStore($sessions)
  const messageCount = useStore($messages).length

  // The list of artifacts for the current session.
  const [artifacts, setArtifacts] = useState<SessionArtifactRow[]>([])
  // True while the pane is loading artifacts for the current session.
  const [loading, setLoading] = useState(false)
  // An error message when the pane failed to load artifacts for the current
  // session. Empty string means no error.
  const [error, setError] = useState('')

  /**
   * Race protection: a generation counter that increments on every session
   * change. Only results matching the current generation are accepted; late
   * results from a previous session are discarded.
   */
  const generationRef = useRef(0)

  // The effective session id: prefer the selected stored session, fall back to
  // the active session id. This mirrors the sidebar's session resolution.
  const sessionId = selectedStoredSessionId ?? activeSessionId ?? null

  // The session info for the current session, if any.
  const session = sessionId ? sessions.find(s => s.id === sessionId) ?? null : null

  /**
   * Load artifacts for the current session.
   *
   * This is a stable callback that reads the current session from the closure.
   * It increments the generation counter, resets the list immediately, and
   * only accepts results matching the current generation.
   */
  const loadArtifacts = useCallback(async () => {
    // No session selected → clear the list and show the empty state.
    if (!session) {
      setArtifacts([])
      setLoading(false)
      setError('')

      return
    }

    // Increment the generation counter and reset the list immediately.
    const generation = ++generationRef.current
    setArtifacts([])
    setLoading(true)
    setError('')

    try {
      // Load all messages for the session.
      // Use dynamic import to avoid pulling the entire @/hermes barrel into
      // the renderer's module graph at load time (which causes white screen).
      const { getAllSessionMessages } = await import('@/hermes')
      const result = await getAllSessionMessages(session.id, {
        connectionId: session.connection_id || 'local',
        profile: session.profile || 'default'
      })

      // Discard late results from a previous session.
      if (generationRef.current !== generation) {
        return
      }

      // Collect delivered artifacts from the messages.
      const delivered = collectDeliveredLocalArtifacts(session, result.messages)

      // Normalize preview targets for each artifact.
      const rows: SessionArtifactRow[] = []
      const seen = new Set<string>()

      for (const artifact of delivered) {
        // Discard late results from a previous session.
        if (generationRef.current !== generation) {
          return
        }

        // Normalize the preview target using the existing infrastructure.
        const preview = await normalizeOrLocalPreviewTarget(artifact.value, session.cwd || undefined)

        // Discard late results from a previous session.
        if (generationRef.current !== generation) {
          return
        }

        // Skip artifacts that don't resolve to a previewable target.
        if (!preview) {
          continue
        }

        // Deduplicate by resolved path (or value if no path).
        const key = preview.path || artifact.value

        if (seen.has(key)) {
          continue
        }

        seen.add(key)

        rows.push({
          id: `${session.id}:${key}`,
          label: preview.label || artifact.label,
          value: artifact.value,
          resolvedPath: preview.path,
          byteSize: preview.byteSize,
          isExternal: preview.kind === 'url'
        })
      }

      // Only accept results matching the current generation.
      if (generationRef.current === generation) {
        setArtifacts(rows)
        setLoading(false)
      }
    } catch (err) {
      // Only accept errors matching the current generation.
      if (generationRef.current === generation) {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    }
  }, [session])

  // Load artifacts when the session changes or when messages change (live
  // updates as the conversation progresses).
  useEffect(() => {
    void loadArtifacts()
  }, [loadArtifacts, messageCount])

  // Reset the generation counter when the component unmounts.
  useEffect(() => {
    return () => {
      generationRef.current += 1
    }
  }, [])

  // Open an artifact in the preview pane.
  const handleOpenArtifact = useCallback(async (artifact: SessionArtifactRow) => {
    try {
      const preview = await normalizeOrLocalPreviewTarget(artifact.value, session?.cwd || undefined)

      if (!preview) {
        throw new Error(r.couldNotPreview(artifact.label))
      }

      openPreview(preview)
    } catch (err) {
      notifyError(err, r.previewUnavailable)
    }
  }, [r, session?.cwd])

  // Delay the loading skeleton so fast loads don't flash it.
  const showLoadingSkeleton = useDelayedTrue(loading && artifacts.length === 0)

  return (
    <aside
      aria-label={r.aria}
      className={cn(
        'before:pointer-events-none relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) pt-(--titlebar-height) text-(--ui-text-tertiary)',
        panesFlipped
          ? 'border-r shadow-[inset_-0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-l shadow-[inset_0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
      )}
    >
      <RightSidebarSectionHeader data-suppress-pane-reveal-side="">
        <div className="flex min-w-0 flex-1">
          <SidebarPanelLabel data-pane-self-label="">
            {r.files}
          </SidebarPanelLabel>
        </div>
        <Tip label={r.refreshTree}>
          <Button
            aria-label={r.refreshTree}
            className="size-5"
            disabled={loading || !session}
            onClick={() => void loadArtifacts()}
            size="icon-xs"
            variant="ghost"
          >
            <Codicon name="refresh" size="0.8125rem" spinning={loading} />
          </Button>
        </Tip>
      </RightSidebarSectionHeader>

      {error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <EmptyState body={error} title={r.unreadableTitle} />
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={() => void loadArtifacts()}
            type="button"
          >
            {r.tryAgain}
          </button>
        </div>
      ) : loading && artifacts.length === 0 ? (
        showLoadingSkeleton ? (
          <div aria-label={r.loadingTree} className="min-h-0 flex-1" role="status">
            <TreeSkeleton />
          </div>
        ) : (
          <div className="min-h-0 flex-1" />
        )
      ) : artifacts.length === 0 ? (
        <PaneEmptyState label={r.noDiffs} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {artifacts.map(artifact => (
            <button
              key={artifact.id}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.7rem] text-(--ui-text-secondary) hover:bg-(--ui-row-hover-background) hover:text-foreground"
              onClick={() => void handleOpenArtifact(artifact)}
              title={artifact.resolvedPath || artifact.label}
              type="button"
            >
              <Codicon
                aria-hidden="true"
                name={artifact.isExternal ? 'link' : 'file'}
                size="0.875rem"
                className="shrink-0 text-(--ui-text-tertiary)"
              />
              <span className="min-w-0 flex-1 truncate">{artifact.label}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}
