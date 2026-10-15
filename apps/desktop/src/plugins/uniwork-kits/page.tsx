/**
 * Kits — a standalone desktop page over `/api/plugins/uniwork-kits`.
 *
 * Experts are installed and removed here. An expert's forever-chat stays on
 * the Bots list; 「召唤」 opens a new chat with it, like the composer picker.
 */

import { atom, host, usePluginI18n, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'

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
import { $expertDirectory, loadExperts } from './experts-store'
import { oauthStartParams } from './oauth'
import { partition } from './partition'
import { publishInstalledExperts } from './roster'
import { installedExperts } from './roster-model'
import { summonExpert } from './summon'
import type { KitRow, UserField } from './types'

interface JobState {
  id: string
  tail: string
  running?: boolean
  exitCode?: null | number
}

export const $job = atom<JobState | null>(null)

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
    <div className="rounded border border-(--ui-stroke-secondary) px-2 py-1.5 text-xs">
      <div className="flex items-center gap-3">
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 flex-1 truncate text-(--ui-text-tertiary)">{lastLine(job.tail)}</span>
        {job.tail ? (
          <button className="shrink-0 underline" onClick={() => setOpen(value => !value)} type="button">
            {open ? t('hideDetails') : t('details')}
          </button>
        ) : null}
        {done ? (
          <button className="shrink-0 underline" onClick={() => $job.set(null)} type="button">
            {t('close')}
          </button>
        ) : null}
      </div>
      {open ? <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap">{job.tail}</pre> : null}
    </div>
  )
}

async function readFile(file: File): Promise<{ bytes: ArrayBuffer; filename: string }> {
  const bytes = await file.arrayBuffer()

  return { bytes, filename: file.name }
}

function Counts({ row, t }: { row: KitRow; t: (key: string) => string }) {
  return (
    <span className="text-xs text-(--ui-text-tertiary)">
      {t('skills')} {row.skill_count} · {t('agents')} {row.agent_count} · {t('mcp')} {row.mcp_count}
      {row.version ? ` · ${row.version}` : ''}
    </span>
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
      className="mt-2 grid gap-1"
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
        <label className="grid gap-0.5 text-xs" key={field.key}>
          <span>
            {field.title}
            {field.required ? ' *' : ''}
          </span>
          <input
            className="rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1"
            onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
            type={field.sensitive ? 'password' : 'text'}
            value={values[field.key] ?? ''}
          />
        </label>
      ))}
      <button className="w-fit text-xs underline" disabled={busy} type="submit">
        {t('saveConfig')}
      </button>
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
    <span className="text-xs">
      <button
        className="underline"
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
        type="button"
      >
        {t('authorize')}
      </button>
      {note ? <span className="ml-2 text-(--ui-text-tertiary)">{note}</span> : null}
    </span>
  )
}

function KitCard({ onChange, row }: { onChange: () => void; row: KitRow }) {
  const t = usePluginI18n('uniwork-kits')
  const [confirm, setConfirm] = useState(false)
  const [receipt, setReceipt] = useState('')
  const expert = row.kind === 'expert' && !row.self
  const directory = useValue($expertDirectory)
  const summonable = expert ? directory.experts.find(card => card.name === row.name) : undefined

  return (
    <article className="rounded-md border border-(--ui-stroke-secondary) p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{row.display_name}</div>
          <Counts row={row} t={t} />
        </div>
        {summonable ? (
          <button className="text-xs underline" onClick={() => summonExpert(summonable)} type="button">
            {t('summonButton')}
          </button>
        ) : null}
        {expert ? null : (
          <label className="flex items-center gap-1 text-xs">
            <input
              checked={row.enabled !== false}
              onChange={event => {
                void toggleKit(row.name, event.target.checked)
                  .then(onChange)
                  .catch(err => host.notify({ kind: 'error', message: String(err) }))
              }}
              type="checkbox"
            />
            {t('enable')}
          </label>
        )}
      </div>
      {row.missing_secrets.length > 0 ? (
        <p className="mt-1 text-xs text-(--ui-text-tertiary)">
          {t('missing')} {row.missing_secrets.join(', ')}
        </p>
      ) : null}
      <ConfigForm fields={row.user_config} name={row.name} onSaved={onChange} />
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {row.oauth_servers.map(server => (
          <Authorize key={server.key} profile={expert ? row.profile : undefined} serverKey={server.key} />
        ))}
        {expert ? null : (
          <button
            className="underline"
            onClick={() => {
              void refreshTriggers(row.name)
                .then(result => $job.set({ id: result.job.id, tail: '' }))
                .catch(err => host.notify({ kind: 'error', message: String(err) }))
            }}
            type="button"
          >
            {t('refresh')}
          </button>
        )}
        <button
          className="underline"
          onClick={() => {
            void fetchReceipt(row.name)
              .then(body => setReceipt(body.text))
              .catch(err => setReceipt(String(err)))
          }}
          type="button"
        >
          {t('receipt')}
        </button>
        <button
          className="underline"
          onClick={() => {
            if (expert && !confirm) {
              setConfirm(true)

              return
            }

            void uninstallKit(row.name, expert)
              .then(() => {
                setConfirm(false)
                onChange()
              })
              .catch(err => host.notify({ kind: 'error', message: String(err) }))
          }}
          type="button"
        >
          {confirm ? t('confirmExpert') : t('uninstall')}
        </button>
      </div>
      {receipt ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{receipt}</pre> : null}
    </article>
  )
}

export function KitsPage() {
  const t = usePluginI18n('uniwork-kits')
  const job = useValue($job)
  const catalog = useQuery({ queryFn: fetchCatalog, queryKey: ['uniwork-kits', 'catalog'] })
  const shelves = partition(catalog.data?.plugins ?? [])
  const reloadCatalog = catalog.refetch

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

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-medium">{t('title')}</h1>
        <label className="cursor-pointer text-xs underline">
          {t('installZip')}
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
            type="file"
          />
        </label>
      </div>
      {job ? <JobStatus job={job} /> : null}
      <section className="grid gap-2">
        <h2 className="text-sm font-medium">{t('kits')}</h2>
        {shelves.kits.length === 0 ? <p className="text-xs text-(--ui-text-tertiary)">{t('emptyKits')}</p> : null}
        {shelves.kits.map(row => (
          <KitCard key={row.name} onChange={() => void catalog.refetch()} row={row} />
        ))}
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-medium">{t('experts')}</h2>
        {shelves.experts.length === 0 ? <p className="text-xs text-(--ui-text-tertiary)">{t('emptyExperts')}</p> : null}
        {shelves.experts.map(row => (
          <KitCard
            key={row.name}
            onChange={() => {
              void catalog.refetch()
              void loadExperts()
            }}
            row={row}
          />
        ))}
      </section>
    </div>
  )
}
