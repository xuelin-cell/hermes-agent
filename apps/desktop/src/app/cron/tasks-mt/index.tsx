import { useStore } from '@nanostores/react'
import type { ComponentProps } from 'react'

import { $developerMode } from '@/store/developer-mode'

import { CronView } from '../index'

import { ScheduledTasksView } from './scheduled-tasks-view'

/** 普通模式用 UniWork 样式的定时任务页；开发者模式保留原版完整页面（投递目标、指定模型、脚本等）。 */
export function CronEntry(props: ComponentProps<typeof CronView>) {
  const developerMode = useStore($developerMode)

  return developerMode ? (
    <CronView {...props} />
  ) : (
    <ScheduledTasksView onClose={props.onClose} onOpenSession={props.onOpenSession} />
  )
}
