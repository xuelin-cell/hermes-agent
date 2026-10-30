/**
 * Experts / Kits — the Extensions catalog over `/api/plugins/uniwork-kits`, laid out
 * like the Skills catalog (技能与工具): tabs with counts, a search box, and a
 * card grid. A card opens its details — settings and authorization live there.
 * A kit, like a skill, is only switched on or off (the switch sits beside its
 * title); the bundled kits and experts cannot be uninstalled.
 *
 * An expert's forever-chat stays on the Bots list; 「召唤」 opens a new chat
 * with it, like the composer picker.
 */

import './kits.css'

import {
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
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router'

import { fetchCatalog, installBundled, openAuthorization, toggleKit, uninstallKit, writeConfig } from './api'
import { $bundled, $bundledFinished, watchBundled } from './bundled'
import { ExpertFace } from './expert-face'
import { $expertDirectory, loadExperts } from './experts-store'
import { KITS_PATH } from './navigation'
import { oauthStartParams } from './oauth'
import { matchesQuery, partition } from './partition'
import { summonExpert } from './summon'
import { tryAskingPrompts } from './summon-model'
import type { ExpertCard, KitRow, UserField } from './types'

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

/** 卡片上「技能 N · 子代理 N · MCP N」这一行统计。 */
function countsText(row: KitRow, t: Translate): string {
  return [
    `${t('skills')} ${row.skill_count}`,
    row.agent_count ? `${t('agents')} ${row.agent_count}` : '',
    row.mcp_count ? `${t('mcp')} ${row.mcp_count}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 安静的小标签，样式和技能目录里的标签一致；卡片上截断长文字，详情里换行显示。 */
function Chip({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md bg-(--ui-bg-quaternary) px-2 py-0.5 text-[0.6875rem] leading-4 text-(--ui-text-primary)">
      <span className={wrap ? 'break-words' : 'truncate'}>{children}</span>
    </span>
  )
}

/** 找到卡片对应的专家资料；召唤名单里还没有时，用卡片自己的字段临时拼一份。 */
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
      try_asking: '',
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

/** 技能目录风格的卡片外框：点标题打开详情，整张卡片都可以点。 */
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

/** 套件卡片：名字、简介、触发词示例、统计和启用开关。 */
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
        row.installed === false ? <Button size="xs" onClick={() => {
          void installBundled(row.name).then(onChange).catch(error => host.notify({ kind: 'error', message: String(error) }))
        }}>{t('install')}</Button> : <Switch
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

/** 专家卡片：头像、名字、职业、简介和「召唤」按钮；专家包里的短问法不放（和召唤卡片一致）。 */
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
        <Button onClick={() => row.installed === false ? onOpen() : summonExpert(expert)} size="xs" variant="secondary">
          {row.installed === false ? t('install') : t('summonButton')}
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
    </CardShell>
  )
}

/** 包声明的配置项表单，保存后写进对应档案的 .env；敏感项用密码框。 */
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

/** MCP 的授权按钮：在浏览器里打开授权页，并轮询直到授权完成或超时。 */
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

              /** 每隔一段时间查一次授权结果，最多 30 次；页面关掉后停止。 */
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

/** 详情页里带标题的一节。 */
function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-xs font-medium text-(--ui-text-tertiary)">{title}</h3>
      {children}
    </section>
  )
}

/**
 * 卡片上放不下的内容：配置和授权。套件和技能页一样只能开关（开关在标题行右侧），
 * 专家只能召唤；内置的套件和专家都不给卸载，也不再有刷新触发词和查看安装记录。
 */
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
  const isExpert = Boolean(expert)
  const prompts = expert ? tryAskingPrompts(expert) : []

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        {/* 右侧留出关闭按钮的位置，开关和技能页一样跟在标题后面 */}
        <DialogTitle className="flex items-center gap-2.5 pr-7">
          {expert ? <ExpertFace expert={expert} size={32} /> : null}
          <span className="min-w-0 flex-1 truncate">{row.display_name}</span>
          {row.version ? (
            <Badge size="xs" variant="muted">
              v{row.version}
            </Badge>
          ) : null}
          {isExpert || row.installed === false ? null : (
            <Switch
              aria-label={t('enable')}
              checked={row.enabled !== false}
              onCheckedChange={checked => {
                void toggleKit(row.name, checked)
                  .then(onChange)
                  .catch(err => host.notify({ kind: 'error', message: String(err) }))
              }}
              size="xs"
            />
          )}
        </DialogTitle>
        <DialogDescription>{row.description || (isExpert ? `@${row.profile}` : countsText(row, t))}</DialogDescription>
      </DialogHeader>
      <div className="grid max-h-[60vh] gap-4 overflow-auto">
        <span className="text-xs text-(--ui-text-tertiary)">
          {isExpert ? [row.profession, `@${row.profile}`].filter(Boolean).join(' · ') : countsText(row, t)}
        </span>
        {prompts.length > 0 ? (
          <DetailSection title={t('tryAsking')}>
            <span className="flex flex-wrap gap-1">
              {prompts.map(prompt => (
                <Chip key={prompt} wrap>
                  {prompt}
                </Chip>
              ))}
            </span>
          </DetailSection>
        ) : null}
        {!isExpert && row.phrases.length > 0 ? (
          <DetailSection title={t('canSay')}>
            <span className="flex flex-wrap gap-1">
              {row.phrases.map(phrase => (
                <Chip key={phrase} wrap>
                  {phrase}
                </Chip>
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
              {window.hermesDesktop?.cloudKits ? <span>{t('cloudOAuthUnavailable')}</span> : row.oauth_servers.map(server => (
                <Authorize key={server.key} profile={isExpert ? row.profile : undefined} serverKey={server.key} />
              ))}
            </span>
          </DetailSection>
        ) : null}
      </div>
      {window.hermesDesktop?.cloudKits ? <DialogFooter>
        {row.installed === false ? <Button onClick={() => {
          void installBundled(row.name).then(() => { onChange(); onClose() })
            .catch(error => host.notify({ kind: 'error', message: String(error) }))
        }}>{t('install')}</Button> : <Button variant="secondary" onClick={() => {
          const message = t(isExpert ? 'confirmDeleteExpert' : 'confirmUninstall')
          if (!window.confirm(message)) { return }
          void uninstallKit(row.name, isExpert).then(() => { onChange(); onClose() })
            .catch(error => host.notify({ kind: 'error', message: String(error) }))
        }}>{t('uninstall')}</Button>}
      </DialogFooter> : null}
      {expert && row.installed !== false ? (
        <DialogFooter>
          <Button
            onClick={() => {
              onClose()
              summonExpert(expert)
            }}
            size="sm"
          >
            {t('summonButton')}
          </Button>
        </DialogFooter>
      ) : null}
    </DialogContent>
  )
}

type Shelf = 'experts' | 'kits'

/** 旧套件链接转到扩展；扩展正文复用同一份专家与套件目录。 */
export function KitsPage() {
  const { pathname } = useLocation()

  return pathname === '/kits' ? <Navigate replace to={KITS_PATH} /> : <KitsCatalog />
}

function KitsCatalog() {
  const t = usePluginI18n('uniwork-kits')
  const [params, setParams] = useSearchParams()
  const panelId = useId()
  const directory = useValue($expertDirectory)
  const catalog = useQuery({ queryFn: fetchCatalog, queryKey: ['uniwork-kits', 'catalog'] })
  const shelves = partition(catalog.data?.plugins ?? [])
  const reloadCatalog = catalog.refetch
  const shelf: Shelf = params.get('shelf') === 'kits' ? 'kits' : 'experts'
  const query = params.get('q') ?? ''
  const [opened, setOpened] = useState('')
  const bundled = useValue($bundled)
  const bundledFinished = useValue($bundledFinished)

  // The backend may still be putting the bundled kits in (a new account):
  // follow it, and show the full shelves once it is done.
  useEffect(() => {
    void watchBundled()
  }, [])

  useEffect(() => {
    if (bundledFinished) {
      void reloadCatalog()
    }
  }, [bundledFinished, reloadCatalog])

  /** 重新取目录和专家名单（开关、改设置之后调用）。 */
  const refresh = () => {
    void catalog.refetch()
    void loadExperts()
  }

  const rows = shelves[shelf].filter(row => matchesQuery(row, query))
  const openedRow = [...shelves.kits, ...shelves.experts].find(row => row.name === opened)
  const openedIsExpert = Boolean(openedRow && shelves.experts.includes(openedRow))

  const tabs: Array<{ id: Shelf; label: string; count: number }> = [
    { id: 'experts', label: t('experts'), count: shelves.experts.length },
    { id: 'kits', label: t('kits'), count: shelves.kits.length }
  ]

  const selectShelf = (nextShelf: Shelf) => {
    setParams(
      current => {
        const next = new URLSearchParams(current)

        if (nextShelf === 'kits') {
          next.set('shelf', nextShelf)
        } else {
          next.delete('shelf')
        }

        next.delete('q')

        return next
      },
      { replace: true }
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="kits-tabs">
        <div aria-label={t('title')} className="flex gap-2" role="tablist">
          {tabs.map(item => (
            <button
              aria-controls={panelId}
              aria-selected={shelf === item.id}
              className="kits-tab"
              id={panelId + '-' + item.id}
              key={item.id}
              onClick={() => selectShelf(item.id)}
              onKeyDown={event => {
                const other: Shelf = item.id === 'experts' ? 'kits' : 'experts'

                const targets: Record<string, Shelf> = {
                  ArrowLeft: other,
                  ArrowRight: other,
                  Home: 'experts',
                  End: 'kits'
                }

                const target = targets[event.key]

                if (!target) {
                  return
                }

                event.preventDefault()
                selectShelf(target)
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>('[id="' + panelId + '-' + target + '"]')
                  ?.focus()
              }}
              role="tab"
              tabIndex={shelf === item.id ? 0 : -1}
              type="button"
            >
              {item.label}
              <span className="ml-2 rounded-full bg-(--ui-bg-quaternary) px-2 py-0.5 text-xs">{item.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        aria-labelledby={panelId + '-' + shelf}
        className="min-h-0 flex-1 overflow-auto py-5"
        id={panelId}
        role="tabpanel"
      >
        {bundled.running ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quinary) px-3 py-2 text-xs">
            <Codicon className="shrink-0" name="loading" spinning />
            <span className="font-medium">{t('preparingKits')}</span>
            {bundled.total ? (
              <span className="text-(--ui-text-tertiary)">
                {bundled.done}/{bundled.total}
                {bundled.name ? ` · ${bundled.name}` : ''}
              </span>
            ) : null}
          </div>
        ) : null}
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
