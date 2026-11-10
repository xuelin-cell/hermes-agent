import { computed } from 'nanostores'

import { $sidebarGrouping } from '@/store/layout'
import { $selectedWorkspaceMode } from '@/store/workspace-category'

/** 三个业务模块共用会话分组；旧项目偏好仅在显示时映射，不改写已保存设置。 */
export const $workspaceSidebarGrouping = computed([$selectedWorkspaceMode, $sidebarGrouping], (workspace, grouping) =>
  workspace && grouping === 'project' ? 'date' : grouping
)
