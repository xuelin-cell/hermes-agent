import { useEffect, useState } from 'react'
import { hermesApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { ErrorBanner } from '@/components/ui/error-state'

interface GroupSettings {
  enabled: boolean
  group_ids: string[]
}

interface WeixinGroupSettingsProps {
  busy?: boolean
}

export function WeixinGroupSettings({ busy = false }: WeixinGroupSettingsProps) {
  const [enabled, setEnabled] = useState(false)
  const [ids, setIds] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let live = true
    void hermesApi<GroupSettings>({ path: '/api/messaging/weixin/groups' }).then(value => {
      if (live) {
        setEnabled(value.enabled)
        setIds(value.group_ids.join('\n'))
        setLoaded(true)
      }
    }).catch(() => { if (live) { setError('群聊设置加载失败，请刷新页面重试。') } })
    return () => { live = false }
  }, [])

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await hermesApi<GroupSettings>({ path: '/api/messaging/weixin/groups', method: 'PUT', body: {
        enabled, group_ids: ids.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean)
      } })
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试。')
    } finally { setSaving(false) }
  }

  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer">群聊设置</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-xs text-(--ui-text-secondary)">仅处理微信平台实际投递的群消息。扫码机器人通常无法加入普通微信群。</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} disabled={!loaded || saving || busy} onChange={event => { setEnabled(event.target.checked); setSaved(false) }} />
          接收指定群的消息
        </label>
        <label className="flex flex-col gap-1">
          允许接收的群 ID（每行一个）
          <textarea className="rounded border p-2" rows={3} value={ids} disabled={!loaded || saving || busy} onChange={event => { setIds(event.target.value); setSaved(false) }} />
        </label>
        <Button size="sm" variant="outline" disabled={!loaded || saving || busy} onClick={() => void save()}>{saving ? '保存中…' : '保存群聊设置'}</Button>
        {saved && <p role="status">已保存</p>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>
    </details>
  )
}
