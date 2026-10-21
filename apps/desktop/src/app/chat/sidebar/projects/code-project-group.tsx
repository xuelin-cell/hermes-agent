import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { fetchProjectSessions, projectProfile } from '@/store/projects'

import { SidebarRowNest } from '../chrome'

import {
  expandedProjectSessions,
  latestProjectSessions,
  PROJECT_SESSION_PAGE,
  projectTreeCwd,
  useRevealedRows,
  useWorkspaceNodeOpen
} from './model'
import type { ProjectOverviewRowProps } from './overview-row'
import { ProjectContextMenu } from './project-menu'
import { excludeProjectSessions, type SidebarProjectTree } from './workspace-groups'
import { WorkspaceAddButton, WorkspaceShowMoreRow } from './workspace-header'

/** A project is an inline disclosure, never a route into another sidebar. */
export function CodeProjectGroup({
  project,
  previewSessions,
  renderRows,
  onNewSession,
  isSessionHidden,
  hiddenSessionCount = 0,
  activeProjectId
}: ProjectOverviewRowProps) {
  const { t } = useI18n()
  const [open, toggleOpen] = useWorkspaceNodeOpen(project.id)
  const [hydrated, setHydrated] = useState<SidebarProjectTree | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const recent = previewSessions?.length ? previewSessions : latestProjectSessions(project, Infinity)
  const total = Math.max(0, project.sessionCount - hiddenSessionCount)

  useEffect(() => {
    if (!open || hydrated || failed || total <= recent.length || !projectProfile()) {
      return
    }

    let active = true
    setLoading(true)
    fetchProjectSessions(project.id, { supersedable: false })
      .then(tree => {
        if (active) {
          setHydrated(tree)
          setFailed(!tree)
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [project.id, open, hydrated, failed, total, recent.length])

  const visible = hydrated && isSessionHidden ? excludeProjectSessions(hydrated, isSessionHidden) : hydrated
  const sessions = visible ? expandedProjectSessions(recent, visible) : recent
  const page = useRevealedRows(sessions, PROJECT_SESSION_PAGE)

  const header = (
    <div className="group/workspace flex min-w-0 items-center rounded-lg px-1 py-1 text-(--ui-text-tertiary) hover:bg-(--ui-row-hover-background)">
      <button
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm"
        onClick={toggleOpen}
        title={project.path ?? project.label}
        type="button"
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} size="0.75rem" />
        <Codicon name="folder" size="1rem" />
        <span className="min-w-0 flex-1 truncate">{project.label}</span>
        <span className="px-1 text-xs">{total}</span>
      </button>
      {onNewSession && (
        <WorkspaceAddButton
          label={t.sidebar.newSessionIn(project.label)}
          onClick={() => onNewSession(project.isNoProject ? null : projectTreeCwd(project))}
        />
      )}
    </div>
  )

  return (
    <div data-code-project={project.id}>
      {project.isNoProject ? (
        header
      ) : (
        <ProjectContextMenu isActive={project.id === activeProjectId} project={project}>
          {header}
        </ProjectContextMenu>
      )}
      {open && (
        <SidebarRowNest>
          {renderRows?.(page.shown)}
          {loading && !hydrated && total > recent.length && (
            <Codicon className="my-2 ml-3 animate-spin text-(--ui-text-tertiary)" name="loading" />
          )}
          {failed && (
            <WorkspaceShowMoreRow label={t.sidebar.projects.showAllCount(total)} onClick={() => setFailed(false)} />
          )}
          {page.more > 0 && (
            <WorkspaceShowMoreRow label={t.sidebar.showMoreIn(page.more, project.label)} onClick={page.showMore} />
          )}
        </SidebarRowNest>
      )}
    </div>
  )
}
