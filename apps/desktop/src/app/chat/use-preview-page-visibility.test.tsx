import { act, render } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useNavigate } from 'react-router'
import { expect, it, vi } from 'vitest'

import { $hiddenTreePanes } from '@/components/pane-shell/tree/store'

const tabs = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/store/preview', () => ({ get $dockedPreviewTabs() { return tabs.value } }))

import { usePreviewPageVisibility } from './use-preview-page-visibility'

it('hides task previews on capabilities and restores them when returning to chat', () => {
  tabs.value = atom([{ id: 'file:report.csv' }])
  let navigate: ReturnType<typeof useNavigate>
  function Probe() {
    navigate = useNavigate()
    usePreviewPageVisibility()
    return null
  }
  const pane = 'preview-tile:file:report.csv'
  const view = render(<MemoryRouter initialEntries={['/']}><Probe /></MemoryRouter>)
  expect($hiddenTreePanes.get().has(pane)).toBe(false)
  act(() => navigate('/capabilities?tab=connectors'))
  expect($hiddenTreePanes.get().has(pane)).toBe(true)
  act(() => navigate('/'))
  expect($hiddenTreePanes.get().has(pane)).toBe(false)
  view.unmount()
})
