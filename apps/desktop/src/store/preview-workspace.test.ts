import { afterEach, expect, it, vi } from 'vitest'
import { $previewTabs, openPreview, setPreviewScope } from './preview'
import { $selectedWorkspaceMode } from './workspace-scope'
import { $rightRailActiveTabId } from './layout'

afterEach(() => {
  $selectedWorkspaceMode.set('codex')
  $previewTabs.set([])
  $selectedWorkspaceMode.set('work')
  $previewTabs.set([])
  $selectedWorkspaceMode.set(null)
})

it('restores the selected preview separately for office/study and code, including after reload', async () => {
  setPreviewScope('workspace-regression')
  $selectedWorkspaceMode.set('work')
  openPreview({
    kind: 'file',
    path: '/office/report.md',
    label: 'report',
    source: '/office/report.md',
    url: 'file:///office/report.md'
  })
  const officeTab = $rightRailActiveTabId.get()
  $selectedWorkspaceMode.set('codex')
  expect($previewTabs.get()).toEqual([])
  openPreview({ kind: 'file', path: '/code/app.ts', label: 'app', source: '/code/app.ts', url: 'file:///code/app.ts' })
  const codeTab = $rightRailActiveTabId.get()
  $selectedWorkspaceMode.set('work')
  expect($previewTabs.get().map(tab => tab.target.path)).toEqual(['/office/report.md'])
  expect($rightRailActiveTabId.get()).toBe(officeTab)
  $selectedWorkspaceMode.set('codex')
  expect($previewTabs.get().map(tab => tab.target.path)).toEqual(['/code/app.ts'])
  expect($rightRailActiveTabId.get()).toBe(codeTab)

  vi.resetModules()
  const restored = await import('./preview')
  const scope = await import('./workspace-scope')
  const layout = await import('./layout')
  restored.setPreviewScope('workspace-regression')
  expect(restored.$previewTabs.get().map(tab => tab.target.path)).toEqual(['/code/app.ts'])
  expect(layout.$rightRailActiveTabId.get()).toBe(codeTab)
  scope.$selectedWorkspaceMode.set('work')
  expect(restored.$previewTabs.get().map(tab => tab.target.path)).toEqual(['/office/report.md'])
  expect(layout.$rightRailActiveTabId.get()).toBe(officeTab)
})


it('replaces the previous file preview in the current conversation', () => {
  setPreviewScope('single-file')
  openPreview({ kind: 'file', label: 'first.md', source: '/first.md', path: '/first.md', url: 'file:///first.md' })
  openPreview({ kind: 'file', label: 'second.md', source: '/second.md', path: '/second.md', url: 'file:///second.md' })
  expect($previewTabs.get().map(tab => tab.target.path)).toEqual(['/second.md'])
  expect($rightRailActiveTabId.get()).toBe($previewTabs.get()[0].id)
})
