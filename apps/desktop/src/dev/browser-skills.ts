import { SKILLS_QUERY_KEY } from '@/app/capabilities/skills/skills-data'
import type { HermesApiRequest } from '@/global'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { dismissNotification, notify, notifyError } from '@/store/notifications'

import { readBrowserAuth } from '../../../shared/src/browser-maas-auth.js'

const MUTATIONS = new Set([
  'POST api/plugins/uniwork-kits/cloud/action',
  'POST api/skills/market/install', 'POST api/skills/hub/install',
  'POST api/skills/hub/uninstall', 'POST api/skills/hub/update', 'PUT api/skills/toggle'
])

export function isCloudSkillMutation(method: string, path: string): boolean {
  return MUTATIONS.has(`${method} ${path.split('?')[0].replace(/^\//, '')}`)
}

interface SkillStatus {
  id: string
  phase: 'changing' | 'saving' | 'saved' | 'confirmation' | 'save_failed' | 'unknown' | 'failed'
  result: unknown
  error: string
}

/** Keep the existing REST contract, but only resolve a mutation after Entry confirms persistence. */
export function browserSkills(base: string, kind: 'skills' | 'kits' = 'skills') {
  const pending = new Map<string, { id: string; promise?: Promise<unknown> }>()
  const login = () => readBrowserAuth(base)?.loginId

  const copy = () => kind === 'kits'
    ? (getRuntimeI18nLocale().startsWith('zh')
      ? { saving: '正在保存套件变更…', retry: '重试保存', saved: '套件变更已保存，新会话生效。', uncertain: '套件操作结果未确认，请先刷新检查，不要重复安装。' }
      : { saving: 'Saving kit changes…', retry: 'Retry saving', saved: 'Kit changes saved. Available in new sessions.', uncertain: 'Kit operation could not be confirmed. Refresh and check before trying again.' })
    : getRuntimeI18nLocale().startsWith('zh')
    ? { saving: '正在保存技能变更…', retry: '重试保存', saved: '技能变更已保存，新会话生效。', uncertain: '技能操作结果未确认，请先刷新检查，不要重复安装。' }
    : { saving: 'Saving skill changes…', retry: 'Retry saving', saved: 'Skill changes saved. Available in new sessions.', uncertain: 'Skill operation could not be confirmed. Refresh and check before trying again.' }

  async function call(operation: string, body: object, owner: string | undefined): Promise<SkillStatus> {
    const response = await fetch(`${base.replace(/\/$/, '')}/__entry/skills/${operation}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    })

    if (login() !== owner) {throw new Error(copy().uncertain)}

    if (!response.ok) {throw new Error(copy().uncertain)}

    return response.json()
  }

  async function wait(id: string, owner: string | undefined, key: string, retry = false): Promise<unknown> {
    const notice = `cloud-skill-${id}`
    const deadline = Date.now() + 25 * 60_000
    let keepWarning = false

    try {
      if (retry) {await call('retry-save', { id }, owner)}

      for (;;) {
        const status = await call('status', { id }, owner)

        if (status.phase === 'saved' || status.phase === 'confirmation' || status.phase === 'failed') {
          pending.delete(key)
          if (status.phase === 'failed') {throw new Error(status.error || copy().uncertain)}
          if (status.phase === 'saved') {invalidateSlashCompletions()}

          return status.result
        }

        if (status.phase === 'save_failed') {
          keepWarning = true
          notify({ id: notice, kind: 'warning', message: status.error, durationMs: 0,
            action: { label: copy().retry, onClick: () => {
              void wait(id, owner, key, true).then(() => {
                void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
                void queryClient.invalidateQueries({ queryKey: ['skill-hub-sources'] })
                invalidateSlashCompletions()
                notify({ kind: 'success', message: copy().saved })
              }).catch(error => notifyError(error, copy().uncertain))
            } }
          })
          throw new Error(status.error)
        }

        if (status.phase === 'unknown' || Date.now() > deadline) {throw new Error(copy().uncertain)}

        if (status.phase === 'saving') {
          notify({ id: notice, kind: 'info', message: copy().saving, durationMs: 0 })
        }

        await new Promise(resolve => setTimeout(resolve, 700))
      }
    } finally {
      // An unsaved-change warning must retain its explicit retry action.
      if (!keepWarning) {dismissNotification(notice)}
    }
  }

  return {
    async mutate<T>(request: HermesApiRequest): Promise<T> {
      const method = request.method || 'GET'

      if (!isCloudSkillMutation(method, request.path) || (request.connectionId && request.connectionId !== 'local') ||
          (request.profile && request.profile !== 'default')) {
        throw new Error(copy().uncertain)
      }

      const owner = login()
      const path = request.path.split('?')[0].replace(/^\//, '')
      const params = new URLSearchParams(request.path.split('?')[1])

      if ([...params].some(([name, value]) => name !== 'profile' || value !== 'default')) {
        throw new Error(copy().uncertain)
      }

      const key = JSON.stringify([owner, method, path, request.body])
      const existing = pending.get(key)

      if (existing) {
        if (existing.promise) {return existing.promise as Promise<T>}
        throw new Error(copy().uncertain)
      }

      const record = { id: crypto.randomUUID(), promise: undefined as Promise<unknown> | undefined }
      pending.set(key, record)
      record.promise = (async () => {
        await call('start', { id: record.id, method, path, body: request.body || {}, profile: 'default' }, owner)

        return wait(record.id, owner, key)
      })()

      try {return await record.promise as T}
      finally {record.promise = undefined}
    }
  }
}
