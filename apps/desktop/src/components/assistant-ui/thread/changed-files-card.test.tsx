import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ReviewPane } from '@/app/right-sidebar/review'
import { I18nProvider, TRANSLATIONS } from '@/i18n'
import {
  $reviewDiff,
  $reviewFiles,
  $reviewOpen,
  $reviewSelectedPath,
  closeReview,
  commitChanges,
  openReview,
  refreshReview,
  requestRevert,
  revealReview,
  selectReviewFile,
  stageReviewFile
} from '@/store/review'
import { $currentCwd, $selectedStoredSessionId } from '@/store/session'
import { deferred } from '@/test/deferred'

import { ChangedFilesCard } from './changed-files-card'

const firstDiff = '--- a/report.txt\n+++ b/report.txt\n@@ -1 +1 @@\n-old wording\n+first revision'
const secondDiff = '--- a/report.txt\n+++ b/report.txt\n@@ -1 +1 @@\n-first revision\n+final wording'

const parts = [firstDiff, secondDiff].map(diff => ({
  type: 'tool-call',
  toolName: 'patch',
  args: { path: 'report.txt' },
  result: { success: true, diff }
}))

parts.push({
  type: 'tool-call',
  toolName: 'patch',
  args: { path: 'notes.txt' },
  result: { success: true, diff: '--- a/notes.txt\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+second file content' }
})

/** 使用正式卡片、审查面板和 Diff 组件，恢复后的工具结果也走相同入口。 */
function renderReview() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ChangedFilesCard parts={JSON.parse(JSON.stringify(parts))} />
      <ReviewPane />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  closeReview()
  $reviewFiles.set([])
  $currentCwd.set('')
  $selectedStoredSessionId.set(null)
  vi.unstubAllGlobals()
})

it('卡片在没有 Git 和已有 Git 时均展示本轮的逐次差异，不提供 Git 写操作', async () => {
  for (const hasGit of [false, true]) {
    const list = vi.fn(async () => ({ files: [] }))
    const diff = vi.fn(async () => 'unrelated repository diff')
    const stage = vi.fn()
    const commit = vi.fn()
    vi.stubGlobal('hermesDesktop', hasGit ? { git: { review: { list, diff, stage, commit } } } : undefined)
    $currentCwd.set('/ordinary-office-folder')
    $selectedStoredSessionId.set('office-chat')
    const view = renderReview()
    const card = view.container.querySelector('[data-slot="aui_changed-files"]') as HTMLElement

    fireEvent.click(within(card).getByText('report.txt'))
    const pane = screen.getByRole('complementary', { name: 'Review' })
    expect(within(pane).getByText('old wording')).toBeTruthy()
    expect(within(pane).getByText('final wording')).toBeTruthy()
    expect(within(pane).getByText('1 / 2')).toBeTruthy()
    expect(within(pane).getByText('2 / 2')).toBeTruthy()
    expect($reviewFiles.get()).toMatchObject([
      { path: 'report.txt', added: 2, removed: 2 },
      { path: 'notes.txt', added: 1, removed: 0 }
    ])
    expect(within(pane).queryByRole('button', { name: TRANSLATIONS.en.statusStack.coding.stageAll })).toBeNull()
    expect(within(pane).queryByRole('button', { name: TRANSLATIONS.en.statusStack.coding.stage })).toBeNull()
    expect(within(pane).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(pane).getByText('notes.txt'))
    expect(await within(pane).findByText('second file content')).toBeTruthy()
    await act(async () => {
      await refreshReview()
      await stageReviewFile('report.txt')
      await commitChanges('must not commit a historical diff')
      requestRevert('report.txt')
    })
    expect(list).not.toHaveBeenCalled()
    expect(diff).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Review' }))
    expect($reviewSelectedPath.get()).toBe('report.txt')
    expect(within(pane).getByText('final wording')).toBeTruthy()
    view.unmount()
  }
})

it('迟到 Git 响应不能覆盖本轮差异，换会话清理后仍可正常打开 Git 审查', async () => {
  const pendingList = deferred<{ files: typeof $reviewFiles.value }>()
  const pendingDiff = deferred<string>()
  const gitFile = { path: 'report.txt', added: 1, removed: 1, status: 'M', staged: false }

  const list = vi
    .fn()
    .mockReturnValueOnce(pendingList.promise)
    .mockResolvedValue({ files: [gitFile] })

  const diff = vi.fn().mockReturnValueOnce(pendingDiff.promise).mockResolvedValue('current Git diff')

  vi.stubGlobal('hermesDesktop', {
    git: { review: { list, diff, shipInfo: vi.fn(async () => ({ ghReady: false, pr: null })) } }
  })
  $currentCwd.set('/repo')
  $selectedStoredSessionId.set('office-chat')
  openReview('/repo')

  const oldDiff = selectReviewFile(gitFile)
  const view = renderReview()
  const card = view.container.querySelector('[data-slot="aui_changed-files"]') as HTMLElement
  fireEvent.click(within(card).getByText('report.txt'))

  await act(async () => {
    pendingList.resolve({ files: [] })
    pendingDiff.resolve('stale Git diff')
    await oldDiff
  })
  expect($reviewFiles.get()).toMatchObject([
    { path: 'report.txt', added: 2, removed: 2 },
    { path: 'notes.txt', added: 1, removed: 0 }
  ])
  expect(screen.queryByText('stale Git diff')).toBeNull()
  expect(screen.getByText('final wording')).toBeTruthy()
  act(() => $selectedStoredSessionId.set('another-chat'))
  expect($reviewOpen.get()).toBe(false)
  expect($reviewFiles.get()).toEqual([])

  await act(async () => {
    revealReview('/repo')
    await refreshReview()
    await selectReviewFile(gitFile)
  })
  expect(list).toHaveBeenLastCalledWith('/repo', 'uncommitted', null)
  expect(diff).toHaveBeenLastCalledWith('/repo', 'report.txt', 'uncommitted', null, false)
  expect($reviewDiff.get()).toBe('current Git diff')
  view.unmount()
  expect($reviewOpen.get()).toBe(true)
})
