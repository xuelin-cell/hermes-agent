import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $interfaceMode, setInterfaceMode } from '@/store/interface-mode'
import { $workspaceCategory, setWorkspaceCategory } from '@/store/workspace-category'

import { WorkspaceCategoryTabs } from './workspace-category-tabs'

afterEach(cleanup)

it('shares the office layout between work and life and restores development on a round trip', () => {
  setWorkspaceCategory('work')
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <WorkspaceCategoryTabs />
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('tab', { name: '学习生活' }))
  expect($interfaceMode.get()).toBe('simple')
  expect($workspaceCategory.get()).toBe('life')

  fireEvent.click(screen.getByRole('tab', { name: '代码开发' }))
  expect($interfaceMode.get()).toBe('advanced')
  expect(screen.getByRole('tab', { name: '代码开发' }).getAttribute('aria-selected')).toBe('true')

  act(() => setInterfaceMode('simple'))
  expect(screen.getByRole('tab', { name: '学习生活' }).getAttribute('aria-selected')).toBe('true')

  fireEvent.click(screen.getByRole('tab', { name: '日常办公' }))
  expect($interfaceMode.get()).toBe('simple')
  expect($workspaceCategory.get()).toBe('work')
})

it('moves keyboard focus and selection together within the rendered tablist', () => {
  setWorkspaceCategory('work')

  const { container } = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <WorkspaceCategoryTabs />
    </I18nProvider>
  )

  fireEvent.keyDown(screen.getByRole('tab', { name: '日常办公' }), { key: 'End' })
  expect(container.ownerDocument.activeElement).toBe(screen.getByRole('tab', { name: '学习生活' }))
  expect($workspaceCategory.get()).toBe('life')
  fireEvent.keyDown(screen.getByRole('tab', { name: '学习生活' }), { key: 'ArrowLeft' })
  expect(container.ownerDocument.activeElement).toBe(screen.getByRole('tab', { name: '代码开发' }))
  expect($interfaceMode.get()).toBe('advanced')
})
