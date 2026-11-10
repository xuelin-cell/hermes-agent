import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { confirm } from '@/store/confirm'
import { notifyError } from '@/store/notifications'
import type { HermesConfigRecord } from '@/types/hermes'

import { $messagingOperation } from '../messaging/operation-store'

import { ConfigField } from './config-field'
import { getNested, setNested } from './helpers'
import { ListRow, SettingsContent, ToggleRow } from './primitives'
import { useSettingsRedesignCopy } from './redesign-copy'

// Phone adapters are bound to the primary profile, matching MessagingView.
const PROFILE = 'default'

const fields = [
  { key: 'compression.enabled', type: 'boolean' as const, fallback: true },
  { key: 'compression.threshold', type: 'number' as const, fallback: 0.85 },
  { key: 'compression.target_ratio', type: 'number' as const, fallback: 0.2 },
  { key: 'compression.protect_last_n', type: 'number' as const, fallback: 4 }
]

export function ContextSettings() {
  const copy = useSettingsRedesignCopy()
  const { locale } = useI18n()
  const zh = locale !== 'en'
  const operation = useStore($messagingOperation)

  const resetting =
    operation.operation === 'reset-history' && !['idle', 'completed', 'failed'].includes(operation.phase)

  async function reset() {
    const accepted = await confirm({
      title: zh ? '重置所有已连接平台的历史？' : 'Reset history for all connected platforms?',
      description: zh
        ? '将永久删除微信、钉钉等已连接平台的全部会话记录，包括归档记录。连接会短暂重启；桌面对话、文件和工具不会删除。'
        : 'Permanently remove all conversations, including archived ones, for connected messaging platforms. Connections restart briefly. Desktop chats, files and tools are preserved.',
      confirmLabel: zh ? '清空历史' : 'Clear history',
      destructive: true
    })

    if (!accepted) {return}

    try {
      await window.hermesDesktop.messagingSetup({ operation: 'reset-history', profile: 'default', confirmed: true })
    } catch (error) {
      notifyError(error, zh ? '无法重置历史' : 'Could not reset history')
    }
  }

  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    void getHermesConfigRecord(PROFILE)
      .then(value => {
        if (current) {setConfig(value)}
      })
      .catch(error => notifyError(error, copy('context')))

    return () => {
      current = false
    }
  }, [copy])

  async function changeIdle(enabled: boolean) {
    setBusy(true)

    try {
      const fresh = await getHermesConfigRecord(PROFILE)
      const next = setNested(fresh, 'desktop.messaging_auto_new_session', enabled)
      const plugins = next.plugins && typeof next.plugins === 'object' ? (next.plugins as Record<string, unknown>) : {}
      const entries = Array.isArray(plugins.enabled) ? plugins.enabled : []
      next.plugins = {
        ...plugins,
        enabled: [...new Set([...entries, 'desktop-messaging'])],
        ...(enabled && Array.isArray(plugins.disabled)
          ? { disabled: plugins.disabled.filter(name => name !== 'desktop-messaging') }
          : {})
      }
      await saveHermesConfig(next, PROFILE)
      setConfig(next)
      await window.hermesDesktop.messagingSetup({ operation: 'retry', profile: 'default' })
    } catch (error) {
      notifyError(error, copy('context'))
    } finally {
      setBusy(false)
    }
  }

  async function change(key: string, value: unknown) {
    if (
      typeof value === 'number' &&
      (key.endsWith('protect_last_n') ? !Number.isInteger(value) || value < 0 : value <= 0 || value >= 1)
    )
      {return}

    setBusy(true)

    try {
      const fresh = await getHermesConfigRecord(PROFILE)
      const next = setNested(fresh, key, value)
      await saveHermesConfig(next, PROFILE)
      setConfig(next)
    } catch (error) {
      notifyError(error, copy('context'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsContent>
      <p className="mb-4 text-xs text-muted-foreground">{copy('contextDesc')}</p>
      <fieldset className="settings-card" disabled={!config || busy}>
        {fields.map(field => (
          <ConfigField
            key={field.key}
            onChange={value => void change(field.key, value)}
            schema={{ type: field.type }}
            schemaKey={field.key}
            value={config ? (getNested(config, field.key) ?? field.fallback) : field.fallback}
          />
        ))}
      </fieldset>
      <div className="settings-card mt-4">
        <ToggleRow
          checked={Boolean(config && getNested(config, 'desktop.messaging_auto_new_session'))}
          description={
            zh
              ? '聊天应用闲置 6 小时后，下次收到消息时开启新会话。旧记录保留，不打断正在执行的任务。更改会重连消息网关。'
              : 'After 6 idle hours, the next incoming message starts a new conversation. Old records are retained and running tasks are preserved. Changing this reconnects the messaging gateway.'
          }
          disabled={!config || busy || resetting}
          label={zh ? '自动新起会话' : 'Start a new conversation after inactivity'}
          onChange={value => void changeIdle(value)}
        />
      </div>
      <div className="settings-card mt-4">
        <ListRow
          action={
            <Button
              disabled={resetting || !window.hermesDesktop?.messagingSetup}
              onClick={() => void reset()}
              size="sm"
            >
              {zh ? (resetting ? '正在重置…' : '清空所有消息') : resetting ? 'Resetting…' : 'Clear all messages'}
            </Button>
          }
          description={
            zh
              ? '清空所有已连接平台的会话，保留电脑环境。'
              : 'Clear conversations for all connected platforms, preserving your computer environment.'
          }
          title={zh ? '重置历史' : 'Reset history'}
        />
        {operation.operation === 'reset-history' && ['completed', 'failed'].includes(operation.phase) && (
          <p className="pb-3 text-xs text-muted-foreground" role="status">
            {operation.phase === 'completed'
              ? zh
                ? '历史重置已完成'
                : 'History reset completed'
              : zh
                ? '重置或重连未完成，请检查连接状态后重试。'
                : 'Reset or reconnection did not finish. Check connection status before retrying.'}
          </p>
        )}
      </div>
    </SettingsContent>
  )
}
