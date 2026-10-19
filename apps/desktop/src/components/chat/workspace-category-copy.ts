import type { Locale } from '@/i18n'

interface WorkspaceCategoryCopy {
  label: string
  work: string
  code: string
  life: string
}

export const workspaceCategoryCopy: Record<Locale, WorkspaceCategoryCopy> = {
  en: { label: 'Workspace', work: 'Daily work', code: 'Code development', life: 'Learning & life' },
  zh: { label: '工作空间', work: '日常办公', code: '代码开发', life: '学习生活' },
  'zh-hant': { label: '工作空間', work: '日常辦公', code: '程式開發', life: '學習生活' },
  ja: { label: 'ワークスペース', work: '日常業務', code: 'コード開発', life: '学習・生活' },
  ar: { label: 'مساحة العمل', work: 'العمل اليومي', code: 'تطوير البرمجيات', life: 'التعلم والحياة' },
  ru: { label: 'Рабочая область', work: 'Работа', code: 'Разработка', life: 'Учёба и жизнь' },
  fr: { label: 'Espace de travail', work: 'Bureautique', code: 'Développement', life: 'Études et vie' },
  de: { label: 'Arbeitsbereich', work: 'Büroalltag', code: 'Entwicklung', life: 'Lernen & Leben' },
  es: { label: 'Espacio de trabajo', work: 'Trabajo diario', code: 'Desarrollo', life: 'Estudio y vida' }
}
