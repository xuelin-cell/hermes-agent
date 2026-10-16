import { afterEach, expect, it, vi } from 'vitest'

import { uniworkTheme } from '@/themes/uniwork'

import { applyLoginTheme } from './theme'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('paints the login form from the shared palette without a desktop bridge (dark=%s)', dark => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: dark }))
  )
  applyLoginTheme()
  const root = document.documentElement
  const colors = dark ? uniworkTheme.darkColors! : uniworkTheme.colors
  expect(root.dataset.hermesTheme).toBe(uniworkTheme.name)
  expect(root.classList.contains('dark')).toBe(dark)
  expect(root.style.getPropertyValue('--dt-primary')).toBe(colors.primary)
  expect(root.style.getPropertyValue('--dt-border')).toBe(colors.border)
  expect(root.style.getPropertyValue('--theme-card-seed')).toBe(colors.card)
  expect(root.style.getPropertyValue('--dt-font-sans')).toBe(uniworkTheme.typography!.fontSans)
})
