import type { DesktopTheme, DesktopThemeColors } from './types'

// 元景默认视觉：白底、石墨文字、冷蓝强调。暖色只用于警告等状态语义。
const light: DesktopThemeColors = {
  background: '#ffffff',
  foreground: '#101219',
  card: '#ffffff',
  cardForeground: '#101219',
  muted: '#f0f0f0',
  mutedForeground: '#686f82',
  popover: '#ffffff',
  popoverForeground: '#101219',
  primary: '#1769d6',
  primaryForeground: '#ffffff',
  secondary: '#f0f0f0',
  secondaryForeground: '#32374a',
  accent: '#eaf2ff',
  accentForeground: '#124a9c',
  border: '#e6e9ed',
  input: '#e6e9ed',
  ring: '#1769d6',
  midground: '#1769d6',
  composerRing: '#1769d6',
  destructive: '#c52b20',
  destructiveForeground: '#ffffff',
  sidebarBackground: '#f7f7f7',
  sidebarBorder: '#e6e9ed',
  userBubble: '#eaf2ff',
  userBubbleBorder: '#c9deff'
}

export const uniworkTheme: DesktopTheme = {
  name: 'uniwork',
  label: '元景 · UniWork',
  description: '元景数字员工 · 白底冷蓝，清晰专业',
  colors: light,
  darkColors: {
    ...light,
    background: '#17181c',
    foreground: '#edeef2',
    card: '#202126',
    cardForeground: '#edeef2',
    muted: '#282a30',
    mutedForeground: '#a5aaba',
    popover: '#24262c',
    popoverForeground: '#edeef2',
    primary: '#68a7ff',
    primaryForeground: '#17181c',
    secondary: '#2b2d34',
    secondaryForeground: '#d8dbe4',
    accent: '#18365d',
    accentForeground: '#b9d6ff',
    border: '#363941',
    input: '#363941',
    ring: '#68a7ff',
    midground: '#68a7ff',
    composerRing: '#68a7ff',
    destructive: '#f38d83',
    destructiveForeground: '#17181c',
    sidebarBackground: '#1d1e23',
    sidebarBorder: '#30323a',
    userBubble: '#18365d',
    userBubbleBorder: '#285080'
  },
  typography: {
    // 设计字体未安装时回退到系统中文字体；代码字体沿用内置等宽字体。
    fontSans:
      '"DFPKingGothicGB-Regular", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'
  }
}
