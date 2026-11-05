import type { Locale } from '@/i18n'

interface WorkspaceCategoryCopy {
  label: string
}

export const workspaceCategoryCopy: Record<Locale, WorkspaceCategoryCopy> = {
  en: { label: 'Workspace' },
  zh: { label: '工作空间' },
  'zh-hant': { label: '工作空間' }
}
