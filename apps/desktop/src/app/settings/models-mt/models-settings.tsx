import { useStore } from '@nanostores/react'
import { IconGripVertical } from '@tabler/icons-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import {
  deleteCustomEndpoint,
  getCustomEndpoints,
  getEnvVars,
  getHermesConfigRecord,
  revealEnvVar,
  saveCustomEndpoint,
  saveHermesConfigRecord
} from '@/hermes'
import { ChevronDown, ChevronRight, Eye, EyeOff, Plus, Trash2, Zap } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { setMainModelAssignment } from '@/store/model-assignment'
import { notify, notifyError } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'

import { PAGE_INSET_X } from '../../layout-constants'
import { SettingsSkeleton } from '../primitives'

import {
  configPatch,
  currentRowKey,
  draftChanged,
  draftProblem,
  endpointWrite,
  type EndpointWrite,
  isPlanEndpoint,
  type ModelDraft,
  type ModelRow,
  newDraft,
  newEndpointId,
  orderRows,
  PLAN_KEY_ENV,
  presetBaseUrl,
  PROVIDER_KINDS,
  PROVIDER_LABEL,
  type ProviderKind,
  rowsFromEndpoints
} from './catalog'
import { useModelsCopy } from './copy'
import { prettifyModelId } from './model-name'

interface ModelsSettingsProps {
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
}

interface Loaded {
  defaultKey: null | string
  order: string[]
  planUrl?: string
}

const ORDER_KEY = 'uniwork.desktop.models.order.v1'

/** 列表顺序只是展示偏好，按 Profile 存在本账号的浏览器分区里；读不到就按默认顺序。 */
function readOrder(profile: string | undefined): string[] {
  try {
    const raw = window.localStorage.getItem(`${ORDER_KEY}:${profile ?? ''}`)
    const parsed: unknown = raw ? JSON.parse(raw) : []

    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

function writeOrder(profile: string | undefined, keys: readonly string[]): void {
  try {
    window.localStorage.setItem(`${ORDER_KEY}:${profile ?? ''}`, JSON.stringify(keys))
  } catch {
    // 存不下只影响下次的排列，不影响模型配置。
  }
}

function rowName(row: ModelRow, untitled: string): string {
  return row.draft.displayName.trim() || prettifyModelId(row.draft.model) || untitled
}

/** 设置里的「模型」页：套餐模型只读，自定义模型可增删改，第一个为默认，改完统一保存。 */
export function ModelsSettings({ onConfigSaved, onMainModelChanged }: ModelsSettingsProps) {
  const t = useModelsCopy()
  const scopeProfile = useStore($settingsRequestProfile)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState<Loaded>({ defaultKey: null, order: [] })
  const [rows, setRows] = useState<ModelRow[]>([])
  const [deleted, setDeleted] = useState<ModelRow[]>([])
  const [expanded, setExpanded] = useState<null | string>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ModelRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [planKey, setPlanKey] = useState<{ preview: string; set: boolean }>({ preview: '', set: false })
  const [revealedKey, setRevealedKey] = useState<null | string>(null)
  const [visibleKeys, setVisibleKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [dragKey, setDragKey] = useState<null | string>(null)
  const [dropTarget, setDropTarget] = useState<{ half: 'bottom' | 'top'; key: string } | null>(null)
  const dragFromHandle = useRef(false)
  const loadToken = useRef(0)

  const load = useCallback(async () => {
    const token = ++loadToken.current

    try {
      const [response, config, env] = await Promise.all([
        getCustomEndpoints(scopeProfile),
        getHermesConfigRecord(scopeProfile, { includeDefaults: false }).catch(() => ({}) as Record<string, unknown>),
        getEnvVars(scopeProfile).catch(() => ({}) as Awaited<ReturnType<typeof getEnvVars>>)
      ])

      if (token !== loadToken.current) {
        return
      }

      const all = rowsFromEndpoints(response.endpoints, (config as Record<string, unknown>).providers)
      const defaultKey = currentRowKey(all, response.current)
      const ordered = orderRows(all, readOrder(scopeProfile), defaultKey)
      const keyInfo = env[PLAN_KEY_ENV]

      setRows(ordered)
      setDeleted([])
      setLoaded({
        defaultKey,
        order: ordered.map(row => row.key),
        planUrl: response.endpoints.find(isPlanEndpoint)?.base_url
      })
      setPlanKey({ preview: keyInfo?.redacted_value ?? '', set: Boolean(keyInfo?.is_set) })
      setRevealedKey(null)
    } catch (error) {
      if (token === loadToken.current) {
        notifyError(error, t('loadFailed'))
      }
    } finally {
      if (token === loadToken.current) {
        setLoading(false)
      }
    }
  }, [scopeProfile, t])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(
    () =>
      deleted.length > 0 ||
      rows.some(row => !row.plan && draftChanged(row)) ||
      rows.map(row => row.key).join('\n') !== loaded.order.join('\n'),
    [deleted, loaded.order, rows]
  )

  const updateDraft = (key: string, updates: Partial<ModelDraft>) => {
    setRows(current => current.map(row => (row.key === key ? { ...row, draft: { ...row.draft, ...updates } } : row)))
  }

  const changeKind = (row: ModelRow, kind: ProviderKind) => {
    if (kind === row.draft.kind) {
      return
    }

    // 地址还是上一个服务商的预设时跟着换；用户自己填过的保留。
    const presetBefore = presetBaseUrl(row.draft.kind, loaded.planUrl)

    const baseUrl =
      !row.draft.baseUrl.trim() || row.draft.baseUrl === presetBefore
        ? presetBaseUrl(kind, loaded.planUrl)
        : row.draft.baseUrl

    updateDraft(row.key, { apiKey: '', baseUrl, kind })
  }

  const addModel = (kind: ProviderKind) => {
    const id = newEndpointId()
    const row: ModelRow = { draft: newDraft(kind, loaded.planUrl), endpointId: id, key: `new:${id}`, plan: false }
    setRows(current => [...current, row])
    setPickerOpen(false)
    setExpanded(row.key)
  }

  const removeRow = (row: ModelRow) => {
    setRows(current => current.filter(candidate => candidate.key !== row.key))

    if (row.original) {
      setDeleted(current => [...current, row])
    }

    if (expanded === row.key) {
      setExpanded(null)
    }
  }

  const moveRow = (fromKey: string, toKey: string, half: 'bottom' | 'top') => {
    setRows(current => {
      const moving = current.find(row => row.key === fromKey)

      if (!moving || fromKey === toKey) {
        return current
      }

      const rest = current.filter(row => row.key !== fromKey)
      const targetIndex = rest.findIndex(row => row.key === toKey)
      rest.splice(targetIndex < 0 ? rest.length : half === 'bottom' ? targetIndex + 1 : targetIndex, 0, moving)

      return rest
    })
  }

  const makeDefault = (key: string) => {
    setRows(current => {
      const row = current.find(candidate => candidate.key === key)

      return row ? [row, ...current.filter(candidate => candidate.key !== key)] : current
    })
  }

  const toggleRevealPlanKey = async () => {
    if (revealedKey !== null) {
      setRevealedKey(null)

      return
    }

    try {
      const { value } = await revealEnvVar(PLAN_KEY_ENV, scopeProfile)
      setRevealedKey(value)
    } catch (error) {
      notifyError(error, t('revealFailed'))
    }
  }

  const save = async () => {
    for (const row of rows) {
      if (row.plan || !draftChanged(row)) {
        continue
      }

      const problem = draftProblem(row.draft)

      if (problem) {
        const name = rowName(row, t('untitled'))
        setExpanded(row.key)
        notify({ kind: 'warning', message: problem === 'model' ? t('needModel', name) : t('needUrl', name) })

        return
      }
    }

    setSaving(true)

    try {
      for (const row of deleted) {
        await deleteCustomEndpoint(row.endpointId, scopeProfile)
      }

      const writes: { endpointId: string; write: EndpointWrite }[] = []
      const savedIds = new Map<string, string>()

      for (const row of rows) {
        if (row.plan || !draftChanged(row)) {
          continue
        }

        const write = endpointWrite(row)
        const response = await saveCustomEndpoint(write.payload, scopeProfile)
        const endpointId = response.id ?? row.endpointId
        savedIds.set(row.key, endpointId)
        writes.push({ endpointId, write })
      }

      const patch = configPatch(writes)

      if (patch) {
        await saveHermesConfigRecord(patch, scopeProfile)
      }

      const first = rows[0]
      const defaultGone = loaded.defaultKey !== null && deleted.some(row => row.key === loaded.defaultKey)

      if (first && (first.key !== loaded.defaultKey || defaultGone)) {
        const provider = `custom:${savedIds.get(first.key) ?? first.endpointId}`
        const model = first.draft.model.trim()
        await setMainModelAssignment({ model, provider }, scopeProfile)
        onMainModelChanged?.(provider, model)
      }

      writeOrder(
        scopeProfile,
        rows.map(row => (savedIds.has(row.key) && !row.original ? `custom:${savedIds.get(row.key)}` : row.key))
      )
      notify({ kind: 'success', message: t('saved') })
      onConfigSaved?.()
    } catch (error) {
      notifyError(error, t('saveFailed'))
    } finally {
      setSaving(false)
      setExpanded(null)
      await load()
    }
  }

  if (loading) {
    return <SettingsSkeleton sections={[{ rows: 4 }]} />
  }

  const defaultKey = rows[0]?.key

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('min-h-0 flex-1 overflow-y-auto pb-6', PAGE_INSET_X)}>
        <p className="mb-3 text-sm text-muted-foreground">{t('hint')}</p>

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <div className="divide-y divide-border/50">
            {rows.map(row => {
              const isOpen = !row.plan && expanded === row.key
              const name = rowName(row, t('untitled'))

              return (
                <div
                  className={cn(
                    'group relative',
                    dropTarget?.key === row.key &&
                      dropTarget.half === 'top' &&
                      'shadow-[inset_0_2px_0_var(--ui-accent)]',
                    dropTarget?.key === row.key &&
                      dropTarget.half === 'bottom' &&
                      'shadow-[inset_0_-2px_0_var(--ui-accent)]',
                    dragKey === row.key && 'opacity-50'
                  )}
                  draggable
                  key={row.key}
                  onDragEnd={() => {
                    if (dragKey && dropTarget) {
                      moveRow(dragKey, dropTarget.key, dropTarget.half)
                    }

                    setDragKey(null)
                    setDropTarget(null)
                  }}
                  onDragOver={event => {
                    if (!dragKey) {
                      return
                    }

                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    setDropTarget({ half: event.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom', key: row.key })
                  }}
                  onDragStart={event => {
                    if (!dragFromHandle.current) {
                      event.preventDefault()

                      return
                    }

                    dragFromHandle.current = false
                    event.dataTransfer.effectAllowed = 'move'
                    setDragKey(row.key)
                  }}
                >
                  <div
                    className={cn('flex items-center gap-2 py-3 pr-1', !row.plan && 'cursor-pointer')}
                    onClick={() => !row.plan && setExpanded(isOpen ? null : row.key)}
                  >
                    <span
                      aria-label={t('dragHandle')}
                      className="flex w-4 shrink-0 cursor-grab items-center text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100"
                      onMouseDown={() => {
                        dragFromHandle.current = true
                      }}
                      onMouseUp={() => {
                        dragFromHandle.current = false
                      }}
                      title={t('dragHandle')}
                    >
                      <IconGripVertical size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{name}</span>
                        {row.key === defaultKey && (
                          <span className="shrink-0 text-xs font-medium text-(--ui-accent)">{t('defaultBadge')}</span>
                        )}
                        {!row.plan && (
                          <span className="shrink-0 text-xs font-medium text-(--ui-accent)">{t('customBadge')}</span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {PROVIDER_LABEL[row.draft.kind]}
                        {row.draft.model.trim() ? ` · ${row.draft.model.trim()}` : ''}
                      </div>
                    </div>
                    {row.key !== defaultKey && (
                      <Button
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={event => {
                          event.stopPropagation()
                          makeDefault(row.key)
                        }}
                        size="xs"
                        variant="ghost"
                      >
                        {t('setDefault')}
                      </Button>
                    )}
                    {!row.plan && (
                      <>
                        <Button
                          aria-label={t('delete')}
                          onClick={event => {
                            event.stopPropagation()
                            setPendingDelete(row)
                          }}
                          size="icon-sm"
                          title={t('delete')}
                          variant="ghost"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                        {isOpen ? (
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        )}
                      </>
                    )}
                  </div>

                  {isOpen && (
                    <ModelEditor
                      keyVisible={visibleKeys.has(row.key)}
                      onChange={updates => updateDraft(row.key, updates)}
                      onKindChange={kind => changeKind(row, kind)}
                      onToggleKey={() =>
                        setVisibleKeys(current => {
                          const next = new Set(current)

                          if (next.has(row.key)) {
                            next.delete(row.key)
                          } else {
                            next.add(row.key)
                          }

                          return next
                        })
                      }
                      row={row}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {pickerOpen ? (
          <div className="mt-4 rounded-lg border border-dashed border-border/70 p-4">
            <div className="mb-3 text-xs font-medium text-muted-foreground">{t('chooseProvider')}</div>
            <div className="flex flex-wrap gap-2">
              {PROVIDER_KINDS.map(kind => (
                <Button key={kind} onClick={() => addModel(kind)} size="sm" variant="outline">
                  {PROVIDER_LABEL[kind]}
                </Button>
              ))}
            </div>
            <button
              className="mt-3 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setPickerOpen(false)}
              type="button"
            >
              {t('cancel')}
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <Button className="border-dashed" onClick={() => setPickerOpen(true)} size="sm" variant="outline">
              <Plus className="size-4" />
              {t('addModel')}
            </Button>
          </div>
        )}

        <div className="mt-6 rounded-xl border border-border/60 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Zap className="size-3.5 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">{t('yuanjingKey')}</span>
            <span className="text-xs text-muted-foreground">{t('yuanjingKeyDesc')}</span>
          </div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('apiKey')}</label>
          <Input
            readOnly
            suffix={
              planKey.set ? (
                <button
                  aria-label={revealedKey !== null ? t('hide') : t('show')}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void toggleRevealPlanKey()}
                  title={revealedKey !== null ? t('hide') : t('show')}
                  type="button"
                >
                  {revealedKey !== null ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </button>
              ) : undefined
            }
            type={revealedKey !== null ? 'text' : 'password'}
            value={revealedKey ?? (planKey.set ? '••••••••' : '')}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {planKey.set ? t('yuanjingKeyManaged') : t('yuanjingKeyMissing')}
          </p>
        </div>
      </div>

      <div className={cn('flex shrink-0 items-center justify-end gap-3 border-t border-border/50 pt-3', PAGE_INSET_X)}>
        {dirty && !saving && <span className="text-xs italic text-muted-foreground">{t('unsaved')}</span>}
        <Button disabled={!dirty || saving} onClick={() => void save()} size="sm">
          {saving ? t('saving') : dirty ? t('save') : t('noChanges')}
        </Button>
      </div>

      <ConfirmDialog
        confirmLabel={t('delete')}
        description={t('deleteBody')}
        destructive
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            removeRow(pendingDelete)
          }

          setPendingDelete(null)
        }}
        open={pendingDelete !== null}
        title={pendingDelete ? t('deleteTitle', rowName(pendingDelete, t('untitled'))) : ''}
      />
    </div>
  )
}

interface ModelEditorProps {
  keyVisible: boolean
  onChange: (updates: Partial<ModelDraft>) => void
  onKindChange: (kind: ProviderKind) => void
  onToggleKey: () => void
  row: ModelRow
}

/** 展开后的自定义模型表单：服务商、模型 ID、显示名称、密钥、地址、上下文窗口、看图。 */
function ModelEditor({ keyVisible, onChange, onKindChange, onToggleKey, row }: ModelEditorProps) {
  const t = useModelsCopy()
  const { draft } = row
  const yuanjing = draft.kind === 'yuanjing'

  return (
    <div className="mb-3 ml-6 grid gap-3 rounded-xl border border-border/60 p-4">
      <Field label={t('provider')}>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-border/60">
          {PROVIDER_KINDS.map(kind => (
            <button
              className={cn(
                'border-r border-border/60 px-2 py-1.5 text-xs last:border-r-0',
                draft.kind === kind
                  ? 'bg-(--ui-accent)/10 font-semibold text-(--ui-accent)'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
              key={kind}
              onClick={() => onKindChange(kind)}
              type="button"
            >
              {PROVIDER_LABEL[kind]}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('modelId')}>
          <Input
            onChange={event => onChange({ model: event.target.value })}
            placeholder={t('modelIdPlaceholder')}
            value={draft.model}
          />
        </Field>
        <Field label={t('displayName')}>
          <Input
            onChange={event => onChange({ displayName: event.target.value })}
            placeholder={prettifyModelId(draft.model) || t('displayNamePlaceholder')}
            value={draft.displayName}
          />
        </Field>
      </div>

      <Field hint={yuanjing ? t('apiKeyManaged') : undefined} label={t('apiKey')}>
        <Input
          autoComplete="off"
          disabled={yuanjing}
          onChange={event => onChange({ apiKey: event.target.value })}
          placeholder={yuanjing ? '••••••••' : draft.hasOwnKey ? t('apiKeyKept') : 'sk-...'}
          suffix={
            yuanjing ? undefined : (
              <button
                aria-label={keyVisible ? t('hide') : t('show')}
                className="text-muted-foreground hover:text-foreground"
                onClick={onToggleKey}
                type="button"
              >
                {keyVisible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </button>
            )
          }
          type={keyVisible ? 'text' : 'password'}
          value={yuanjing ? '' : draft.apiKey}
        />
      </Field>

      <Field label={t('baseUrl')}>
        <Input
          onChange={event => onChange({ baseUrl: event.target.value })}
          placeholder="https://api.example.com/v1"
          value={draft.baseUrl}
        />
      </Field>

      <div className="h-px bg-border/50" />

      <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-3">
        <Field label={t('contextWindow')}>
          <Input
            inputMode="numeric"
            onChange={event => onChange({ contextWindow: event.target.value.replace(/\D/g, '') })}
            placeholder="200000"
            value={draft.contextWindow}
          />
        </Field>
        <Field hint={t('imageHint')} label={t('inputModalities')}>
          <div className="flex w-fit overflow-hidden rounded-lg border border-border/60 text-xs">
            <span className="border-r border-border/60 bg-(--ui-accent)/10 px-3 py-1.5 font-semibold text-(--ui-accent)">
              Text
            </span>
            <button
              aria-pressed={draft.vision}
              className={cn(
                'px-3 py-1.5',
                draft.vision
                  ? 'bg-(--ui-accent)/10 font-semibold text-(--ui-accent)'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
              onClick={() => onChange({ vision: !draft.vision })}
              type="button"
            >
              Image
            </button>
          </div>
        </Field>
      </div>
    </div>
  )
}

function Field({ children, hint, label }: { children: ReactNode; hint?: string; label: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">
        {label}
        {hint && <span className="ml-2 text-[0.7rem] text-muted-foreground/70">{hint}</span>}
      </span>
      {children}
    </div>
  )
}
