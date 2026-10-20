import { describe, expect, it } from 'vitest'

import {
  defaultScheduleForm,
  describeForm,
  formFromJob,
  type ScheduleForm,
  scheduleFromForm,
  type ScheduleWords,
  WEEKDAYS
} from './schedule'
import { TASK_TEMPLATES, templateSchedule } from './templates'

const NOW = new Date(2026, 9, 19, 10, 0)
const base = defaultScheduleForm(NOW)

const WORDS: ScheduleWords = {
  daily: '每天',
  everyHours: hours => `每隔 ${hours} 小时`,
  from: time => `（${time} 起）`,
  monthly: days => `每月 ${days} 日`,
  once: (date, time) => `单次 ${date} ${time}`,
  weekday: { fri: '周五', mon: '周一', sat: '周六', sun: '周日', thu: '周四', tue: '周二', wed: '周三' },
  weekdaysSeparator: '、',
  weekly: days => (days === '工作日' ? days : `每${days}`),
  workdays: '工作日',
  yearly: (month, day) => `每年 ${month} 月 ${day} 日`
}

function schedule(form: Partial<ScheduleForm>): string {
  const result = scheduleFromForm({ ...base, ...form })

  if ('problem' in result) {
    throw new Error(result.problem)
  }

  return result.schedule
}

function roundTrip(form: Partial<ScheduleForm>): ScheduleForm | null {
  const expr = schedule(form)
  const kind = /T\d{2}:\d{2}$/.test(expr) ? 'once' : 'cron'

  return formFromJob(
    { schedule: kind === 'once' ? ({ kind, run_at: `${expr}:00+08:00` } as never) : { expr, kind } },
    NOW
  )
}

describe('tasks-mt schedule', () => {
  it('每天 / 每周 / 每月 / 每年 写成 cron，单次写成 ISO 时间', () => {
    expect(schedule({ hour: '08', minute: '30', period: 'daily' })).toBe('30 8 * * *')
    expect(schedule({ hour: '18', period: 'weekly', weekdays: ['fri', 'mon'] })).toBe('0 18 * * 1,5')
    expect(schedule({ monthDays: [15, 1], period: 'monthly' })).toBe('0 9 1,15 * *')
    expect(schedule({ period: 'yearly', yearlyDay: 8, yearlyMonth: 3 })).toBe('0 9 8 3 *')
    expect(schedule({ hour: '07', minute: '05', mode: 'once', onceDate: '2026-12-01' })).toBe('2026-12-01T07:05')
  })

  it('按间隔：从起始时间起每隔 N 小时，按星期执行；七天全选写成 *', () => {
    expect(schedule({ hour: '08', intervalHours: '2', mode: 'interval', weekdays: [...WEEKDAYS] })).toBe(
      '0 8-23/2 * * *'
    )
    expect(schedule({ intervalHours: '3', mode: 'interval', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] })).toBe(
      '0 9-23/3 * * 1,2,3,4,5'
    )
  })

  it('不合法的表单给出原因，不生成计划', () => {
    expect(scheduleFromForm({ ...base, period: 'weekly', weekdays: [] })).toEqual({ problem: 'weekdays' })
    expect(scheduleFromForm({ ...base, monthDays: [], period: 'monthly' })).toEqual({ problem: 'monthDays' })
    expect(scheduleFromForm({ ...base, intervalHours: '0', mode: 'interval' })).toEqual({ problem: 'interval' })
    expect(scheduleFromForm({ ...base, hour: '24' })).toEqual({ problem: 'time' })
    expect(scheduleFromForm({ ...base, mode: 'once', onceDate: '' })).toEqual({ problem: 'date' })
  })

  it('本页写出的计划都能原样读回表单', () => {
    for (const form of [
      { hour: '08', minute: '30', period: 'daily' as const },
      { period: 'weekly' as const, weekdays: ['sat' as const] },
      { monthDays: [1, 15], period: 'monthly' as const },
      { period: 'yearly' as const, yearlyDay: 8, yearlyMonth: 3 },
      { hour: '08', intervalHours: '1', mode: 'interval' as const, weekdays: [...WEEKDAYS] },
      { mode: 'once' as const, onceDate: '2026-12-01' }
    ]) {
      const back = roundTrip(form)

      expect(back).not.toBeNull()
      expect(scheduleFromForm(back!)).toEqual(scheduleFromForm({ ...base, ...form }))
    }
  })

  it('别处设置的计划认不出时返回 null，编辑时原样保留', () => {
    expect(formFromJob({ schedule: { display: 'every 120m', kind: 'interval' } })).toBeNull()
    expect(formFromJob({ schedule: { expr: '*/15 * * * *', kind: 'cron' } })).toBeNull()
    expect(formFromJob({ schedule: { expr: '0 9 * * 1-5', kind: 'cron' } }, NOW)).toMatchObject({
      period: 'weekly',
      weekdays: ['mon', 'tue', 'wed', 'thu', 'fri']
    })
  })

  it('卡片说明文字', () => {
    expect(describeForm({ ...base, hour: '08', minute: '30' }, WORDS)).toBe('每天 08:30')
    expect(describeForm({ ...base, period: 'weekly', weekdays: ['fri'] }, WORDS)).toBe('每周五 09:00')
    expect(describeForm({ ...base, period: 'weekly', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] }, WORDS)).toBe(
      '工作日 09:00'
    )
    expect(describeForm({ ...base, intervalHours: '1', mode: 'interval', weekdays: [...WEEKDAYS] }, WORDS)).toBe(
      '每隔 1 小时（09:00 起）'
    )
  })

  it('8 个模板都能生成合法的计划', () => {
    expect(TASK_TEMPLATES).toHaveLength(8)

    for (const template of TASK_TEMPLATES) {
      expect('schedule' in scheduleFromForm(templateSchedule(template, NOW))).toBe(true)
    }
  })
})
