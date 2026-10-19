import { useStore } from '@nanostores/react'
import {
  IconAlarm,
  IconBulb,
  IconClipboardList,
  IconDroplet,
  IconFilter,
  IconFolder,
  IconLanguage,
  IconMoon,
  IconMovie,
  IconPhone
} from '@tabler/icons-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  createCronJob,
  type CronJob,
  type CronJobCreatePayload,
  type CronJobUpdates,
  deleteCronJob,
  getCronJobRuns,
  pauseCronJob,
  resumeCronJob,
  type SessionInfo,
  updateCronJob
} from '@/hermes'
import { selectDesktopPaths } from '@/lib/desktop-fs'
import { ChevronDown, MoreVertical, Pause, Pencil, Play, Plus, Trash2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $cronJobs, invalidateCronJobsRequests } from '@/store/cron'
import { notify, notifyError } from '@/store/notifications'
import { $profileScope, ALL_PROFILES } from '@/store/profile'

import { Panel } from '../../overlays/panel'
import { mutateAndRefreshCronJobs, refreshCronJobs } from '../cron-actions'

import { useTasksCopy } from './copy'
import {
  defaultScheduleForm,
  describeForm,
  formFromJob,
  type FrequencyMode,
  type Period,
  type ScheduleForm,
  scheduleFromForm,
  type ScheduleWords,
  type Weekday,
  WEEKDAYS
} from './schedule'
import { TASK_TEMPLATES, type TaskTemplate, type TemplateIcon, templateSchedule } from './templates'

type Filter = 'active' | 'all' | 'completed' | 'paused'
type JobWithDir = CronJob & { workdir?: null | string }

interface ScheduledTasksViewProps {
  onClose: () => void
  onOpenSession?: (sessionId: string, session?: SessionInfo) => void
}

interface EditorState {
  job?: JobWithDir
  template?: TaskTemplate
}

const TEMPLATE_ICONS: Record<TemplateIcon, typeof IconAlarm> = {
  bulb: IconBulb,
  clipboard: IconClipboardList,
  language: IconLanguage,
  moon: IconMoon,
  movie: IconMovie,
  phone: IconPhone,
  water: IconDroplet
}

/** 侧栏的 Profile 范围对应的 cron 查询范围，与原版定时任务页一致。 */
function cronProfile(scope: string): string {
  return scope === ALL_PROFILES ? 'all' : scope
}

function jobBucket(job: CronJob): Exclude<Filter, 'all'> {
  if (job.state === 'completed') {
    return 'completed'
  }

  return job.state === 'paused' || !job.enabled ? 'paused' : 'active'
}

/** 定时任务页（UniWork 样式）：任务卡片、筛选、从模板入手、新建 / 编辑弹窗。 */
export function ScheduledTasksView({ onClose, onOpenSession }: ScheduledTasksViewProps) {
  const t = useTasksCopy()
  const jobs = useStore($cronJobs) as JobWithDir[]
  const profile = cronProfile(useStore($profileScope))
  const [loading, setLoading] = useState(jobs.length === 0)
  const [filter, setFilter] = useState<Filter>('all')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templatesDismissed, setTemplatesDismissed] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CronJob | null>(null)

  const words: ScheduleWords = useMemo(
    () => ({
      daily: t('sDaily'),
      everyHours: hours => t('sEveryHours', hours),
      from: time => t('sFrom', time),
      monthly: days => t('sMonthly', days),
      once: (date, time) => t('sOnce', date, time),
      weekday: Object.fromEntries(WEEKDAYS.map(day => [day, t(`weekday.${day}`)])) as Record<Weekday, string>,
      weekdaysSeparator: '、',
      weekly: days => t('sWeekly', days),
      workdays: t('workdays'),
      yearly: (month, day) => t('sYearly', month, day)
    }),
    [t]
  )

  const refresh = useCallback(async () => {
    const { refreshError, stale } = await refreshCronJobs(profile)

    if (stale) {
      return
    }

    if (refreshError) {
      notifyError(refreshError, t('loadFailed'))
    }

    setLoading(false)
  }, [profile, t])

  useEffect(() => {
    void refresh()

    return () => invalidateCronJobsRequests()
  }, [refresh])

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        const { refreshError } = await mutateAndRefreshCronJobs(profile, action)

        if (refreshError) {
          notifyError(refreshError, t('loadFailed'))
        }
      } catch (error) {
        notifyError(error, t('actionFailed'))
      }
    },
    [profile, t]
  )

  const visible = useMemo(() => jobs.filter(job => filter === 'all' || jobBucket(job) === filter), [filter, jobs])
  const showTemplates = templatesOpen || (!loading && jobs.length === 0 && !templatesDismissed)

  const footerText = (job: JobWithDir): string => {
    if (job.state === 'paused' || !job.enabled) {
      return t('paused')
    }

    if (job.state === 'completed') {
      return t('completed')
    }

    if (job.state === 'running') {
      return t('running')
    }

    const form = formFromJob(job)

    if (form) {
      return describeForm(form, words)
    }

    // 别处建的「every 120m」这类间隔任务，按分钟换成好读的说法。
    const minutes = (job.schedule as { minutes?: number } | undefined)?.minutes

    if (job.schedule?.kind === 'interval' && typeof minutes === 'number' && minutes > 0) {
      return minutes % 60 === 0 ? t('sEveryHours', String(minutes / 60)) : t('sEveryMinutes', String(minutes))
    }

    return t('customSchedule', job.schedule_display ?? job.schedule?.display ?? '')
  }

  const openLatestRun = async (job: CronJob) => {
    try {
      const [run] = await getCronJobRuns(job.id, 1)

      if (run && onOpenSession) {
        onOpenSession(run.id, run)
      } else {
        notify({ kind: 'info', message: t('noRuns') })
      }
    } catch (error) {
      notifyError(error, t('loadFailed'))
    }
  }

  const filterLabel: Record<Filter, string> = {
    active: t('filterActive'),
    all: t('filterAll'),
    completed: t('filterCompleted'),
    paused: t('filterPaused')
  }

  const canReveal = typeof window !== 'undefined' && typeof window.hermesDesktop?.revealPath === 'function'

  return (
    <Panel onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-8">
        <header className="mb-5">
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </header>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          {showTemplates ? (
            <>
              <Button
                onClick={() => {
                  setTemplatesOpen(false)
                  setTemplatesDismissed(true)
                }}
                size="sm"
                variant="outline"
              >
                {t('back')}
              </Button>
              <span className="text-sm text-muted-foreground">{t('templatesTitle')}</span>
            </>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="rounded-full" size="sm" variant="outline">
                  <IconFilter size={14} />
                  {filterLabel[filter]}
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup onValueChange={value => setFilter(value as Filter)} value={filter}>
                  {(['all', 'active', 'paused', 'completed'] as const).map(option => (
                    <DropdownMenuRadioItem key={option} value={option}>
                      {filterLabel[option]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="ml-auto flex gap-2">
            <Button className="rounded-full" onClick={() => setEditor({})} size="sm" variant="outline">
              <Plus className="size-4" />
              {t('create')}
            </Button>
            <Button
              className="rounded-full"
              onClick={() => {
                setTemplatesDismissed(false)
                setTemplatesOpen(true)
              }}
              size="sm"
              variant="outline"
            >
              <IconClipboardList size={15} />
              {t('fromTemplate')}
            </Button>
          </div>
        </div>

        {showTemplates ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {TASK_TEMPLATES.map(template => {
              const Icon = TEMPLATE_ICONS[template.icon]

              return (
                <button
                  className="flex items-center gap-5 rounded-xl border border-border/60 bg-muted/20 px-6 py-7 text-left transition-colors hover:bg-muted/50"
                  key={template.id}
                  onClick={() => setEditor({ template })}
                  type="button"
                >
                  <Icon className="shrink-0 text-muted-foreground" size={28} stroke={1.5} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{template.name}</span>
                    <span className="mt-1.5 block text-xs text-muted-foreground">{template.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <IconAlarm className="text-muted-foreground" size={28} stroke={1.5} />
            <h3 className="text-sm font-semibold">{t('emptyTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {visible.map(job => (
              <article
                className="flex cursor-pointer flex-col justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-5 transition-colors hover:bg-muted/40"
                key={job.id}
                onClick={() => void openLatestRun(job)}
              >
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <IconAlarm className="shrink-0 text-muted-foreground" size={22} stroke={1.6} />
                      <h3 className="truncate text-sm font-semibold text-foreground">{job.name || job.prompt}</h3>
                    </div>
                    {canReveal && job.workdir && (
                      <Button
                        aria-label={t('openFolder')}
                        onClick={event => {
                          event.stopPropagation()
                          void window.hermesDesktop.revealPath?.(job.workdir!)
                        }}
                        size="icon-sm"
                        title={t('openFolder')}
                        variant="ghost"
                      >
                        <IconFolder size={18} stroke={1.6} />
                      </Button>
                    )}
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{job.prompt}</p>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'truncate text-xs',
                      job.last_error && jobBucket(job) === 'active' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                    title={job.last_error ?? undefined}
                  >
                    {footerText(job)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1" onClick={event => event.stopPropagation()}>
                    <Button onClick={() => void openLatestRun(job)} size="sm" variant="ghost">
                      {t('view')}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button aria-label={t('more')} size="icon-sm" title={t('more')} variant="ghost">
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {job.state !== 'completed' && (
                          <DropdownMenuItem onSelect={() => setEditor({ job })}>
                            <Pencil className="size-4" />
                            {t('edit')}
                          </DropdownMenuItem>
                        )}
                        {jobBucket(job) === 'paused' && (
                          <DropdownMenuItem onSelect={() => void mutate(() => resumeCronJob(job.id))}>
                            <Play className="size-4" />
                            {t('resume')}
                          </DropdownMenuItem>
                        )}
                        {jobBucket(job) === 'active' && (
                          <DropdownMenuItem onSelect={() => void mutate(() => pauseCronJob(job.id))}>
                            <Pause className="size-4" />
                            {t('pause')}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => setPendingDelete(job)}>
                          <Trash2 className="size-4" />
                          {t('delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {editor && (
        <TaskEditor
          editor={editor}
          onClose={() => setEditor(null)}
          onSubmit={async values => {
            if (editor.job) {
              const job = editor.job

              const updates = {
                name: values.name,
                prompt: values.prompt,
                workdir: values.workdir || null
              } as CronJobUpdates

              if (values.schedule) {
                updates.schedule = values.schedule
              }

              await mutateAndRefreshCronJobs(profile, () => updateCronJob(job.id, updates))
              notify({ kind: 'success', message: t('updated') })
            } else {
              const payload = {
                deliver: 'local',
                name: values.name,
                prompt: values.prompt,
                schedule: values.schedule!,
                ...(values.workdir ? { workdir: values.workdir } : {})
              } as CronJobCreatePayload

              await mutateAndRefreshCronJobs(profile, () => createCronJob(payload))
              notify({ kind: 'success', message: t('created') })
              setTemplatesOpen(false)
              setTemplatesDismissed(true)
            }

            setEditor(null)
          }}
        />
      )}

      <ConfirmDialog
        confirmLabel={t('delete')}
        description={t('deleteBody')}
        destructive
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          const job = pendingDelete

          if (job) {
            await mutate(() => deleteCronJob(job.id))
          }

          setPendingDelete(null)
        }}
        open={pendingDelete !== null}
        title={t('deleteTitle')}
      />
    </Panel>
  )
}

/** 认不出的计划给个接近的初始显示：别处建的按分钟间隔显示成「按间隔」，其余用默认值。 */
function initialForm(job: JobWithDir | undefined, template: TaskTemplate | undefined): ScheduleForm {
  if (template) {
    return templateSchedule(template)
  }

  const form = defaultScheduleForm()
  const minutes = (job?.schedule as { minutes?: number } | undefined)?.minutes

  if (job?.schedule?.kind === 'interval' && typeof minutes === 'number' && minutes >= 60 && minutes % 60 === 0) {
    return {
      ...form,
      hour: '00',
      intervalHours: String(minutes / 60),
      minute: '00',
      mode: 'interval',
      weekdays: [...WEEKDAYS]
    }
  }

  return form
}

interface EditorValues {
  name: string
  prompt: string
  /** undefined = 保留原计划（编辑一个本页表达不了的计划且没改频率时）。 */
  schedule?: string
  workdir: string
}

interface TaskEditorProps {
  editor: EditorState
  onClose: () => void
  onSubmit: (values: EditorValues) => Promise<void>
}

/** 新建 / 编辑弹窗：任务名称、工作空间、提示词、执行频率。 */
function TaskEditor({ editor, onClose, onSubmit }: TaskEditorProps) {
  const t = useTasksCopy()
  const { job, template } = editor
  const parsed = job ? formFromJob(job) : null
  const [name, setName] = useState(job?.name ?? template?.name ?? '')
  const [prompt, setPrompt] = useState(job?.prompt ?? template?.prompt ?? '')
  const [workdir, setWorkdir] = useState(job?.workdir ?? '')

  const [form, setForm] = useState<ScheduleForm>(() => parsed ?? initialForm(job, template))

  const [scheduleTouched, setScheduleTouched] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const keepsCustom = Boolean(job && !parsed && !scheduleTouched)

  const update = (patch: Partial<ScheduleForm>) => {
    setForm(current => ({ ...current, ...patch }))
    setScheduleTouched(true)
    setError('')
  }

  const toggleWeekday = (day: Weekday) =>
    update({ weekdays: form.weekdays.includes(day) ? form.weekdays.filter(d => d !== day) : [...form.weekdays, day] })

  const toggleMonthDay = (day: number) =>
    update({
      monthDays: form.monthDays.includes(day) ? form.monthDays.filter(d => d !== day) : [...form.monthDays, day]
    })

  const chooseFolder = async () => {
    try {
      const [dir] = await selectDesktopPaths({ directories: true, title: t('chooseFolder') })

      if (dir) {
        setWorkdir(dir)
      }
    } catch (failure) {
      notifyError(failure, t('chooseFolder'))
    }
  }

  const submit = async () => {
    if (!prompt.trim()) {
      setError(t('promptRequired'))

      return
    }

    let schedule: string | undefined

    if (!keepsCustom) {
      const result = scheduleFromForm(form)

      if ('problem' in result) {
        const key = {
          date: 'problemDate',
          interval: 'problemInterval',
          monthDays: 'problemMonthDays',
          time: 'problemTime',
          weekdays: 'problemWeekdays'
        }[result.problem]

        setError(t(key))

        return
      }

      schedule = result.schedule
    }

    setSaving(true)

    try {
      await onSubmit({
        name: name.trim() || prompt.trim().slice(0, 24),
        prompt: prompt.trim(),
        schedule,
        workdir: workdir.trim()
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  const time = `${form.hour}:${form.minute}`

  const setTime = (value: string) => {
    const [hour = '', minute = ''] = value.split(':')

    if (hour && minute) {
      update({ hour, minute })
    }
  }

  return (
    <Dialog onOpenChange={open => !open && !saving && onClose()} open>
      <DialogContent className="max-w-[40rem]">
        <DialogTitle className="sr-only">{job ? t('edit') : t('create')}</DialogTitle>
        <div className="grid gap-4">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              {error}
            </div>
          )}

          <LabeledField label={t('name')}>
            <Input onChange={event => setName(event.target.value)} value={name} />
          </LabeledField>

          <LabeledField label={t('workspace')}>
            <div className="flex min-h-12 items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
              {workdir ? (
                <>
                  <IconFolder className="shrink-0 text-muted-foreground" size={16} />
                  <span className="min-w-0 flex-1 truncate text-xs" title={workdir}>
                    {workdir}
                  </span>
                  <Button aria-label={t('clearFolder')} onClick={() => setWorkdir('')} size="icon-xs" variant="ghost">
                    <X />
                  </Button>
                </>
              ) : (
                <Button
                  aria-label={t('chooseFolder')}
                  className="rounded-full"
                  onClick={() => void chooseFolder()}
                  size="icon-sm"
                  title={t('chooseFolder')}
                  variant="outline"
                >
                  <Plus className="size-4" />
                </Button>
              )}
            </div>
          </LabeledField>

          <LabeledField label={t('prompt')}>
            <Textarea
              className="min-h-24"
              onChange={event => {
                setPrompt(event.target.value)
                setError('')
              }}
              value={prompt}
            />
          </LabeledField>

          <LabeledField label={t('frequency')}>
            <Segmented
              onChange={mode => update({ mode })}
              options={[
                ['period', t('modePeriod')],
                ['interval', t('modeInterval')],
                ['once', t('modeOnce')]
              ]}
              value={form.mode}
            />
          </LabeledField>

          {keepsCustom && <p className="-mt-2 text-xs text-muted-foreground">{t('keepCustom')}</p>}

          {form.mode === 'period' && (
            <div className="flex flex-wrap items-center gap-3">
              <Select onValueChange={value => update({ period: value as Period })} value={form.period}>
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['daily', 'weekly', 'monthly', 'yearly'] as const).map(period => (
                    <SelectItem key={period} value={period}>
                      {t(period)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.period === 'weekly' && <WeekdayChips onToggle={toggleWeekday} selected={form.weekdays} />}
              {form.period === 'yearly' && (
                <>
                  <NumberSelect
                    count={12}
                    label={t('month', form.yearlyMonth)}
                    onChange={yearlyMonth => update({ yearlyMonth })}
                    render={month => t('month', month)}
                    value={form.yearlyMonth}
                  />
                  <NumberSelect
                    count={31}
                    label={t('day', form.yearlyDay)}
                    onChange={yearlyDay => update({ yearlyDay })}
                    render={day => t('day', day)}
                    value={form.yearlyDay}
                  />
                </>
              )}
              <Input className="w-28" onChange={event => setTime(event.target.value)} type="time" value={time} />
              {form.period === 'monthly' && (
                <div className="w-full">
                  <div className="mb-1.5 text-xs text-muted-foreground">{t('monthDaysPick')}</div>
                  <div className="grid w-fit grid-cols-7 gap-1">
                    {Array.from({ length: 31 }, (_, index) => index + 1).map(day => (
                      <button
                        className={cn(
                          'size-8 rounded-md text-xs',
                          form.monthDays.includes(day)
                            ? 'bg-(--ui-accent) text-white'
                            : 'border border-border/60 text-muted-foreground hover:bg-muted/50'
                        )}
                        key={day}
                        onClick={() => toggleMonthDay(day)}
                        type="button"
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {form.mode === 'interval' && (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t('every')}</span>
                <Input
                  className="w-16 text-center"
                  inputMode="numeric"
                  onChange={event => update({ intervalHours: event.target.value.replace(/\D/g, '').slice(0, 2) })}
                  value={form.intervalHours}
                />
                <span>{t('hours')}</span>
                <span className="ml-3 text-muted-foreground">{t('startAt')}</span>
                <Input className="w-28" onChange={event => setTime(event.target.value)} type="time" value={time} />
              </div>
              <WeekdayChips onToggle={toggleWeekday} selected={form.weekdays} />
            </div>
          )}

          {form.mode === 'once' && (
            <div className="flex flex-wrap items-center gap-3">
              <Input
                className="w-40"
                onChange={event => update({ onceDate: event.target.value })}
                type="date"
                value={form.onceDate}
              />
              <Input className="w-28" onChange={event => setTime(event.target.value)} type="time" value={time} />
            </div>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button disabled={saving} onClick={onClose} variant="outline">
            {t('cancel')}
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {job ? t('save') : t('add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LabeledField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm text-foreground">{label}</span>
      {children}
    </div>
  )
}

function Segmented({
  onChange,
  options,
  value
}: {
  onChange: (value: FrequencyMode) => void
  options: [FrequencyMode, string][]
  value: FrequencyMode
}) {
  return (
    <div className="flex w-fit overflow-hidden rounded-lg border border-border/60">
      {options.map(([id, label]) => (
        <button
          className={cn(
            'border-r border-border/60 px-6 py-1.5 text-sm last:border-r-0',
            value === id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/40'
          )}
          key={id}
          onClick={() => onChange(id)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function WeekdayChips({ onToggle, selected }: { onToggle: (day: Weekday) => void; selected: readonly Weekday[] }) {
  const t = useTasksCopy()

  return (
    <div className="flex w-fit overflow-hidden rounded-lg border border-border/60">
      {WEEKDAYS.map(day => (
        <button
          aria-pressed={selected.includes(day)}
          className={cn(
            'border-r border-border/60 px-2.5 py-1.5 text-xs last:border-r-0',
            selected.includes(day) ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/40'
          )}
          key={day}
          onClick={() => onToggle(day)}
          type="button"
        >
          {t(`weekday.${day}`)}
        </button>
      ))}
    </div>
  )
}

function NumberSelect({
  count,
  label,
  onChange,
  render,
  value
}: {
  count: number
  label: string
  onChange: (value: number) => void
  render: (value: number) => string
  value: number
}) {
  return (
    <Select onValueChange={next => onChange(Number(next))} value={String(value)}>
      <SelectTrigger aria-label={label} className="h-9 w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: count }, (_, index) => index + 1).map(option => (
          <SelectItem key={option} value={String(option)}>
            {render(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
