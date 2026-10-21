import { useEffect, useRef, useState } from 'react'

import { type McpServers, serverEnabled } from '@/lib/mcp-servers'

import { withEnabled } from '../mcp/mcp-doc'
import type { McpServersController } from '../mcp/use-mcp-servers'

import {
  entryFromForm,
  formChanged,
  type FormError,
  type FormTransport,
  needsReload,
  placeServer,
  type ServerForm,
  validateForm
} from './server-form-model'

/** 与 UniWork 一致：停止输入半秒后保存。 */
export const SAVE_DELAY_MS = 500

export interface NewServerRow {
  id: string
  transport: FormTransport
}

export interface ServerEdits {
  /** 正在“先测试再启用”的服务名。 */
  checking: ReadonlySet<string>
  /** 每行最近一次表单校验结果（按行 id）。 */
  errors: Readonly<Record<string, FormError | null>>
  /** 开启时测试失败的原因（按服务名）；开关保持关闭。 */
  failures: Readonly<Record<string, string>>
  /** 尚未保存的新建行。 */
  newRows: readonly NewServerRow[]
  addRow: (transport: FormTransport) => string
  dismissFailure: (name: string) => void
  dropRow: (id: string) => void
  edit: (id: string, form: ServerForm) => void
  forget: (name: string) => void
  rowId: (name: string) => string
  toggle: (name: string, on: boolean) => Promise<void>
}

/** 连接器页的编辑行为：表单自动保存、改动即停用、开启前先测试。所有写入串行执行。 */
export function useServerEdits(controller: McpServersController): ServerEdits {
  const latest = useRef(controller)
  latest.current = controller

  const idByName = useRef(new Map<string, string>())
  const nameById = useRef(new Map<string, string>())
  const pending = useRef(new Map<string, { form: ServerForm; timer: ReturnType<typeof setTimeout> }>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const nextId = useRef(0)

  const [newRows, setNewRows] = useState<NewServerRow[]>([])
  const [errors, setErrors] = useState<Record<string, FormError | null>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set())

  /** 按顺序执行写入，后一次总能看到前一次保存的结果。 */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task, task)
    queue.current = run.catch(() => undefined)

    return run
  }

  /** 行 id 跟随改名不变，展开状态和输入中的表单因此不会丢。 */
  const rowId = (name: string): string => {
    let id = idByName.current.get(name)

    if (!id) {
      // 计数编号而非名称：改名后再新建同名服务也不会撞上旧 id。
      id = `server:${nextId.current++}`
      idByName.current.set(name, id)
      nameById.current.set(id, name)
    }

    return id
  }

  /** 记录保存后的名称归属。 */
  const bind = (id: string, name: string) => {
    const previous = nameById.current.get(id)

    if (previous !== undefined) {
      idByName.current.delete(previous)
    }

    idByName.current.set(name, id)
    nameById.current.set(id, name)
  }

  /** 删除服务后清掉它的行记录。 */
  const forget = (name: string) => {
    const id = idByName.current.get(name)

    if (id) {
      clearPending(id)
      nameById.current.delete(id)
    }

    idByName.current.delete(name)
  }

  /** 已占用的名称（不含本行自己）。 */
  const takenNames = (id: string): string[] => {
    const own = nameById.current.get(id)

    return Object.keys(latest.current.servers).filter(name => name !== own)
  }

  const setError = (id: string, error: FormError | null) =>
    setErrors(current => (current[id] === error ? current : { ...current, [id]: error }))

  /** 取消某行尚未执行的自动保存。 */
  function clearPending(id: string) {
    const entry = pending.current.get(id)

    if (entry) {
      clearTimeout(entry.timer)
      pending.current.delete(id)
    }
  }

  /** 把表单写入配置；保存的条目一律处于关闭状态，需要重新开启验证。 */
  const save = (id: string, form: ServerForm): Promise<boolean> =>
    serial(async () => {
      const error = validateForm(form, takenNames(id))
      setError(id, error)

      if (error) {
        return false
      }

      const from = nameById.current.get(id) ?? null
      const to = form.name.trim()

      const saved = await latest.current.replaceServers(
        (current: McpServers) =>
          placeServer(current, from, to, withEnabled(entryFromForm(form, from ? (current[from] ?? {}) : {}), false)),
        needsReload
      )

      if (saved) {
        bind(id, to)
        setNewRows(rows => rows.filter(row => row.id !== id))
      }

      return saved
    })

  /** 立即保存某行待保存的修改（开关前、离开页面时）。 */
  const flush = async (id: string) => {
    const entry = pending.current.get(id)

    if (entry) {
      clearPending(id)
      await save(id, entry.form)
    }
  }

  /** 关闭一个服务，表单其他内容不变。 */
  const turnOff = (name: string) =>
    serial(() =>
      latest.current.replaceServers(current =>
        current[name] ? { ...current, [name]: withEnabled(current[name], false) } : current
      )
    )

  const edit = (id: string, form: ServerForm) => {
    clearPending(id)
    const name = nameById.current.get(id)
    const entry = name ? latest.current.servers[name] : undefined

    // 与 UniWork 一致：改了已启用服务的配置，先把它关掉，再保存新内容。
    if (name && entry && serverEnabled(entry) && formChanged(form, name, entry)) {
      void turnOff(name)
    }

    if (name) {
      setFailures(({ [name]: _dropped, ...rest }) => rest)
    }

    const error = validateForm(form, takenNames(id))
    setError(id, error)

    if (error) {
      return
    }

    pending.current.set(id, { form, timer: setTimeout(() => void flush(id), SAVE_DELAY_MS) })
  }

  const toggle = async (name: string, on: boolean) => {
    const id = rowId(name)

    if (!on) {
      clearPending(id)
      await turnOff(name)

      return
    }

    await flush(id)

    if (errors[id] || checking.has(name) || !latest.current.servers[name]) {
      return
    }

    setFailures(({ [name]: _dropped, ...rest }) => rest)
    setChecking(current => new Set(current).add(name))

    try {
      // 测试读取的是已保存的配置，所以开启前要先把待保存的修改写进去。
      const result = await latest.current.runProbe(name)

      if (result?.ok) {
        await serial(() =>
          latest.current.replaceServers(current =>
            current[name] ? { ...current, [name]: withEnabled(current[name], true) } : current
          )
        )
      } else if (result) {
        setFailures(current => ({ ...current, [name]: result.error ?? '' }))
      }
    } finally {
      setChecking(current => {
        const next = new Set(current)
        next.delete(name)

        return next
      })
    }
  }

  const addRow = (transport: FormTransport): string => {
    const id = `new:${nextId.current++}`
    setNewRows(rows => [...rows, { id, transport }])

    return id
  }

  const dropRow = (id: string) => {
    clearPending(id)
    setNewRows(rows => rows.filter(row => row.id !== id))
  }

  // 离开页面时不丢掉还没到保存时间的修改。
  useEffect(
    () => () => {
      for (const [id, { form, timer }] of pending.current) {
        clearTimeout(timer)
        void save(id, form)
      }

      pending.current.clear()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return {
    addRow,
    checking,
    dismissFailure: name => setFailures(({ [name]: _dropped, ...rest }) => rest),
    dropRow,
    edit,
    errors,
    failures,
    forget,
    newRows,
    rowId,
    toggle
  }
}
