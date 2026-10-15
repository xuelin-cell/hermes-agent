import { ensureContrast } from '@hermes/shared/color'

import { uniworkTheme } from '@/themes/uniwork'

/** 登录窗只应用视觉令牌，不加载依赖会话状态的主题上下文，避免认证前连接后端。 */
export function applyLoginTheme(): void {
  const root = document.documentElement
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const colors = dark ? uniworkTheme.darkColors! : uniworkTheme.colors
  root.dataset.hermesTheme = uniworkTheme.name
  root.dataset.hermesMode = dark ? 'dark' : 'light'
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  const tokens: Record<string, string> = {
    '--theme-foreground': colors.foreground,
    '--theme-primary': colors.primary,
    '--theme-secondary': colors.secondary,
    '--theme-accent-soft': colors.accent,
    '--theme-midground': colors.midground!,
    '--theme-background-seed': colors.background,
    '--theme-sidebar-seed': colors.sidebarBackground!,
    '--theme-card-seed': colors.card,
    '--theme-elevated-seed': colors.popover,
    '--theme-bubble-seed': colors.userBubble!,
    '--dt-primary-solid': ensureContrast(colors.primary, '#fcfcfc', 4.5),
    '--dt-primary-solid-foreground': '#fcfcfc',
    '--dt-font-sans': uniworkTheme.typography!.fontSans!
  }
  for (const [key, value] of Object.entries(colors)) {
    tokens[`--dt-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] = value
  }
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value)
}
