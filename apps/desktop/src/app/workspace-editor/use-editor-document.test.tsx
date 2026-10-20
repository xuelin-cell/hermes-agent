import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { useEditorDocument } from './use-editor-document'

let directory: string
const unsupported = 'unsupported'
const conflictMessage = 'changed on disk'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hermes-editor-'))
  $connection.set(null)
  vi.stubGlobal('hermesDesktop', {
    readFileText: async (path: string) => ({ path, text: await readFile(path, 'utf8') }),
    writeTextFile: async (path: string, content: string) => {
      await writeFile(path, content)

      return { path }
    }
  })
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

it('saves real files and preserves pending buffers across files, page navigation, and project scopes', async () => {
  const first = join(directory, 'one.ts')
  const second = join(directory, 'two.ts')
  await writeFile(first, 'const one = 1')
  await writeFile(second, 'const two = 2')
  const scope = `${directory}:project-a`
  let editor = renderHook(() => useEditorDocument(scope, unsupported, conflictMessage))
  await act(async () => {
    await editor.result.current.open(first)
  })
  act(() => editor.result.current.change('const one = 10'))
  await act(async () => {
    await editor.result.current.open(second)
  })
  await act(async () => {
    await editor.result.current.open(first)
  })
  expect(editor.result.current.draft).toBe('const one = 10')
  expect(await readFile(first, 'utf8')).toBe('const one = 1')
  editor.unmount()
  const other = renderHook(() => useEditorDocument(`${directory}:project-b`, unsupported, conflictMessage))
  expect(other.result.current.file).toBeNull()
  other.unmount()
  editor = renderHook(() => useEditorDocument(scope, unsupported, conflictMessage))
  expect(editor.result.current.draft).toBe('const one = 10')
  await act(async () => {
    await editor.result.current.save()
  })
  expect(await readFile(first, 'utf8')).toBe('const one = 10')
  expect(editor.result.current.dirty).toBe(false)
})

it('keeps external edits on disk and retains the draft until the user explicitly reloads', async () => {
  const path = join(directory, 'concurrent.ts')
  await writeFile(path, 'original')
  const { result } = renderHook(() => useEditorDocument(directory, unsupported, conflictMessage))
  await act(async () => {
    await result.current.open(path)
  })
  act(() => result.current.change('user draft'))
  await writeFile(path, 'agent edit')
  await act(async () => {
    await result.current.save()
  })
  expect(await readFile(path, 'utf8')).toBe('agent edit')
  expect(result.current.conflict).toBe(true)
  expect(result.current.draft).toBe('user draft')
  await act(async () => {
    await result.current.open(path, true)
  })
  expect(result.current.draft).toBe('agent edit')
  expect(result.current.dirty).toBe(false)
  expect(result.current.conflict).toBe(false)
})
