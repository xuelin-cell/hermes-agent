import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import type { ChatMessagePart } from '@/lib/chat-messages/types'
import { Clock, ExternalLink, Share2, Trash2 } from '@/lib/icons'

import { ArtifactExpiryDialog, ShareExpiryStatus, useArtifactShareExpired } from './expiry'

type ShareRecord = NonNullable<Awaited<ReturnType<Window['hermesDesktop']['artifactShare']['inspect']>>>

interface PublishedArtifact {
  shareId: string
  title: string
}

/** Only completed publish tool results create controls; assistant prose never grants an action. */
export function publishedArtifacts(parts: readonly ChatMessagePart[]): PublishedArtifact[] {
  const found = new Map<string, PublishedArtifact>()

  function collect(value: unknown, title: string, depth = 0): void {
    if (depth > 4) {
      return
    }

    if (typeof value === 'string') {
      const wrapped = value.trim().match(/^<untrusted_tool_result\b[^>]*>\s*([\s\S]*?)\s*<\/untrusted_tool_result>$/)
      const text = wrapped ? wrapped[1].slice(wrapped[1].indexOf('{')) : value

      try {
        collect(JSON.parse(text), title, depth + 1)
      } catch {
        /* Plain text is not a publish result. */
      }

      return
    }

    if (Array.isArray(value)) {
      value.forEach(item => collect(item, title, depth + 1))

      return
    }

    if (!value || typeof value !== 'object') {
      return
    }

    const record = value as Record<string, unknown>

    if (record.error || record.success === false || record.ok === false) {
      return
    }

    if (typeof record.share_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(record.share_id)) {
      found.set(record.share_id, { shareId: record.share_id, title })

      return
    }

    for (const key of ['result', 'output', 'results', 'content', 'text']) {
      if (record[key] !== undefined) {
        collect(record[key], title, depth + 1)
      }
    }
  }

  for (const part of parts) {
    if (part.type !== 'tool-call' || part.isError) {
      continue
    }

    const args = part.args as Record<string, unknown>
    const call = Array.isArray(args?.calls) && args.calls.length === 1 ? args.calls[0] : args
    const name = part.storedResultToolName || part.toolName

    if (name !== 'publish_artifact' && !(name === 'tool_call' && call?.name === 'publish_artifact')) {
      continue
    }

    const input = name === 'tool_call' || part.storedResultToolName ? call?.arguments || args : args
    const path = typeof input?.path === 'string' ? input.path : ''
    collect(part.result, path.split(/[\\/]/).at(-1) || '')
  }

  return [...found.values()]
}

/** Kept outside collapsible tool rows so answer-only transcripts still expose revocation. */
export function AssistantPublishedArtifacts() {
  const parts = useAuiState(s => s.message.content)
  const artifacts = useMemo(() => publishedArtifacts(parts as readonly ChatMessagePart[]), [parts])

  return artifacts.map(artifact => <PublishedArtifactCard artifact={artifact} key={artifact.shareId} />)
}

function PublishedArtifactCard({ artifact }: { artifact: PublishedArtifact }) {
  const scope = useStore($apiRequestScope)
  const api = window.hermesDesktop?.artifactShare

  // Remount on every scope transition, including A → B → A; old requests cannot paint new state.
  return <ScopedPublishedArtifact api={api} artifact={artifact} key={JSON.stringify(scope)} scope={scope} />
}

function ScopedPublishedArtifact({
  api,
  artifact,
  scope
}: {
  api: Window['hermesDesktop']['artifactShare'] | undefined
  artifact: PublishedArtifact
  scope: ReturnType<typeof $apiRequestScope.get>
}) {
  const { t } = useI18n()
  const [record, setRecord] = useState<ShareRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [editingExpiry, setEditingExpiry] = useState(false)
  const expired = useArtifactShareExpired(record)
  const [confirming, setConfirming] = useState(false)
  const lifecycle = useRef({ active: false, generation: 0 })

  useEffect(() => {
    const owner = lifecycle.current
    owner.active = true

    async function refresh(): Promise<void> {
      const generation = ++owner.generation
      setLoading(true)
      setError('')
      setConfirming(false)

      try {
        if (!api) {
          throw new Error(t.artifactShare.statusUnavailable)
        }

        const next = await api.inspect({ shareId: artifact.shareId })

        if (owner.active && generation === owner.generation && $apiRequestScope.get() === scope) {
          setRecord(next?.shareId === artifact.shareId ? next : null)
        }
      } catch (failure) {
        if (owner.active && generation === owner.generation && $apiRequestScope.get() === scope) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        if (owner.active && generation === owner.generation && $apiRequestScope.get() === scope) {
          setLoading(false)
        }
      }
    }

    void refresh()
    const unsubscribe = api?.onChanged(() => void refresh())
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)

    return () => {
      owner.active = false
      owner.generation += 1
      unsubscribe?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [api, artifact.shareId, scope, retry, t.artifactShare.statusUnavailable])

  async function revoke(): Promise<void> {
    if (!api || !record || $apiRequestScope.get() !== scope) {
      return
    }

    await api.revoke(record.key, artifact.shareId)

    if (lifecycle.current.active && $apiRequestScope.get() === scope) {
      setRecord(null)
      setConfirming(false)
    }
  }

  const manageable = record && !record.deletedAt && !loading && !error
  const active = manageable && !expired

  return (
    <section aria-label={t.artifactShare.shareArtifact} className="mt-3 min-w-0 space-y-2">
      <div className={WIDGET_SHELL_CLASS}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Share2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{record?.title || artifact.title || t.artifactShare.shareArtifact}</span>
        </div>
        {loading ? (
          <Loader label={t.artifactShare.checking} />
        ) : (
          <p className="mt-1 text-xs text-muted-foreground" role="status">
            {error ||
              (record ? (expired ? t.artifactShare.expired : t.artifactShare.linkReady) : t.artifactShare.inactive)}
          </p>
        )}
        {record && !loading && <ShareExpiryStatus expired={expired} record={record} />}
        {active && <p className="mt-1 break-all text-xs text-muted-foreground">{record.url}</p>}
      </div>
      {error && (
        <Button onClick={() => setRetry(value => value + 1)} size="sm" variant="ghost">
          {t.common.retry}
        </Button>
      )}
      {manageable && (
        <div className="flex flex-wrap items-center gap-1">
          {active && (
            <>
              <CopyButton buttonSize="sm" label={t.artifactShare.copyShared} showLabel text={record.url} />
              <Button
                onClick={() =>
                  void window.hermesDesktop.openExternal(record.url).catch(failure => setError(String(failure)))
                }
                size="sm"
                variant="ghost"
              >
                <ExternalLink aria-hidden="true" />
                {t.artifactShare.viewShared}
              </Button>
            </>
          )}
          <Button onClick={() => setEditingExpiry(true)} size="sm" variant="ghost">
            <Clock aria-hidden="true" />
            {t.artifactShare.editValidity}
          </Button>
          <Button onClick={() => setConfirming(true)} size="sm" variant="ghost">
            <Trash2 aria-hidden="true" />
            {t.artifactShare.revokeShared}
          </Button>
        </div>
      )}
      {editingExpiry && record && (
        <ArtifactExpiryDialog onClose={() => setEditingExpiry(false)} onSaved={setRecord} record={record} />
      )}
      <ConfirmDialog
        confirmLabel={t.artifactShare.revokeShared}
        description={t.artifactShare.confirmRevoke}
        destructive
        onClose={() => setConfirming(false)}
        onConfirm={revoke}
        open={confirming}
        title={t.artifactShare.revokeShared}
      />
    </section>
  )
}
