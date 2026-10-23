import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Field, FieldHint } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import type { FormError, FormTransport, KeyValueRow, ServerForm } from './server-form-model'

const TRANSPORTS = [
  { id: 'http', label: 'HTTP' },
  { id: 'stdio', label: 'Stdio' }
] as const satisfies readonly { id: FormTransport; label: string }[]

export interface ServerFormFieldsProps {
  autoFocusName?: boolean
  error: FormError | null
  form: ServerForm
  onChange: (form: ServerForm) => void
  readOnly: boolean
}

/** UniWork 同款表单：类型、名称，HTTP 填地址和请求头，Stdio 填命令、参数和环境变量。 */
export function ServerFormFields({ autoFocusName = false, error, form, onChange, readOnly }: ServerFormFieldsProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal
  const id = useId()

  /** 改一个字段并通知上层。 */
  const set = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => onChange({ ...form, [key]: value })

  return (
    <div className="grid gap-3">
      <Field label={copy.type}>
        <SegmentedControl
          disabled={readOnly}
          onChange={transport => set('transport', transport)}
          options={TRANSPORTS}
          value={form.transport}
        />
      </Field>
      <Field htmlFor={`${id}-name`} label={copy.name}>
        <Input
          autoFocus={autoFocusName}
          id={`${id}-name`}
          onChange={event => set('name', event.target.value)}
          placeholder={copy.namePlaceholder}
          readOnly={readOnly}
          value={form.name}
        />
      </Field>
      {form.transport === 'http' ? (
        <>
          <Field htmlFor={`${id}-url`} label={copy.url}>
            <Input
              id={`${id}-url`}
              onChange={event => set('url', event.target.value)}
              placeholder="https://example.com/mcp"
              readOnly={readOnly}
              value={form.url}
            />
          </Field>
          <KeyValueEditor
            keyPlaceholder="Header-Name"
            label={copy.headers}
            onChange={rows => set('headers', rows)}
            readOnly={readOnly}
            rows={form.headers}
          />
        </>
      ) : (
        <>
          <div className="grid items-start gap-3 sm:grid-cols-[1fr_2fr]">
            <Field htmlFor={`${id}-command`} label={copy.command}>
              <Input
                id={`${id}-command`}
                onChange={event => set('command', event.target.value)}
                placeholder="uvx"
                readOnly={readOnly}
                value={form.command}
              />
            </Field>
            <Field htmlFor={`${id}-args`} label={copy.args}>
              <Input
                id={`${id}-args`}
                onChange={event => set('args', event.target.value)}
                placeholder="minimax-mcp --flag"
                readOnly={readOnly}
                value={form.args}
              />
            </Field>
          </div>
          <KeyValueEditor
            keyPlaceholder="VARIABLE_NAME"
            label={copy.env}
            onChange={rows => set('env', rows)}
            readOnly={readOnly}
            rows={form.env}
            secretValues
          />
        </>
      )}
      {error && !readOnly && <FieldHint error>{copy.formErrors[error]}</FieldHint>}
    </div>
  )
}

interface KeyValueEditorProps {
  keyPlaceholder: string
  label: string
  onChange: (rows: KeyValueRow[]) => void
  readOnly: boolean
  rows: readonly KeyValueRow[]
  secretValues?: boolean
}

/** 键值对编辑：逐行增删；环境变量的值默认遮住，可单独显示。 */
function KeyValueEditor({
  keyPlaceholder,
  label,
  onChange,
  readOnly,
  rows,
  secretValues = false
}: KeyValueEditorProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set())

  /** 改某一行的键或值。 */
  const update = (index: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  /** 删除一行，并让后面行的“显示”状态跟着前移。 */
  const remove = (index: number) => {
    onChange(rows.filter((_, i) => i !== index))
    setShown(current => new Set([...current].filter(i => i !== index).map(i => (i > index ? i - 1 : i))))
  }

  /** 切换某一行值的显示与遮挡。 */
  const flip = (index: number) =>
    setShown(current => {
      const next = new Set(current)

      if (!next.delete(index)) {
        next.add(index)
      }

      return next
    })

  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {rows.map((row, index) => (
        <div className="flex items-center gap-2" key={index}>
          <Input
            aria-label={`${label} ${index + 1}`}
            className="min-w-0 flex-2"
            onChange={event => update(index, { key: event.target.value })}
            placeholder={keyPlaceholder}
            readOnly={readOnly}
            value={row.key}
          />
          <Input
            aria-label={`${label} ${index + 1} value`}
            className={cn(secretValues ? !shown.has(index) && '[-webkit-text-security:disc]' : 'min-w-0 flex-3')}
            containerClassName="min-w-0 flex-3"
            onChange={event => update(index, { value: event.target.value })}
            placeholder="value"
            readOnly={readOnly}
            suffix={
              secretValues ? (
                <button
                  aria-label={shown.has(index) ? copy.hideValue : copy.showValue}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => flip(index)}
                  type="button"
                >
                  <Codicon name={shown.has(index) ? 'eye' : 'eye-closed'} />
                </button>
              ) : undefined
            }
            value={row.value}
          />
          {!readOnly && (
            <Button aria-label={copy.removeRow} onClick={() => remove(index)} size="icon-xs" variant="ghost">
              <Codicon name="trash" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          className="justify-self-start"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
          size="xs"
          variant="text"
        >
          <Codicon name="add" />
          {copy.addRow}
        </Button>
      )}
    </div>
  )
}
