import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { CheckCircle2, ChevronDown, ExternalLink, Lightbulb, Link2, MessageCircle, Plus, Unlink } from '@/lib/icons'

import {
  CONNECTOR_SPECS,
  type ConnectorId,
  type LocalConnectorResult
} from '../../../../electron/open-connector/contract'

import examples from './connector-examples.json'
import type { RECOMMENDED_CONNECTORS } from './recommended-catalog'
import { WecomQrForm } from './wecom-qr-form'

type ConnectorEntry = (typeof RECOMMENDED_CONNECTORS)[number]

interface RecommendedConnectorCardProps {
  connected: boolean
  disabled: boolean
  entry: ConnectorEntry
  onConnect: () => void
  onSelect: () => void
}

/** HexAgent's card interaction: the card opens details and the plus starts authorization directly. */
export function RecommendedConnectorCard({
  connected,
  disabled,
  entry,
  onConnect,
  onSelect
}: RecommendedConnectorCardProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  const item = copy.catalog[entry.id]

  function openFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onSelect()
  }

  return (
    <article
      aria-label={connected ? `${item.name} · ${copy.connected}` : copy.details(item.name)}
      className="mt-connector-card"
      onClick={onSelect}
      onKeyDown={openFromKeyboard}
      role="button"
      tabIndex={0}
    >
      <div className="mt-connector-card-top">
        <img alt="" className="mt-connector-icon" draggable={false} src={entry.icon} />
        <h3 className="mt-connector-name">{item.name}</h3>
        <div className="mt-connector-card-actions">
          {connected ? (
            <>
              <span aria-hidden="true" className="mt-connector-status mt-connector-status-connected" />
              <span className="sr-only">{copy.connected}</span>
            </>
          ) : (
            <button
              aria-label={copy.connect(item.name)}
              className="mt-connector-add"
              disabled={disabled}
              onClick={event => {
                event.stopPropagation()
                onConnect()
              }}
              type="button"
            >
              <Plus />
            </button>
          )}
        </div>
      </div>
      <p className="mt-connector-description">{item.description}</p>
      <p className="mt-connector-provider">{item.provider}</p>
    </article>
  )
}

interface RecommendedConnectorDetailProps {
  available: boolean
  busy: boolean
  connected: boolean
  entry: ConnectorEntry | null
  error: string
  mode: 'overview' | 'credentials'
  onCancel: () => void
  onClose: () => void
  onConnect: () => void
  onConnected: () => void
  onDisconnect: () => void
  onExample: (text: string) => void
  onQr: (operation: 'qr.start' | 'qr.poll' | 'qr.cancel', sessionId?: string) => Promise<LocalConnectorResult | null>
  onSubmit: (values: Record<string, string>) => Promise<void>
  waiting: boolean
}

const GUIDE_URLS: Partial<Record<ConnectorId, string>> = {
  qq_mail: 'https://help.mail.qq.com/detail/0/1087',
  netease_mail:
    'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b',
  amap: 'https://console.amap.com/',
  wps_mcp: 'https://account.wps.cn/usercenter/agent-identity?isclient=false',
  youdao_note: 'https://mopen.163.com/',
  ima: 'https://ima.qq.com/agent-interface',
  aminer: 'https://www.aminer.cn/open/board?tab=control'
}

const EXAMPLE_GROUP: Record<ConnectorId, keyof (typeof examples)['en']> = {
  qq_mail: 'mail',
  netease_mail: 'mail',
  amap: 'amap',
  wps_mcp: 'wps',
  youdao_note: 'youdao',
  ima: 'ima',
  qcc_mcp: 'qcc',
  eastmoney_mcp: 'eastmoney',
  ifind_mcp: 'ifind',
  aminer: 'aminer',
  wecom_bot: 'wecom'
}

function connectorExamples(id: ConnectorId, name: string, chinese: boolean): string[] {
  const catalog = chinese ? examples['zh-CN'] : examples.en
  const group = catalog[EXAMPLE_GROUP[id]]
  const rows = typeof group === 'string' ? [group] : Object.values(group)
  return rows.map(text => text.replaceAll('{{name}}', name))
}

/** HexAgent's overview and credential flows, adapted to Hermes' profile-scoped Electron capability. */
export function RecommendedConnectorDetail(props: RecommendedConnectorDetailProps) {
  const { locale, t } = useI18n()
  const copy = t.connectorsPage.recommended
  const item = props.entry ? copy.catalog[props.entry.id] : null

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          props.onCancel()
          props.onClose()
        }
      }}
      open={props.entry !== null}
    >
      {props.entry && item && (
        <DialogContent
          bodyClassName="mt-connector-dialog-body"
          className="mt-connector-dialog"
          overlayClassName="mt-connector-dialog-overlay"
        >
          {props.mode === 'credentials' ? (
            <CredentialView
              available={props.available}
              busy={props.busy}
              entry={props.entry}
              error={props.error}
              item={item}
              onConnected={props.onConnected}
              onQr={props.onQr}
              onSubmit={props.onSubmit}
            />
          ) : (
            <OverviewView
              available={props.available}
              busy={props.busy}
              connected={props.connected}
              entry={props.entry}
              error={props.error}
              examples={connectorExamples(props.entry.id, item.name, locale === 'zh' || locale === 'zh-hant')}
              item={item}
              onConnect={props.onConnect}
              onDisconnect={props.onDisconnect}
              onExample={props.onExample}
              waiting={props.waiting}
            />
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}

interface ConnectorCopy {
  name: string
  description: string
  provider: string
}
interface OverviewViewProps {
  available: boolean
  busy: boolean
  connected: boolean
  entry: ConnectorEntry
  error: string
  examples: string[]
  item: ConnectorCopy
  onConnect: () => void
  onDisconnect: () => void
  onExample: (text: string) => void
  waiting: boolean
}

function OverviewView({
  available,
  busy,
  connected,
  entry,
  error,
  examples: prompts,
  item,
  onConnect,
  onDisconnect,
  onExample,
  waiting
}: OverviewViewProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  return (
    <>
      <div className="mt-connector-hero-icon">
        <img alt="" src={entry.icon} />
      </div>
      {(connected || waiting) && (
        <div className="mt-connector-dialog-status" role="status">
          <span className={`mt-connector-status ${connected ? 'mt-connector-status-connected' : ''}`} />
          <span>{connected ? copy.connected : copy.waiting}</span>
        </div>
      )}
      <DialogTitle className="mt-connector-dialog-title">{copy.connect(item.name)}</DialogTitle>
      <p className="mt-connector-dialog-provider">{item.provider}</p>
      <DialogDescription className="mt-connector-dialog-description">{item.description}</DialogDescription>
      {!available && <p className="mt-connector-inline-notice">{copy.localOnly}</p>}
      {connected && <p className="mt-connector-inline-notice">{copy.nextSession}</p>}
      {error && (
        <p className="mt-connector-error" role="alert">
          {error}
        </p>
      )}
      <div className="mt-connector-dialog-actions">
        {connected ? (
          <>
            <Button onClick={() => onExample(prompts[0] || item.name)} size="lg">
              <MessageCircle />
              {copy.tryIt}
            </Button>
            <Button disabled={busy} onClick={onDisconnect} size="lg" variant="outline">
              <Unlink />
              {copy.disconnect}
            </Button>
          </>
        ) : waiting ? (
          <Button onClick={onDisconnect} size="lg" variant="outline">
            {copy.cancel}
          </Button>
        ) : (
          <Button disabled={busy || !available} loading={busy} onClick={onConnect} size="lg">
            <Link2 />
            {copy.connectAction}
          </Button>
        )}
      </div>
      <section className="mt-connector-examples" aria-labelledby="mt-connector-examples-title">
        <h3 id="mt-connector-examples-title">
          <Lightbulb />
          {copy.tryIt}
        </h3>
        <ul>
          {prompts.map(prompt => (
            <li key={prompt}>
              <button onClick={() => (connected ? onExample(prompt) : onConnect())} type="button">
                <span>{prompt}</span>
                <MessageCircle />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

interface CredentialViewProps {
  available: boolean
  busy: boolean
  entry: ConnectorEntry
  error: string
  item: ConnectorCopy
  onConnected: () => void
  onQr: RecommendedConnectorDetailProps['onQr']
  onSubmit: (values: Record<string, string>) => Promise<void>
}

function CredentialView({ available, busy, entry, error, item, onConnected, onQr, onSubmit }: CredentialViewProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  const guideId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const fields = useMemo(() => [...CONNECTOR_SPECS[entry.id].fields], [entry.id])
  const guide = copy.guides[entry.id]
  const guideUrl = GUIDE_URLS[entry.id]
  const canSubmit = available && !busy && fields.every(field => values[field]?.trim())

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (canSubmit) await onSubmit(Object.fromEntries(fields.map(field => [field, values[field].trim()])))
  }

  return (
    <>
      <div className="mt-connector-auth-heading">
        <div className="mt-connector-dialog-status">
          <span className="mt-connector-status" />
          <span>{copy.needAuth}</span>
        </div>
        <div className="mt-connector-hero-icon">
          <img alt="" src={entry.icon} />
        </div>
      </div>
      <DialogTitle className="mt-connector-dialog-title">{copy.connect(item.name)}</DialogTitle>
      <p className="mt-connector-dialog-provider">{item.provider}</p>
      <DialogDescription className="mt-connector-dialog-description">{item.description}</DialogDescription>
      {entry.id === 'wecom_bot' ? (
        <WecomQrForm onConnected={onConnected} request={onQr} />
      ) : (
        <>
          {guide && (
            <div className="mt-connector-guide">
              <button
                aria-controls={guideId}
                aria-expanded={guideOpen}
                onClick={() => setGuideOpen(open => !open)}
                type="button"
              >
                <span>{guide.title}</span>
                <ChevronDown />
              </button>
              {guideOpen && (
                <div className="mt-connector-guide-panel" id={guideId}>
                  <ol>
                    {guide.steps.map(step => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  {guideUrl && (
                    <Button
                      onClick={() => void window.hermesDesktop.openExternal(guideUrl)}
                      size="inline"
                      type="button"
                      variant="link"
                    >
                      {guide.link}
                      <ExternalLink />
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          <form aria-label={copy.credentials} className="mt-connector-form" onSubmit={event => void submit(event)}>
            <h3 className="sr-only">{copy.credentials}</h3>
            {fields.map((field, index) => (
              <label key={field}>
                <span>{copy.fields[field] ?? field}</span>
                <Input
                  autoComplete={field === 'email' ? 'email' : 'off'}
                  autoFocus={index === 0}
                  disabled={busy}
                  onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))}
                  placeholder={copy.placeholders[field] ?? field}
                  type={field === 'email' || field === 'clientId' || field === 'botId' ? 'text' : 'password'}
                  value={values[field] ?? ''}
                />
              </label>
            ))}
            <p className="mt-connector-form-hint">{copy.hints[entry.id] ?? copy.credentialsHint}</p>
            {!available && <p className="mt-connector-inline-notice">{copy.localOnly}</p>}
            {error && (
              <p className="mt-connector-error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={!canSubmit} loading={busy} size="lg" type="submit">
              <CheckCircle2 />
              {busy ? copy.saving : copy.saveAndConnect}
            </Button>
          </form>
        </>
      )}
    </>
  )
}
