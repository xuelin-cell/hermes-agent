import type { CronJob } from '@/types/hermes'

/** 执行频率：周期（每天 / 每周 / 每月 / 每年）、按间隔、单次；与 UniWork 定时任务一致。 */
export type FrequencyMode = 'interval' | 'once' | 'period'
export type Period = 'daily' | 'monthly' | 'weekly' | 'yearly'
export type Weekday = 'fri' | 'mon' | 'sat' | 'sun' | 'thu' | 'tue' | 'wed'

export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const CRON_DAY: Record<Weekday, number> = { fri: 5, mon: 1, sat: 6, sun: 0, thu: 4, tue: 2, wed: 3 }
const DAY_OF_CRON: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface ScheduleForm {
  hour: string
  intervalHours: string
  minute: string
  mode: FrequencyMode
  monthDays: number[]
  /** 单次运行的日期 YYYY-MM-DD。 */
  onceDate: string
  period: Period
  weekdays: Weekday[]
  yearlyDay: number
  yearlyMonth: number
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 今天的日期，作为单次任务的默认值。 */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function defaultScheduleForm(now: Date = new Date()): ScheduleForm {
  return {
    hour: '09',
    intervalHours: '1',
    minute: '00',
    mode: 'period',
    monthDays: [1],
    onceDate: todayIso(now),
    period: 'daily',
    weekdays: ['mon'],
    yearlyDay: now.getDate(),
    yearlyMonth: now.getMonth() + 1
  }
}

function cronDays(weekdays: readonly Weekday[]): string {
  const days = [...new Set(weekdays)].map(day => CRON_DAY[day]).sort((a, b) => a - b)

  return days.length === 7 ? '*' : days.join(',')
}

export type ScheduleProblem = 'date' | 'interval' | 'monthDays' | 'time' | 'weekdays'

/** 表单 → Hermes 能解析的计划：cron 表达式或 ISO 时间（单次）。不合法时返回原因。 */
export function scheduleFromForm(form: ScheduleForm): { problem: ScheduleProblem } | { schedule: string } {
  const hour = Number.parseInt(form.hour, 10)
  const minute = Number.parseInt(form.minute, 10)

  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    return { problem: 'time' }
  }

  if (form.mode === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.onceDate)) {
      return { problem: 'date' }
    }

    return { schedule: `${form.onceDate}T${pad(hour)}:${pad(minute)}` }
  }

  if (form.mode === 'interval') {
    const every = Number.parseInt(form.intervalHours, 10)

    if (!(every >= 1 && every <= 23)) {
      return { problem: 'interval' }
    }

    if (!form.weekdays.length) {
      return { problem: 'weekdays' }
    }

    // 从起始时间开始，每隔 N 小时一次，到当天结束；按选中的星期执行。
    return { schedule: `${minute} ${hour}-23/${every} * * ${cronDays(form.weekdays)}` }
  }

  switch (form.period) {
    case 'daily':
      return { schedule: `${minute} ${hour} * * *` }

    case 'weekly':
      return form.weekdays.length
        ? { schedule: `${minute} ${hour} * * ${cronDays(form.weekdays)}` }
        : { problem: 'weekdays' }
    case 'monthly': {
      const days = [...new Set(form.monthDays)].filter(day => day >= 1 && day <= 31).sort((a, b) => a - b)

      return days.length ? { schedule: `${minute} ${hour} ${days.join(',')} * *` } : { problem: 'monthDays' }
    }

    case 'yearly':
      return { schedule: `${minute} ${hour} ${form.yearlyDay} ${form.yearlyMonth} *` }
  }
}

function parseDays(field: string): null | Weekday[] {
  if (field === '*') {
    return [...WEEKDAYS]
  }

  const days: Weekday[] = []

  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part)

    if (range) {
      for (let day = Number(range[1]); day <= Number(range[2]); day += 1) {
        days.push(DAY_OF_CRON[day % 7])
      }

      continue
    }

    if (!/^\d$/.test(part) || Number(part) > 7) {
      return null
    }

    days.push(DAY_OF_CRON[Number(part) % 7])
  }

  return WEEKDAYS.filter(day => days.includes(day))
}

/** 已有任务 → 表单；本页没法表达的计划返回 null，编辑时原样保留。 */
export function formFromJob(job: Pick<CronJob, 'schedule'>, now: Date = new Date()): null | ScheduleForm {
  const base = defaultScheduleForm(now)
  const schedule = job.schedule

  if (!schedule) {
    return null
  }

  if (schedule.kind === 'once') {
    const runAt = (schedule as { run_at?: string }).run_at ?? ''
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(runAt)

    return match ? { ...base, hour: match[2], minute: match[3], mode: 'once', onceDate: match[1] } : null
  }

  const expr = (schedule.expr ?? '').trim()
  const fields = expr.split(/\s+/)

  if (schedule.kind !== 'cron' || fields.length !== 5) {
    return null
  }

  const [minuteField, hourField, dayField, monthField, weekField] = fields

  if (!/^\d{1,2}$/.test(minuteField)) {
    return null
  }

  const minute = pad(Number(minuteField))
  const interval = /^(\d{1,2})-23\/(\d{1,2})$/.exec(hourField)

  if (interval && dayField === '*' && monthField === '*') {
    const weekdays = parseDays(weekField)

    return weekdays
      ? { ...base, hour: pad(Number(interval[1])), intervalHours: interval[2], minute, mode: 'interval', weekdays }
      : null
  }

  if (!/^\d{1,2}$/.test(hourField)) {
    return null
  }

  const hour = pad(Number(hourField))

  if (dayField === '*' && monthField === '*') {
    const weekdays = parseDays(weekField)

    if (!weekdays) {
      return null
    }

    return weekdays.length === 7
      ? { ...base, hour, minute, period: 'daily' }
      : { ...base, hour, minute, period: 'weekly', weekdays }
  }

  if (weekField === '*' && monthField === '*' && /^\d{1,2}(,\d{1,2})*$/.test(dayField)) {
    return { ...base, hour, minute, monthDays: dayField.split(',').map(Number), period: 'monthly' }
  }

  if (weekField === '*' && /^\d{1,2}$/.test(dayField) && /^\d{1,2}$/.test(monthField)) {
    return { ...base, hour, minute, period: 'yearly', yearlyDay: Number(dayField), yearlyMonth: Number(monthField) }
  }

  return null
}

export interface ScheduleWords {
  daily: string
  everyHours: (hours: string) => string
  from: (time: string) => string
  monthly: (days: string) => string
  once: (date: string, time: string) => string
  weekday: Record<Weekday, string>
  weekdaysSeparator: string
  weekly: (days: string) => string
  workdays: string
  yearly: (month: number, day: number) => string
}

function weekdayText(weekdays: readonly Weekday[], words: ScheduleWords): string {
  const set = new Set(weekdays)

  if (set.size === 5 && !set.has('sat') && !set.has('sun')) {
    return words.workdays
  }

  return WEEKDAYS.filter(day => set.has(day))
    .map(day => words.weekday[day])
    .join(words.weekdaysSeparator)
}

/** 卡片上显示的频率说明，例如「每天 08:30」「每周五 18:00」「每隔 1 小时（08:00 起）」。 */
export function describeForm(form: ScheduleForm, words: ScheduleWords): string {
  const time = `${form.hour}:${form.minute}`

  if (form.mode === 'once') {
    return words.once(form.onceDate, time)
  }

  if (form.mode === 'interval') {
    const days = form.weekdays.length === 7 ? '' : ` · ${weekdayText(form.weekdays, words)}`

    return `${words.everyHours(form.intervalHours)}${words.from(time)}${days}`
  }

  switch (form.period) {
    case 'daily':
      return `${words.daily} ${time}`

    case 'weekly':
      return `${words.weekly(weekdayText(form.weekdays, words))} ${time}`

    case 'monthly':
      return `${words.monthly([...form.monthDays].sort((a, b) => a - b).join('、'))} ${time}`

    case 'yearly':
      return `${words.yearly(form.yearlyMonth, form.yearlyDay)} ${time}`
  }
}
