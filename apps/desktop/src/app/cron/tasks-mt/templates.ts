import { defaultScheduleForm, type ScheduleForm, WEEKDAYS } from './schedule'

export type TemplateIcon = 'bulb' | 'clipboard' | 'language' | 'moon' | 'movie' | 'phone' | 'water'

export interface TaskTemplate {
  description: string
  icon: TemplateIcon
  id: string
  name: string
  prompt: string
  schedule: Partial<ScheduleForm>
}

// 与 UniWork 桌面版「从模板入手」的 8 个模板一致（文案原样，频率换成 Hermes 能执行的写法）。
export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    description: '盘点 GitHub Trending 与 HN 热门讨论，生成周末技术周刊。',
    icon: 'clipboard',
    id: 'weekly-tech-trends',
    name: '每周技术趋势周刊生成',
    prompt:
      '自动盘点本周 GitHub Trending 上与 Rust/Go 相关的热门开源项目，以及 HN (Hacker News) 前 10 的技术讨论。将项目简介翻译成中文，并生成一份适合周末阅读的技术周刊。',
    schedule: { hour: '18', minute: '00', period: 'weekly', weekdays: ['fri'] }
  },
  {
    description: '每天推荐 5 个高频实用英语单词，包含词义、音标和例句。',
    icon: 'language',
    id: 'english-words',
    name: '每日 5 个英语单词',
    prompt: '每天推荐 5 个高频实用英语单词，包含中文释义、音标、常见搭配和英文例句。尽量选择工作和生活中常用的词。',
    schedule: { hour: '08', minute: '30', period: 'daily' }
  },
  {
    description: '每天 9:00 发送今日待办清单编写提醒，开启高效一天。',
    icon: 'moon',
    id: 'morning-todo-reminder',
    name: '待办事项清晨提醒',
    prompt: '每天早上9:00，给我发送一封“今日待办清单”编写提醒，帮助我开启高效的一天。',
    schedule: { hour: '09', minute: '00', period: 'daily' }
  },
  {
    description: '每周五汇总仓库 PR 与 Issue 进展，输出关键变化和风险。',
    icon: 'clipboard',
    id: 'weekly-report',
    name: '每周工作周报',
    prompt:
      '每周五汇总本周工作进展。请梳理仓库 PR 与 Issue 的关键变化、已完成事项、待跟进事项和潜在风险，最后给出下周建议。',
    schedule: { hour: '18', minute: '00', period: 'weekly', weekdays: ['fri'] }
  },
  {
    description: '推荐一部高分经典电影，简要介绍剧情梗概、亮点和观看理由。',
    icon: 'movie',
    id: 'classic-movie',
    name: '经典电影推荐',
    prompt: '推荐一部高分经典电影，简要介绍剧情梗概、导演/主演、亮点和适合观看的理由。避免剧透关键结局。',
    schedule: { hour: '20', minute: '00', period: 'weekly', weekdays: ['sat'] }
  },
  {
    description: '每隔 1 小时提醒你喝一次水，保持身体健康舒适。',
    icon: 'water',
    id: 'drink-water-reminder',
    name: '提醒喝水',
    prompt: '每隔1小时提醒我喝一次水，保持身体健康舒适！',
    schedule: { hour: '08', intervalHours: '1', minute: '00', mode: 'interval', weekdays: [...WEEKDAYS] }
  },
  {
    description: '每天抛出一个有趣问题，先提问再解答，语气轻松易懂。',
    icon: 'bulb',
    id: 'daily-why',
    name: '每日一个为什么',
    prompt: '每天抛出一个有趣的“为什么”问题，先提出问题，再用轻松易懂的方式解答。内容要有知识性，也适合日常分享。',
    schedule: { hour: '20', minute: '30', period: 'daily' }
  },
  {
    description: '每周日 10:00 提醒你给家人打电话或发消息，简单温暖。',
    icon: 'phone',
    id: 'family-reminder',
    name: '父母联系提醒',
    prompt: '每周日 10:00 提醒我给家人打电话或发消息。提醒内容要简洁、温暖，并可以附上一句适合开启聊天的话。',
    schedule: { hour: '10', minute: '00', period: 'weekly', weekdays: ['sun'] }
  }
]

/** 模板的频率套到默认表单上，没写的项用默认值。 */
export function templateSchedule(template: TaskTemplate, now: Date = new Date()): ScheduleForm {
  return { ...defaultScheduleForm(now), ...template.schedule }
}
