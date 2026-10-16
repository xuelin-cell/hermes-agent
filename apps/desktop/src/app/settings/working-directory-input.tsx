import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Input } from '@/components/ui/input'
import { $activeConnectionId } from '@/store/connections'
import { requestGatewayForAgent } from '@/store/gateway'
import { $settingsScopeProfile } from '@/store/settings-scope'

import { CONTROL_TEXT } from './constants'

interface WorkingDirectoryInputProps {
  label: string
  value: string
  onChange: (value: string) => void
}

/** 默认值只展示后端解析后的目录；只有用户编辑才回写配置，查询随连接和 Profile 隔离。 */
export function WorkingDirectoryInput({ label, value, onChange }: WorkingDirectoryInputProps) {
  const connectionId = useStore($activeConnectionId)
  const profile = useStore($settingsScopeProfile)
  const [editing, setEditing] = useState(false)
  const isDefault = value.trim() === '' || value.trim() === '.'

  const { data } = useQuery({
    queryKey: ['settings-working-directory', connectionId, profile],
    // 明确解析相对启动目录，避免用户清空输入后读到尚未保存的旧自定义配置。
    queryFn: () =>
      requestGatewayForAgent<{ cwd?: string }>(connectionId, profile, 'config.get', { key: 'project', cwd: '.' }),
    enabled: isDefault,
    retry: false
  })

  return (
    <Input
      aria-label={label}
      className={CONTROL_TEXT}
      onBlur={() => setEditing(false)}
      onChange={event => {
        setEditing(true)
        onChange(event.target.value)
      }}
      value={!editing && isDefault ? data?.cwd?.trim() || value : value}
    />
  )
}
