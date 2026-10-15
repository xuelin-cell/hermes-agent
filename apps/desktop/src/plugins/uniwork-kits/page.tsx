/**
 * Kits — a standalone desktop page over `/api/plugins/uniwork-kits`, laid out
 * like the Skills catalog (技能与工具): tabs with counts, a search box, and a
 * card grid. A card opens its details — settings, authorization, triggers,
 * receipt and uninstall live there.
 *
 * Experts are installed and removed here. An expert's forever-chat stays on
 * the Bots list; 「召唤」 opens a new chat with it, like the composer picker.
 */

import './kits.css'

import {
  atom,
  Badge,
  Button,
  cn,
  Codicon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  host,
  Input,
  RowButton,
  Switch,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import {
  fetchCatalog,
  fetchJob,
  fetchReceipt,
  installZip,
  openAuthorization,
  refreshTriggers,
  toggleKit,
  uninstallKit,
  writeConfig
} from './api'
import { ExpertFace } from './expert-face'
import { $expertDirectory, loadExperts } from './experts-store'
import { oauthStartParams } from './oauth'
import { matchesQuery, partition } from './partition'
import { publishInstalledExperts } from './roster'
import { installedExperts } from './roster-model'
import { summonExpert } from './summon'
import type { ExpertCard, KitRow, UserField } from './types'

interface JobState {
  id: string
  tail: string
  running?: boolean
  exitCode?: null | number
}

export const $job = atom<JobState | null>(null)

type Translate = (key: string) => string

// Same palette as the Skills catalog cards. Whole class names, so Tailwind sees them.
const CARD_ACCENTS = [
  '[--kit-accent:var(--ui-blue)]',
  '[--kit-accent:var(--ui-orange)]',
  '[--kit-accent:var(--ui-purple)]',
  '[--kit-accent:var(--ui-green)]',
  '[--kit-accent:var(--ui-red)]',
  '[--kit-accent:var(--ui-cyan)]',
  '[--kit-accent:var(--ui-yellow)]'
]

const CARD_PHRASES = 4

/** The last non-empty line of a job log, for the one-line status. */
export function lastLine(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  return lines.at(-1) ?? ''
}

/** One status line for a background job; the full log only on request. */
function JobStatus({ job }: { job: JobState }) {
  const t = usePluginI18n('uniwork-kits')
  const [open, setOpen] = useState(false)
  const done = job.running === false
  const ok = done && job.exitCode === 0
  const label = !done ? t('job') : ok ? t('jobDone') : t('failed')

  return (
    <div className="mb-3 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
        <Codicon className="shrink-0" name={!done ? 'loading' : ok ? 'check' : 'error'} spinning={!done} />
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-(--ui-text-tertiary)">{lastLine(job.tail)}</span>
        {job.tail ? (
          <Button onClick={() => setOpen(value => !value)} size="xs" variant="ghost">
            {open ? t('hideDetails') : t('details')}
          </Button>
        ) : null}
        {done ? (
          <Button onClick={() => $job.set(null)} size="xs" variant="ghost">
            {t('close')}
          </Button>
        ) : null}
      </div>
      {open ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{job.tail}</pre> : null}
    </div>
  )
}

async function readFile(file: File): Promise<{ bytes: ArrayBuffer; filename: string }> {
  const bytes = await file.arrayBuffer()

  return { bytes, filename: file.name }
}

function countsText(row: KitRow, t: Translate): string {
  return [
    `${t('skills')} ${row.skill_count}`,
    row.agent_count ? `${t('agents')} ${row.agent_count}` : '',
    row.mcp_count ? `${t('mcp')} ${row.mcp_count}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/** A quiet chip, in the look of the catalog's tag chips. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md bg-(--ui-bg-quaternary) px-2 py-0.5 text-[0.6875rem] leading-4 text-(--ui-text-primary)">
      <span className="truncate">{children}</span>
    </span>
  )
}

function expertFor(row: KitRow, experts: ExpertCard[]): ExpertCard {
  return (
    experts.find(card => card.name === row.name) ?? {
      name: row.name,
      profile: row.profile,
      display_name: row.display_name,
      profession: row.profession,
      description: row.description,
      init_prompt: '',
      quick_prompts: [],
      tags: []
    }
  )
}

interface CardShellProps {
  accent: number
  action: ReactNode
  children: ReactNode
  heading: ReactNode
  label: string
  onOpen: () => void
}

/** The catalog card frame: the title opens the details; the whole card is its click area. */
function CardShell({ accent, action, children, heading, label, onOpen }: CardShellProps) {
  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-lg border',
        CARD_ACCENTS[accent % CARD_ACCENTS.length]
      )}
      data-kit-card
    >
      <div className="flex min-h-0 w-full flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <RowButton
            aria-haspopup="dialog"
            aria-label={label}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left font-semibold leading-snug after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--color-primary)"
            onClick={onOpen}
          >
            {heading}
          </RowButton>
          <span className="relative shrink-0 opacity-[.66] transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {action}
          </span>
        </div>
        {children}
      </div>
    </article>
  )
}

function KitTile({
  accent,
  onOpen,
  onChange,
  row
}: {
  accent: number
  onChange: () => void
  onOpen: () => void
  row: KitRow
}) {
  const t = usePluginI18n('uniwork-kits')
  const enabled = row.enabled !== false

  return (
    <CardShell
      accent={accent}
      action={
        <Switch
          aria-label={t('enable')}
          checked={enabled}
          onCheckedChange={checked => {
            void toggleKit(row.name, checked)
              .then(onChange)
              .catch(err => host.notify({ kind: 'error', message: String(err) }))
          }}
        />
      }
      heading={<span className="line-clamp-2 min-w-0 break-words text-lg">{row.display_name}</span>}
      label={row.display_name}
      onOpen={onOpen}
    >
      <span className="flex w-full items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        <span className="min-w-0 flex-1 truncate">{countsText(row, t)}</span>
        {row.version ? (
          <Badge size="xs" variant="muted">
            v{row.version}
          </Badge>
        ) : null}
      </span>
      {row.description ? (
        <span className="line-clamp-3 text-[length:var(--conversation-caption-font-size)] leading-relaxed text-(--ui-text-secondary)">
          {row.description}
        </span>
      ) : null}
      {row.missing_secrets.length > 0 ? (
        <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-orange)">
          {t('missing')} {row.missing_secrets.join('、')}
        </span>
      ) : null}
      {row.phrases.length > 0 ? (
        <span className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          {row.phrases.slice(0, CARD_PHRASES).map(phrase => (
            <Chip key={phrase}>{phrase}</Chip>
          ))}
        </span>
      ) : null}
    </CardShell>
  )
}

function ExpertTile({
  accent,
  expert,
  onOpen,
  row
}: {
  accent: number
  expert: ExpertCard
  onOpen: () => void
  row: KitRow
}) {
  const t = usePluginI18n('uniwork-kits')

  return (
    <CardShell
      accent={accent}
      action={
        <Button onClick={() => summonExpert(expert)} size="xs" variant="secondary">
          {t('summonButton')}
        </Button>
      }
      heading={
        <>
          <ExpertFace expert={expert} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg">{row.display_name}</span>
            {row.profession ? (
              <span className="block truncate text-xs font-normal text-(--ui-text-tertiary)">{row.profession}</span>
            ) : null}
          </span>
        </>
      }
      label={row.display_name}
      onOpen={onOpen}
    >
      <span className="flex w-full items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        <span className="min-w-0 flex-1 truncate">@{row.profile}</span>
        {row.version ? (
          <Badge size="xs" variant="muted">
            v{row.version}
          </Badge>
        ) : null}
      </span>
      {row.description ? (
        <span className="line-clamp-3 text-[length:var(--conversation-caption-font-size)] leading-relaxed text-(--ui-text-secondary)">
          {row.description}
        </span>
      ) : null}
      {expert.quick_prompts.length > 0 ? (
        <span className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          {expert.quick_prompts.slice(1, 3).map(prompt => (
            <Chip key={prompt}>{prompt}</Chip>
          ))}
        </span>
      ) : null}
    </CardShell>
  )
}

function ConfigForm({ name, fields, onSaved }: { fields: UserField[]; name: string; onSaved: () => void }) {
  const t = usePluginI18n('uniwork-kits')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  if (fields.length === 0) {
    return null
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={event => {
        event.preventDefault()
        const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))

        if (Object.keys(filled).length === 0) {
          return
        }

        setBusy(true)
        void writeConfig(name, filled)
          .then(() => {
            setValues({})
            onSaved()
          })
          .catch(err => host.notify({ kind: 'error', message: String(err) }))
          .finally(() => setBusy(false))
      }}
    >
      {fields.map(field => (
        <label className="grid gap-1 text-xs" key={field.key}>
          <span className="text-(--ui-text-secondary)">
            {field.title}
            {field.required ? ' *' : ''}
          </span>
          <Input
            onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
            type={field.sensitive ? 'password' : 'text'}
            value={values[field.key] ?? ''}
          />
        </label>
      ))}
      <Button className="w-fit" disabled={busy} size="sm" type="submit" variant="secondary">
        {t('saveConfig')}
      </Button>
    </form>
  )
}

function Authorize({ profile, serverKey }: { profile?: string; serverKey: string }) {
  const t = usePluginI18n('uniwork-kits')
  const [note, setNote] = useState('')
  const alive = useRef(true)

  // eslint-disable-next-line no-restricted-syntax -- mount flag, not an atom mirror
  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])

  return (
    <span className="flex items-center gap-2 text-xs">
      <Button
        onClick={() => {
          const params = oauthStartParams(serverKey, profile)
          setNote(t('authorizing'))
          void host
            .request<{ auth_url?: string; result?: { auth_url?: string; session_id?: string }; session_id?: string }>(
              'mcp.servers.oauth.start',
              params
            )
            .then(async started => {
              const payload = started.result ?? started
              const url = payload.auth_url
              const sessionId = payload.session_id

              if (url) {
                await openAuthorization(url)
              }

              if (!sessionId || !alive.current) {
                if (alive.current) {
                  setNote(t('failed'))
                }

                return
              }

              let tries = 0

              const poll = async () => {
                if (!alive.current || tries > 30) {
                  return
                }

                tries += 1

                const result = await host.request<{ result?: { status?: string }; status?: string }>(
                  'mcp.servers.oauth.poll',
                  { ...params, session_id: sessionId }
                )

                const status = (result.result ?? result).status

                if (!alive.current) {
                  return
                }

                if (status === 'approved') {
                  setNote(t('authorized'))

                  return
                }

                window.setTimeout(() => void poll(), 2000)
              }

              void poll()
            })
            .catch(err => {
              if (alive.current) {
                setNote(String(err))
              }
            })
        }}
        size="sm"
        variant="outline"
      >
        {t('authorize')} · {serverKey}
      </Button>
      {note ? <span className="text-(--ui-text-tertiary)">{note}</span> : null}
    </span>
  )
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-xs font-medium text-(--ui-text-tertiary)">{title}</h3>
      {children}
    </section>
  )
}

/** Everything a card does not show: settings, authorization, triggers, receipt, uninstall. */
function KitDetail({
  expert,
  onChange,
  onClose,
  row
}: {
  expert?: ExpertCard
  onChange: () => void
  onClose: () => void
  row: KitRow
}) {
  const t = usePluginI18n('uniwork-kits')
  const [confirm, setConfirm] = useState(false)
  const [receipt, setReceipt] = useState('')
  const isExpert = Boolean(expert)

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          {expert ? <ExpertFace expert={expert} size={32} /> : null}
          <span className="min-w-0 truncate">{row.display_name}</span>
          {row.version ? (
            <Badge size="xs" variant="muted">
              v{row.version}
            </Badge>
          ) : null}
        </DialogTitle>
        <DialogDescription>{row.description || (isExpert ? `@${row.profile}` : countsText(row, t))}</DialogDescription>
      </DialogHeader>
      <div className="grid max-h-[60vh] gap-4 overflow-auto">
        <span className="text-xs text-(--ui-text-tertiary)">
          {isExpert ? [row.profession, `@${row.profile}`].filter(Boolean).join(' · ') : countsText(row, t)}
        </span>
        {expert && expert.quick_prompts.length > 0 ? (
          <DetailSection title={t('tryAsking')}>
            <span className="flex flex-wrap gap-1">
              {expert.quick_prompts.map(prompt => (
                <Chip key={prompt}>{prompt}</Chip>
              ))}
            </span>
          </DetailSection>
        ) : null}
        {!isExpert && row.phrases.length > 0 ? (
          <DetailSection title={t('canSay')}>
            <span className="flex flex-wrap gap-1">
              {row.phrases.map(phrase => (
                <Chip key={phrase}>{phrase}</Chip>
              ))}
            </span>
          </DetailSection>
        ) : null}
        {row.user_config.length > 0 ? (
          <DetailSection title={t('settings')}>
            {row.missing_secrets.length > 0 ? (
              <span className="text-xs text-(--ui-orange)">
                {t('missing')} {row.missing_secrets.join('、')}
              </span>
            ) : null}
            <ConfigForm fields={row.user_config} name={row.name} onSaved={onChange} />
          </DetailSection>
        ) : null}
        {row.oauth_servers.length > 0 ? (
          <DetailSection title={t('authorizeTitle')}>
            <span className="flex flex-wrap gap-2">
              {row.oauth_servers.map(server => (
                <Authorize key={server.key} profile={isExpert ? row.profile : undefined} serverKey={server.key} />
              ))}
            </span>
          </DetailSection>
        ) : null}
        {receipt ? (
          <DetailSection title={t('receipt')}>
            <pre className="max-h-56 overflow-auto rounded-md bg-(--ui-bg-quinary) p-2 text-xs whitespace-pre-wrap">
              {receipt}
            </pre>
          </DetailSection>
        ) : null}
        {confirm ? <p className="m-0 text-xs text-(--ui-red)">{t('confirmExpert')}</p> : null}
      </div>
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <span className="flex flex-wrap gap-2">
          {isExpert ? null : (
            <Button
              onClick={() => {
                void refreshTriggers(row.name)
                  .then(result => $job.set({ id: result.job.id, tail: '' }))
                  .catch(err => host.notify({ kind: 'error', message: String(err) }))
              }}
              size="sm"
              variant="outline"
            >
              {t('refresh')}
            </Button>
          )}
          <Button
            onClick={() => {
              if (receipt) {
                setReceipt('')

                return
              }

              void fetchReceipt(row.name)
                .then(body => setReceipt(body.text || t('noReceipt')))
                .catch(err => setReceipt(String(err)))
            }}
            size="sm"
            variant="outline"
          >
            {receipt ? t('hideReceipt') : t('receipt')}
          </Button>
          <Button
            onClick={() => {
              if (isExpert && !confirm) {
                setConfirm(true)

                return
              }

              void uninstallKit(row.name, isExpert)
                .then(() => {
                  setConfirm(false)
                  onClose()
                  onChange()
                })
                .catch(err => host.notify({ kind: 'error', message: String(err) }))
            }}
            size="sm"
            variant="destructive"
          >
            {confirm ? t('confirmUninstall') : t('uninstall')}
          </Button>
        </span>
        {expert ? (
          <Button
            onClick={() => {
              onClose()
              summonExpert(expert)
            }}
            size="sm"
          >
            {t('summonButton')}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogContent>
  )
}

type Shelf = 'experts' | 'kits'

export function KitsPage() {
  const t = usePluginI18n('uniwork-kits')
  const job = useValue($job)
  const directory = useValue($expertDirectory)
  const catalog = useQuery({ queryFn: fetchCatalog, queryKey: ['uniwork-kits', 'catalog'] })
  const shelves = partition(catalog.data?.plugins ?? [])
  const reloadCatalog = catalog.refetch
  const [shelf, setShelf] = useState<Shelf>('kits')
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!job?.id) {
      return
    }

    let stopped = false
    let timer = 0

    const tick = () => {
      void fetchJob(job.id)
        .then(view => {
          if (stopped) {
            return
          }

          $job.set({ exitCode: view.exit_code, id: view.id, running: view.running, tail: view.tail })

          if (!view.running) {
            void reloadCatalog().then(next => {
              void publishInstalledExperts(installedExperts(next.data?.plugins ?? []))
            })
            void loadExperts()

            return
          }

          timer = window.setTimeout(tick, 1500)
        })
        .catch(() => undefined)
    }

    tick()

    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [job?.id, reloadCatalog])

  const refresh = () => {
    void catalog.refetch()
    void loadExperts()
  }

  const rows = shelves[shelf].filter(row => matchesQuery(row, query))
  const openedRow = [...shelves.kits, ...shelves.experts].find(row => row.name === opened)
  const openedIsExpert = Boolean(openedRow && shelves.experts.includes(openedRow))

  const tabs: Array<{ id: Shelf; label: string; count: number }> = [
    { id: 'kits', label: t('kits'), count: shelves.kits.length },
    { id: 'experts', label: t('experts'), count: shelves.experts.length }
  ]

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-end justify-between gap-4 border-b border-(--ui-stroke-secondary) px-5 pt-2">
        <div className="flex gap-7">
          {tabs.map(item => (
            <button
              className={cn(
                'relative pb-2 text-sm font-semibold text-(--ui-text-tertiary)',
                shelf === item.id &&
                  'text-(--ui-text-primary) after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-(--color-primary)'
              )}
              key={item.id}
              onClick={() => setShelf(item.id)}
              type="button"
            >
              {item.label}
              <span className="ml-2 rounded-full bg-(--ui-bg-quaternary) px-2 py-0.5 text-xs">{item.count}</span>
            </button>
          ))}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <label className="flex w-72 items-center gap-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3.5 py-1.5 focus-within:border-(--ui-stroke-secondary) hover:border-(--ui-stroke-secondary)">
            <Codicon className="text-(--ui-text-tertiary)" name="search" />
            <input
              aria-label={shelf === 'kits' ? t('searchKits') : t('searchExperts')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              onChange={event => setQuery(event.target.value)}
              placeholder={shelf === 'kits' ? t('searchKits') : t('searchExperts')}
              value={query}
            />
          </label>
          <Button onClick={() => fileInput.current?.click()} size="sm" variant="outline">
            <Codicon name="cloud-upload" />
            {t('installZip')}
          </Button>
          <input
            accept=".zip,application/zip"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0]

              event.target.value = ''

              if (!file) {
                return
              }

              void readFile(file)
                .then(payload => installZip(payload))
                .then(result => $job.set({ id: result.job.id, tail: '' }))
                .catch(err => host.notify({ kind: 'error', message: String(err) }))
            }}
            ref={fileInput}
            type="file"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {job ? <JobStatus job={job} /> : null}
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-(--ui-text-tertiary)">
            {query ? t('noMatch') : shelf === 'kits' ? t('emptyKits') : t('emptyExperts')}
          </p>
        ) : (
          <div className="kits-grid">
            {rows.map((row, index) =>
              shelf === 'experts' ? (
                <ExpertTile
                  accent={index}
                  expert={expertFor(row, directory.experts)}
                  key={row.name}
                  onOpen={() => setOpened(row.name)}
                  row={row}
                />
              ) : (
                <KitTile
                  accent={index}
                  key={row.name}
                  onChange={() => void catalog.refetch()}
                  onOpen={() => setOpened(row.name)}
                  row={row}
                />
              )
            )}
          </div>
        )}
      </div>
      <Dialog onOpenChange={open => !open && setOpened('')} open={Boolean(openedRow)}>
        {openedRow ? (
          <KitDetail
            expert={openedIsExpert ? expertFor(openedRow, directory.experts) : undefined}
            key={openedRow.name}
            onChange={refresh}
            onClose={() => setOpened('')}
            row={openedRow}
          />
        ) : null}
      </Dialog>
    </section>
  )
}
