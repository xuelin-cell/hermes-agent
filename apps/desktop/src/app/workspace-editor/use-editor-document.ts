import { useEffect, useRef, useState } from 'react'

import { desktopFsCacheKey, readDesktopFileText, writeDesktopFileText } from '@/lib/desktop-fs'
import { notifyWorkspaceChanged } from '@/store/workspace-events'

interface EditorDocument {
  path: string
  base: string
  content: string
}

// Pending buffers survive page navigation, isolated by connection/profile/project.
const drafts = new Map<string, Map<string, EditorDocument>>()

export function useEditorDocument(scope: string, unsupported: string, conflictMessage: string) {
  const [file, setFile] = useState<EditorDocument | null>(() => [...(drafts.get(scope)?.values() ?? [])].at(-1) ?? null)
  const current = useRef(file)
  const [dirty, setDirty] = useState(!!file && file.content !== file.base)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const request = useRef(0)
  const mounted = useRef({ active: true })
  const savingRef = useRef(false)
  const connection = desktopFsCacheKey()

  useEffect(() => {
    const lifetime = mounted.current
    lifetime.active = true

    return () => {
      lifetime.active = false
    }
  }, [])

  const open = async (path: string, reload = false) => {
    if (savingRef.current) {
      return
    }

    const id = ++request.current
    setError(null)
    setConflict(false)
    setLoading(true)

    try {
      const draft = !reload && drafts.get(scope)?.get(path)
      const result = draft ? null : await readDesktopFileText(path)

      if (!mounted.current.active || id !== request.current) {
        return
      }

      if (result && (result.binary || result.truncated || (result.byteSize ?? 0) > 2 * 1024 * 1024)) {
        throw new Error(unsupported)
      }

      if (reload) {
        drafts.get(scope)?.delete(path)
      }

      const next = draft || { path, content: result!.text, base: result!.text }
      current.current = next
      setFile(next)
      setDirty(next.content !== next.base)
      setVersion(value => value + 1)
    } catch (cause) {
      if (mounted.current.active && id === request.current) {
        setError(String(cause instanceof Error ? cause.message : cause))
      }
    } finally {
      if (mounted.current.active && id === request.current) {
        setLoading(false)
      }
    }
  }

  const change = (content: string) => {
    const previous = current.current

    if (!previous) {
      return
    }

    const next = { ...previous, content }
    const buffers = drafts.get(scope) ?? new Map<string, EditorDocument>()

    if (content !== next.base) {
      buffers.set(next.path, next)
    } else {
      buffers.delete(next.path)
    }

    if (buffers.size) {
      drafts.set(scope, buffers)
    } else {
      drafts.delete(scope)
    }

    current.current = next
    setDirty(content !== next.base)
  }

  const save = async () => {
    const snapshot = current.current

    if (!snapshot || loading || savingRef.current || snapshot.content === snapshot.base) {
      return
    }

    savingRef.current = true
    setSaving(true)
    setError(null)

    try {
      const disk = await readDesktopFileText(snapshot.path)

      if (!mounted.current.active || desktopFsCacheKey() !== connection) {
        return
      }

      if (disk.binary || disk.truncated || disk.text !== snapshot.base) {
        setConflict(true)
        throw new Error(conflictMessage)
      }

      await writeDesktopFileText(snapshot.path, snapshot.content)
      drafts.get(scope)?.delete(snapshot.path)
      notifyWorkspaceChanged(snapshot.path)

      if (mounted.current.active) {
        const next = { ...snapshot, base: snapshot.content }
        current.current = next
        setFile(next)
        setDirty(false)
        setConflict(false)
      }
    } catch (cause) {
      if (mounted.current.active) {
        setError(String(cause instanceof Error ? cause.message : cause))
      }
    } finally {
      savingRef.current = false

      if (mounted.current.active) {
        setSaving(false)
      }
    }
  }

  return {
    file,
    draft: current.current?.content ?? '',
    dirty,
    version,
    loading,
    saving,
    error,
    conflict,
    open,
    change,
    save
  }
}
