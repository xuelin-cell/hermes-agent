import { host, useValue } from '@hermes/plugin-sdk'
import DOMPurify from 'dompurify'
import { Mail, RefreshCw, Search, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentMailStatus } from '../../../electron/agent-mail/contract'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import {
  deleteMessage,
  disableMail,
  enableMail,
  getMessage,
  listFolders,
  listMessages,
  mailStatus,
  markRead,
  searchMessages
} from './api'
import { useMailText } from './i18n'
import {
  addressLabel,
  groupMailMessages,
  mergeMailMessages,
  resolveMailFolders,
  type MailDetail,
  type MailFolder,
  type MailMessage
} from './model'

const SEND_PROMPT = '请用智能体邮箱（Agent Mail）发送邮件：'

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function dateLabel(value: null | string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function MyMailPage() {
  const text = useMailText()
  const profile = useValue(host.state.profile)
  const [status, setStatus] = useState<AgentMailStatus | null>(null)
  const [folders, setFolders] = useState<MailFolder[]>([])
  const [tab, setTab] = useState<'inbox' | 'sent'>('inbox')
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<null | number>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const statusRequest = useRef(0)
  const folderMap = useMemo(() => resolveMailFolders(folders), [folders])
  const folder = folderMap[tab]

  const load = useCallback(
    async (append = false) => {
      setLoading(!append)
      setError('')
      try {
        const result = query.trim()
          ? await searchMessages(profile, folder, query.trim())
          : await listMessages(profile, folder, append ? (cursor ?? undefined) : undefined)
        const normalized = result.emails.map(message => ({ ...message, folder: message.folder || folder }))
        setMessages(current => (append ? mergeMailMessages(current, normalized) : normalized))
        setCursor(result.nextBeforeUid)
      } catch (cause) {
        setError(errorText(cause, text.error))
      } finally {
        setLoading(false)
      }
    },
    [cursor, folder, profile, query, text.error]
  )

  useEffect(() => {
    let active = true
    const requestId = ++statusRequest.current

    setLoading(true)
    void mailStatus(profile)
      .then(async result => {
        if (!active || requestId !== statusRequest.current) return
        setStatus(result.status)
        if (result.status.enabled) {
          const listed = await listFolders(profile)
          if (active && requestId === statusRequest.current) setFolders(listed.folders)
        }
      })
      .catch(cause => {
        if (active && requestId === statusRequest.current) setError(errorText(cause, text.error))
      })
      .finally(() => active && setLoading(false))

    return () => {
      active = false
    }
  }, [profile, text.error])

  useEffect(() => {
    let active = true
    const refreshStatus = () => {
      const requestId = ++statusRequest.current

      void mailStatus(profile)
        .then(result => {
          if (active && requestId === statusRequest.current) setStatus(result.status)
        })
        .catch(cause => {
          if (active && requestId === statusRequest.current) setError(errorText(cause, text.error))
        })
    }

    window.addEventListener('focus', refreshStatus)
    return () => {
      active = false
      window.removeEventListener('focus', refreshStatus)
    }
  }, [profile, text.error])

  useEffect(() => {
    setSelected(new Set())
    setCursor(null)
    if (status?.enabled) void load(false)
    // `load` also contains the cursor used only by the append branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, profile, query, status?.enabled])

  const openComposer = (prompt = SEND_PROMPT) => {
    host.newChat(profile)
    window.setTimeout(() => void host.composer.setDraft('new', prompt), 180)
  }

  const enable = async () => {
    const requestId = ++statusRequest.current

    setBusy(true)
    setError('')
    try {
      const result = await enableMail(profile)

      if (requestId === statusRequest.current) {
        setStatus(result.status)
        const listed = await listFolders(profile)

        if (requestId === statusRequest.current) setFolders(listed.folders)
      }
    } catch (cause) {
      const result = await mailStatus(profile).catch(() => null)

      if (result && requestId === statusRequest.current) setStatus(result.status)
      setError(errorText(cause, text.error))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    const requestId = ++statusRequest.current

    setBusy(true)
    setError('')
    try {
      const result = await disableMail(profile)

      if (requestId === statusRequest.current) setStatus(result.status)
      setConfirmDisable(false)
    } catch (cause) {
      const result = await mailStatus(profile).catch(() => null)

      if (result && requestId === statusRequest.current) setStatus(result.status)
      setError(errorText(cause, text.error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const targets = messages.filter(message => selected.has(`${message.folder}:${message.uid}`))
    if (!targets.length) return
    setBusy(true)
    try {
      await Promise.all(targets.map(message => deleteMessage(profile, message.folder, message.uid)))
      setMessages(current => current.filter(message => !selected.has(`${message.folder}:${message.uid}`)))
      setSelected(new Set())
    } catch (cause) {
      setError(errorText(cause, text.error))
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (message: MailMessage) => {
    try {
      const full = await getMessage(profile, message.folder, message.uid)
      setDetail({ ...full, folder: message.folder })
      if (!message.seen) {
        await markRead(profile, message.folder, message.uid)
        setMessages(current => current.map(row => (row.uid === message.uid ? { ...row, seen: true } : row)))
      }
    } catch (cause) {
      setError(errorText(cause, text.error))
    }
  }

  if (!loading && status && !status.enabled) {
    return (
      <main className="flex h-full items-center justify-center bg-(--ui-panel-background) p-8">
        <section className="w-full max-w-xl rounded-3xl border border-border/70 bg-background p-10 text-center shadow-sm">
          <span className="mx-auto flex size-20 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Mail size={38} />
          </span>
          <h1 className="mt-6 text-2xl font-semibold">{text.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{text.enableHint}</p>
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          <Button className="mt-7 rounded-xl px-6" disabled={busy} onClick={() => void enable()}>
            {busy ? text.enabling : text.enable}
          </Button>
        </section>
      </main>
    )
  }

  const groups = groupMailMessages(messages)
  const groupLabels = { today: text.today, yesterday: text.yesterday, earlier: text.earlier }

  return (
    <main className="h-full overflow-y-auto bg-(--ui-panel-background)">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{text.title}</h1>
            <p className="mt-2 text-muted-foreground">{text.subtitle}</p>
          </div>
          <Button
            className="h-11 rounded-xl bg-slate-950 px-5 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-950"
            onClick={() => openComposer()}
          >
            <Send className="mr-2 size-4" />
            {text.compose}
          </Button>
        </header>

        {status && (
          <section className="mt-8 flex items-center gap-5 rounded-2xl border border-border/60 bg-background px-7 py-6 shadow-sm">
            <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Mail size={28} />
            </span>
            <strong className="text-xl">{status.email}</strong>
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="text-muted-foreground">{text.running}</span>
            <Button className="rounded-xl" variant="outline" onClick={() => setConfirmDisable(true)}>
              {text.disable}
            </Button>
            <span className="ml-auto text-muted-foreground">
              {text.todaySent}{' '}
              <b className="ml-2 text-2xl text-foreground">
                {status.todaySent}/{status.dailyQuota}
              </b>
            </span>
          </section>
        )}

        <section className="mt-7 flex flex-wrap items-center gap-3">
          <div className="flex rounded-xl bg-muted/70 p-1">
            {(['inbox', 'sent'] as const).map(value => (
              <button
                className={`rounded-lg px-5 py-2 text-sm transition ${tab === value ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
                key={value}
                onClick={() => setTab(value)}
              >
                {value === 'inbox' ? text.inbox : text.sent}
              </button>
            ))}
          </div>
          <Button disabled={!selected.size || busy} variant="ghost" onClick={() => void remove()}>
            <Trash2 className="mr-2 size-4" />
            {text.delete}
          </Button>
          <div className="relative ml-auto min-w-72 flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-11 rounded-xl pl-10"
              onChange={event => setQuery(event.target.value)}
              placeholder={text.search}
              value={query}
            />
          </div>
          <Button aria-label={text.refresh} size="icon" variant="outline" onClick={() => void load(false)}>
            <RefreshCw className="size-4" />
          </Button>
        </section>

        {error && <p className="mt-5 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {loading ? (
          <div className="py-20 text-center text-muted-foreground">{text.loading}</div>
        ) : groups.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">{text.empty}</div>
        ) : (
          <div className="mt-6 space-y-7">
            {groups.map(group => (
              <section key={group.key}>
                <h2 className="mb-3 px-2 text-sm font-medium text-muted-foreground">
                  {groupLabels[group.key as keyof typeof groupLabels]}{' '}
                  <span className="ml-2">({group.items.length})</span>
                </h2>
                <div className="space-y-3">
                  {group.items.map(message => {
                    const key = `${message.folder}:${message.uid}`
                    return (
                      <article
                        className={`flex cursor-pointer items-center gap-4 rounded-2xl border bg-background px-5 py-4 shadow-sm transition hover:border-foreground/20 ${message.seen ? 'border-border/60' : 'border-emerald-500/40'}`}
                        key={key}
                        onClick={() => void openDetail(message)}
                      >
                        <Checkbox
                          checked={selected.has(key)}
                          onCheckedChange={checked =>
                            setSelected(current => {
                              const next = new Set(current)
                              checked ? next.add(key) : next.delete(key)
                              return next
                            })
                          }
                          onClick={event => event.stopPropagation()}
                        />
                        <div className="min-w-0 flex-1">
                          <div className={`truncate ${message.seen ? '' : 'font-semibold'}`}>
                            {message.subject || '(无主题)'}
                          </div>
                          <div className="mt-1 truncate text-sm text-muted-foreground">
                            {tab === 'inbox'
                              ? addressLabel(message.from)
                              : message.to.map(addressLabel).filter(Boolean).join(', ')}{' '}
                            · {dateLabel(message.date)}
                          </div>
                        </div>
                        {message.hasAttachments && <span className="text-xs text-muted-foreground">附件</span>}
                      </article>
                    )
                  })}
                </div>
              </section>
            ))}
            {cursor && !query && (
              <div className="text-center">
                <Button variant="outline" onClick={() => void load(true)}>
                  {text.loadMore}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={Boolean(detail)} onOpenChange={open => !open && setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detail?.subject || '(无主题)'}</DialogTitle>
            <DialogDescription>
              {addressLabel(detail?.from ?? null)} · {dateLabel(detail?.date ?? null)}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="max-h-[55vh] overflow-y-auto rounded-xl border p-5 text-sm leading-7">
              {detail.html ? (
                <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(detail.html) }} />
              ) : (
                <div className="whitespace-pre-wrap">{detail.text}</div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                detail && openComposer(`请用智能体邮箱回复这封邮件（folder: ${detail.folder}, uid: ${detail.uid}）：`)
              }
            >
              {text.reply}
            </Button>
            <Button
              onClick={() =>
                detail && openComposer(`请用智能体邮箱转发这封邮件（folder: ${detail.folder}, uid: ${detail.uid}）：`)
              }
            >
              {text.forward}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{text.disable}</DialogTitle>
            <DialogDescription>{text.confirmDisable}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisable(false)}>
              {text.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void disable()}
            >
              {text.disable}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
