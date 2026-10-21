import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { NO_PROJECT_ID } from '@/app/chat/sidebar/projects/workspace-groups'
import { useCwdActions } from '@/app/session/hooks/use-cwd-actions'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { HermesGateway } from '@/hermes'
import { selectDesktopPaths } from '@/lib/desktop-fs'
import { Check, ChevronDown, FolderOpen } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { $projectScope } from '@/store/project-scope'
import { resolveNewSessionCwd } from '@/store/projects'
import {
  $newChatWorkspaceTarget,
  $sessions,
  type NewChatWorkspaceTarget,
  setCurrentBranch,
  setCurrentCwdExplicit,
  setCurrentCwdTransient,
  setNewChatWorkspaceTarget
} from '@/store/session'
import { $codeWorkspace } from '@/store/workspace-category'

import { isConversationFolder } from './conversation-folder'
import { useWorkdirCopy } from './copy'
import { isBlockedWorkdir, recentWorkdirs, sameWorkdir, workdirName } from './folders'

const PILL = cn(
  'h-(--composer-control-size) min-w-0 max-w-36 shrink gap-1 rounded-md px-1.5 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
  'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
)

const MENU_LABEL = 'px-2 pb-0.5 pt-1 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)'

const HINT = 'px-2 py-1.5 text-[0.6875rem] leading-snug text-(--ui-text-tertiary)'

export interface WorkdirPickerProps {
  /** 当前对话展示的目录（新对话时是输入框的工作目录）。 */
  cwd?: null | string
  gateway?: HermesGateway | null
  /** 运行中会话的 ID；为空表示尚未发送的新对话。 */
  sessionId?: null | string
}

/**
 * 新对话发送时实际使用的目录，规则与 use-session-actions 创建会话及 applyConversationFolder 一致；
 * 空字符串表示默认工作区。inherit 为 false 时（日常办公和学习会自动建文件夹）带过来的目录不算。
 */
export function draftWorkdir(
  target: NewChatWorkspaceTarget,
  projectScope: string,
  liveCwd: string,
  inherit = true
): string {
  if (target === null || (target === undefined && (projectScope === NO_PROJECT_ID || !inherit))) {
    return ''
  }

  return typeof target === 'string' ? target.trim() : liveCwd.trim() || resolveNewSessionCwd()
}

/** 读取后端的默认工作目录，用于识别并显示为“默认工作区”。 */
function useDefaultWorkdir(gateway: HermesGateway | null | undefined): [string, () => void] {
  const [value, setValue] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!gateway) {
      return
    }

    let live = true

    gateway
      .request<{ cwd?: string }>('config.get', { key: 'project' })
      .then(info => live && setValue(info.cwd?.trim() || ''))
      .catch(() => undefined)

    return () => {
      live = false
    }
  }, [attempt, gateway])

  return [value, () => setAttempt(n => n + 1)]
}

/** 聊天输入框的工作目录：新对话可选择，对话开始后只读显示。 */
export function WorkdirPicker({ cwd, gateway, sessionId }: WorkdirPickerProps) {
  const t = useWorkdirCopy()
  const target = useStore($newChatWorkspaceTarget)
  const projectScope = useStore($projectScope)
  const sessions = useStore($sessions)
  const codeWorkspace = useStore($codeWorkspace)
  const [defaultCwd, refreshDefault] = useDefaultWorkdir(gateway)
  const [open, setOpen] = useState(false)
  // 本机账号环境才会给未选目录的新对话自动建文件夹。
  const autoFolders = typeof window.hermesDesktop?.createConversationFolder === 'function'
  const sessionIdRef = useRef<null | string>(sessionId ?? null)

  sessionIdRef.current = sessionId ?? null

  const { changeSessionCwd } = useCwdActions({
    activeSessionIdRef: sessionIdRef,
    requestGateway: <T,>(method: string, params?: Record<string, unknown>) =>
      gateway ? gateway.request<T>(method, params) : Promise.reject<T>(new Error('gateway unavailable'))
  })

  const locked = Boolean(sessionId)
  // 日常办公和学习会自动建文件夹，带过来的目录不显示，与发送时一致。
  const inherit = !autoFolders || codeWorkspace
  const shown = locked ? (cwd ?? '').trim() : draftWorkdir(target, projectScope, cwd ?? '', inherit)
  const isDefault = !shown || (defaultCwd !== '' && sameWorkdir(shown, defaultCwd))
  const label = isDefault ? t('defaultName') : workdirName(shown)
  const fullPath = shown || defaultCwd

  const recent = useMemo(
    () =>
      locked
        ? []
        : recentWorkdirs(sessions, defaultCwd ? [defaultCwd] : [], dir => isConversationFolder(dir, defaultCwd)),
    [defaultCwd, locked, sessions]
  )

  /** 新对话改用指定目录；对话已开始（例如选择窗口打开期间已发送）时不改，保持锁定。 */
  function choose(dir: string) {
    if (sessionIdRef.current) {
      return
    }

    if (isBlockedWorkdir(dir)) {
      notify({ kind: 'warning', title: t('title'), message: t('blocked', dir) })

      return
    }

    void changeSessionCwd(dir)
  }

  /** 回到账号默认工作区，与新建对话时的“未选择目录”状态相同。 */
  function chooseDefault() {
    if (sessionIdRef.current) {
      return
    }

    setNewChatWorkspaceTarget(null)
    setCurrentCwdTransient('')
    setCurrentCwdExplicit(false)
    setCurrentBranch('')
  }

  /** 打开系统文件夹选择窗口。 */
  async function browse() {
    try {
      const [dir] = await selectDesktopPaths({
        defaultPath: shown || defaultCwd || undefined,
        directories: true,
        multiple: false,
        title: t('title')
      })

      if (dir) {
        choose(dir)
      }
    } catch (error) {
      notifyError(error, t('pickFailed'))
    }
  }

  /** 菜单关闭后把键盘交还输入框；打开时补取一次默认目录。 */
  function setMenuOpen(next: boolean) {
    setOpen(next)

    if (next && !defaultCwd) {
      refreshDefault()
    }

    if (!next) {
      releaseTypingFocus()
    }
  }

  const trigger = (
    <Button
      aria-label={`${t('title')}: ${label}`}
      className={PILL}
      data-testid="workdir-picker"
      type="button"
      variant="ghost"
    >
      <FolderOpen className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {!locked && <ChevronDown className="size-2.5 shrink-0 opacity-50" />}
    </Button>
  )

  if (locked) {
    return (
      <Popover onOpenChange={setMenuOpen} open={open}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1" side="top" sideOffset={6}>
          <div className={MENU_LABEL}>{t('title')}</div>
          <div className="break-all px-2 py-1 font-mono text-[0.6875rem] text-foreground">{fullPath || label}</div>
          <div className={HINT}>{t('lockedHint')}</div>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={open}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" side="top" sideOffset={6}>
        <DropdownMenuLabel className={MENU_LABEL}>{t('title')}</DropdownMenuLabel>
        <WorkdirItem checked={isDefault} hint={defaultCwd || t('defaultHint')} onSelect={chooseDefault}>
          {t('defaultName')}
        </WorkdirItem>
        {!isDefault && !recent.some(dir => sameWorkdir(dir, shown)) && (
          <WorkdirItem checked hint={shown} onSelect={() => undefined}>
            {workdirName(shown)}
          </WorkdirItem>
        )}
        {recent.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className={MENU_LABEL}>{t('recent')}</DropdownMenuLabel>
            {recent.map(dir => (
              <WorkdirItem
                checked={!isDefault && sameWorkdir(dir, shown)}
                hint={dir}
                key={dir}
                onSelect={() => choose(dir)}
              >
                {workdirName(dir)}
              </WorkdirItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void browse()}>
          <FolderOpen className="size-3.5 shrink-0" />
          <span>{t('choose')}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className={HINT}>{t(isDefault && autoFolders ? 'folderHint' : 'draftHint')}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 菜单中的一个目录：名称一行、完整路径一行，当前目录带勾。 */
function WorkdirItem({
  checked,
  children,
  hint,
  onSelect
}: {
  checked: boolean
  children: string
  hint: string
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem className="items-start" onSelect={onSelect} title={hint}>
      <Check className={cn('mt-0.5 size-3.5 shrink-0', !checked && 'invisible')} />
      <span className="grid min-w-0">
        <span className="truncate">{children}</span>
        <span className="truncate text-[0.625rem] text-(--ui-text-tertiary)">{hint}</span>
      </span>
    </DropdownMenuItem>
  )
}
