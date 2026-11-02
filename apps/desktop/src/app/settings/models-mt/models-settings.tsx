import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import {
  deleteCustomEndpoint,
  getCustomEndpoints,
  getHermesConfigRecord,
  saveCustomEndpoint,
  saveHermesConfigRecord,
  validateCustomEndpoint
} from '@/hermes'
import { setMainModelAssignment } from '@/store/model-assignment'
import { notifyError } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'

import { PAGE_INSET_X } from '../../layout-constants'

import {
  configPatch,
  draftProblem,
  endpointWrite,
  type ModelRow,
  newDraft,
  newEndpointId,
  ORDER_KEY,
  orderRows,
  readOrder,
  rowsFromEndpoints
} from './catalog'
import { useModelsCopy } from './copy'

interface ModelsSettingsProps {
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
}

export function ModelsSettings({ onConfigSaved, onMainModelChanged }: ModelsSettingsProps) {
  const t = useModelsCopy()
  const profile = useStore($settingsRequestProfile)
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<ModelRow[]>([])
  const [editor, setEditor] = useState<ModelRow | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ModelRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)
  const [results, setResults] = useState<Record<string, { ok?: boolean; message: string }>>({})
  const generation = useRef(0)
  const testGeneration = useRef(0)

  const add = () => {
    const id = newEndpointId()
    setEditor({
      key: `new:${id}`,
      endpointId: id,
      plan: false,
      draft: { ...newDraft('compatible', undefined), thinking: 'auto', modalities: ['text'] }
    })
  }

  const load = useCallback(async () => {
    const token = ++generation.current

    try {
      const [response, config] = await Promise.all([
        getCustomEndpoints(profile),
        getHermesConfigRecord(profile, { includeDefaults: false })
      ])

      if (token === generation.current) {
        setRows(
          orderRows(
            rowsFromEndpoints(response.endpoints, config.providers).filter(row => !row.plan),
            readOrder(profile),
            null
          )
        )
      }
    } catch (error) {
      notifyError(error, t('loadFailed'))
    } finally {
      if (token === generation.current) {
        setLoading(false)
      }
    }
  }, [profile, t])

  useEffect(() => {
    void load()

    return () => {
      generation.current++
      testGeneration.current++
    }
  }, [load])
  useEffect(() => {
    if (params.get('addModel') === '1') {
      add()
      const next = new URLSearchParams(params)
      next.delete('addModel')
      setParams(next, { replace: true })
    }
  }, [params, setParams])

  const update = (updates: Partial<ModelRow['draft']>) => {
    if (!editor) {
      return
    }
    testGeneration.current++
    setResults(current => {
      const next = { ...current }
      delete next[editor.key]

      return next
    })
    setEditor({ ...editor, draft: { ...editor.draft, ...updates } })
  }

  const valid = (row: ModelRow) => !draftProblem(row.draft) && Boolean(row.draft.apiKey.trim() || row.draft.hasOwnKey)

  const test = async (row: ModelRow) => {
    const token = ++testGeneration.current
    setResults(current => ({ ...current, [row.key]: { message: t('testing') } }))

    try {
      const result = await validateCustomEndpoint(endpointWrite(row).payload, profile)

      if (token === testGeneration.current) {
        setResults(current => ({
          ...current,
          [row.key]: { ok: result.ok, message: result.ok ? t('connected') : `${t('failed')}: ${result.message}` }
        }))
      }
    } catch (error) {
      if (token === testGeneration.current) {
        setResults(current => ({ ...current, [row.key]: { ok: false, message: `${t('failed')}: ${String(error)}` } }))
      }
    }
  }

  const save = async () => {
    if (!editor || !valid(editor)) {
      return
    }
    setBusy(true)

    try {
      const write = endpointWrite(editor)
      const result = await saveCustomEndpoint(write.payload, profile)
      const id = result.id ?? editor.endpointId
      const patch = configPatch([{ endpointId: id, write }])

      if (patch) {
        await saveHermesConfigRecord(patch, profile)
      }
      const provider = `custom:${id}`
      await setMainModelAssignment({ provider, model: write.model }, profile)
      onMainModelChanged?.(provider, write.model)
      window.localStorage.setItem(
        `${ORDER_KEY}:${profile ?? ''}`,
        JSON.stringify([`custom:${id}`, ...rows.filter(row => row.endpointId !== id).map(row => row.key)])
      )
      onConfigSaved?.()
      setEditor(null)
      await load()
    } catch (error) {
      notifyError(error, t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!pendingDelete) {
      return
    }
    setBusy(true)

    try {
      await deleteCustomEndpoint(pendingDelete.endpointId, profile)
      setPendingDelete(null)
      onConfigSaved?.()
      await load()
    } catch (error) {
      notifyError(error, t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const result = (key: string) =>
    results[key] && (
      <p
        className={
          results[key].ok === false
            ? 'text-sm text-destructive'
            : results[key].ok
              ? 'text-sm text-green-600'
              : 'text-sm text-muted-foreground'
        }
        role="status"
      >
        {results[key].message}
      </p>
    )

  return (
    <div className={`min-h-0 flex-1 overflow-y-auto pb-6 ${PAGE_INSET_X}`}>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">
          {editor ? t(editor.original ? 'editModel' : 'addModel') : t('customTitle')}
        </h2>
        {!editor && (
          <Button onClick={add} size="sm">
            {t('addModel')}
          </Button>
        )}
      </div>
      {editor ? (
        <div className="grid max-w-xl gap-5">
          <label className="grid gap-2 text-sm">
            {t('baseUrl')} *
            <Input
              onChange={event => update({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
              value={editor.draft.baseUrl}
            />
          </label>
          <label className="grid gap-2 text-sm">
            {t('apiKey')} *
            <Input
              autoComplete="off"
              onChange={event => update({ apiKey: event.target.value })}
              placeholder={editor.draft.hasOwnKey ? t('apiKeyKept') : 'sk-...'}
              suffix={
                <button onClick={() => setVisible(!visible)} type="button">
                  {t(visible ? 'hide' : 'show')}
                </button>
              }
              type={visible ? 'text' : 'password'}
              value={editor.draft.apiKey}
            />
          </label>
          <label className="grid gap-2 text-sm">
            {t('modelId')} *
            <Input
              onChange={event => update({ model: event.target.value })}
              placeholder="gpt-4o"
              value={editor.draft.model}
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm">{t('thinking')}</legend>
            <div className="flex gap-2">
              {(['auto', 'on', 'off'] as const).map(value => (
                <Button
                  key={value}
                  onClick={() => update({ thinking: value })}
                  variant={(editor.draft.thinking ?? 'auto') === value ? 'secondary' : 'ghost'}
                >
                  {t(value)}
                </Button>
              ))}
            </div>
          </fieldset>
          <label className="grid gap-2 text-sm">
            {t('contextWindow')} (tokens)
            <Input
              min={1}
              onChange={event => update({ contextWindow: event.target.value })}
              placeholder="200000"
              type="number"
              value={editor.draft.contextWindow}
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm">{t('inputModalities')}</legend>
            <div className="flex flex-wrap gap-2">
              {['text', 'image', 'audio', 'video', 'pdf'].map(value => {
                const modalities = editor.draft.modalities ?? ['text', ...(editor.draft.vision ? ['image'] : [])]
                const selected = modalities.includes(value)

                return (
                  <Button
                    aria-pressed={selected}
                    key={value}
                    onClick={() => {
                      const next = selected ? modalities.filter(item => item !== value) : [...modalities, value]

                      if (next.length) {
                        update({ modalities: next, vision: next.includes('image') })
                      }
                    }}
                    variant={selected ? 'secondary' : 'ghost'}
                  >
                    {value === 'pdf' ? 'Pdf' : value[0].toUpperCase() + value.slice(1)}
                  </Button>
                )
              })}
            </div>
          </fieldset>
          {result(editor.key)}
          <div className="flex justify-between gap-2">
            <Button
              disabled={
                !valid(editor) ||
                (results[editor.key]?.ok === undefined && results[editor.key]?.message === t('testing'))
              }
              onClick={() => void test(editor)}
              variant="outline"
            >
              {results[editor.key]?.message === t('testing') ? t('testing') : t('test')}
            </Button>
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() => {
                  testGeneration.current++
                  setEditor(null)
                }}
                variant="ghost"
              >
                {t('cancel')}
              </Button>
              <Button disabled={busy || !valid(editor)} onClick={() => void save()}>
                {t(busy ? 'saving' : 'save')}
              </Button>
            </div>
          </div>
        </div>
      ) : loading ? (
        <p>{t('loading')}</p>
      ) : rows.length ? (
        rows.map(row => (
          <div className="border-b border-border/50 py-4" key={row.key}>
            <div className="flex items-center gap-2">
              <button
                className="min-w-0 flex-1 truncate text-left text-sm"
                onClick={() => setEditor({ ...row, draft: { ...row.draft } })}
              >
                {row.draft.model}
              </button>
              <Button onClick={() => setEditor({ ...row, draft: { ...row.draft } })} size="sm" variant="ghost">
                {t('editModel')}
              </Button>
              <Button
                disabled={results[row.key]?.message === t('testing')}
                onClick={() => void test(row)}
                size="sm"
                variant="ghost"
              >
                {t('test')}
              </Button>
              <Button onClick={() => setPendingDelete(row)} size="sm" variant="ghost">
                {t('delete')}
              </Button>
            </div>
            {result(row.key)}
          </div>
        ))
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>
      )}
      <ConfirmDialog
        confirmLabel={t('delete')}
        description={t('deleteBody')}
        destructive
        onClose={() => !busy && setPendingDelete(null)}
        onConfirm={() => void remove()}
        open={pendingDelete !== null}
        title={t('deleteTitle', pendingDelete?.draft.model ?? '')}
      />
    </div>
  )
}
