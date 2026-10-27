import type { DesktopTheme, DesktopThemeColors } from './types'

// MasterGo 204500798093134 / 24:09019：白底、石墨文字、橙黄强调。
const light: DesktopThemeColors = {
  background: '#ffffff',
  foreground: '#101219',
  card: '#ffffff',
  cardForeground: '#101219',
  muted: '#f0f0f0',
  mutedForeground: '#686f82',
  popover: '#ffffff',
  popoverForeground: '#101219',
  primary: '#f5765a',
  primaryForeground: '#ffffff',
  secondary: '#f0f0f0',
  secondaryForeground: '#32374a',
  accent: '#feeeea',
  accentForeground: '#b52e13',
  border: '#e6e9ed',
  input: '#e6e9ed',
  ring: '#f5765a',
  midground: '#f5765a',
  composerRing: '#f5765a',
  destructive: '#c52b20',
  destructiveForeground: '#ffffff',
  sidebarBackground: '#f7f7f7',
  sidebarBorder: '#e6e9ed',
  userBubble: '#feeeea',
  userBubbleBorder: '#f8d7cd'
}

export const uniworkTheme: DesktopTheme = {
  name: 'uniwork',
  label: '元景 · UniWork',
  description: '元景数字员工 · 白底橙黄，清晰轻盈',
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
    primary: '#f5765a',
    primaryForeground: '#17181c',
    secondary: '#2b2d34',
    secondaryForeground: '#d8dbe4',
    accent: '#422b28',
    accentForeground: '#ffb4a1',
    border: '#363941',
    input: '#363941',
    ring: '#f5765a',
    midground: '#f5765a',
    composerRing: '#f5765a',
    destructive: '#f38d83',
    destructiveForeground: '#17181c',
    sidebarBackground: '#1d1e23',
    sidebarBorder: '#30323a',
    userBubble: '#352725',
    userBubbleBorder: '#53372f'
  },
  typography: {
    // 设计字体未安装时回退到系统中文字体；代码字体沿用内置等宽字体。
    fontSans:
      '"DFPKingGothicGB-Regular", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'
  }
}
