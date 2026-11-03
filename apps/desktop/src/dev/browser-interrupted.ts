import type { HermesApiRequest } from '@/global'
import { readBrowserAuth } from '../../../shared/src/browser-maas-auth.js'

export function browserInterrupted(base: string, api: <T>(input: HermesApiRequest) => Promise<T>) {
  const owner = () => readBrowserAuth(base)?.loginId ?? null
  let account = owner()
  const owners = new Map<string, string>()
  return { interruptedTurns: {
    async list() {
      const login = owner()
      const { turns } = await api<{ turns: { sessionId: string; prompt: string; detectedAt: number; profile: string }[] }>({
        path: '/api/plugins/uniwork-kits/cloud/interrupted', profile: 'default'
      })
      if (login !== owner()) return []
      account = login
      owners.clear()
      for (const turn of turns) owners.set(turn.sessionId, turn.profile)
      return turns
    },
    async dismiss(sessionId: string) {
      const profile = owners.get(sessionId)
      if (!profile || account !== owner()) { owners.clear(); return }
      await api({ path: '/api/plugins/uniwork-kits/cloud/interrupted/dismiss', profile: 'default',
        method: 'POST', body: { profile, sessionId } })
      owners.delete(sessionId)
    }
  } }
}
