import { type PluginRestOptions } from '@hermes/plugin-sdk'

import type { Catalog, ExpertDirectory, JobView } from './types'

type Rest = <T>(path: string, opts?: PluginRestOptions) => Promise<T>

let rest: null | Rest = null
let openExternal: (url: string) => Promise<boolean> = async () => false

export function bindApi(next: Rest): void {
  rest = next
}

export function bindOpener(next: (url: string) => Promise<boolean>): void {
  openExternal = next
}

export function openAuthorization(url: string): Promise<boolean> {
  return openExternal(url)
}

function api<T>(path: string, opts?: PluginRestOptions): Promise<T> {
  if (!rest) {
    return Promise.reject(new Error('套件页还没有接上后端'))
  }

  return rest<T>(path, opts)
}

export function fetchCatalog(): Promise<Catalog> {
  return api<Catalog>('/')
}

export function fetchExperts(): Promise<ExpertDirectory> {
  return api<ExpertDirectory>('/experts')
}

export function fetchExpertAvatar(name: string): Promise<{ data_url: string }> {
  return api(`/experts/${encodeURIComponent(name)}/avatar`)
}

export function recordSummon(name: string): Promise<{ recent: string[] }> {
  return api('/experts/recent', { body: { name }, method: 'POST' })
}

export function fetchJob(id: string): Promise<JobView> {
  return api<JobView>(`/jobs/${id}`)
}

export function fetchReceipt(name: string): Promise<{ name: string; text: string }> {
  return api(`/receipts/${encodeURIComponent(name)}`)
}

export function toggleKit(name: string, enabled: boolean): Promise<unknown> {
  return api('/toggle', { body: { enabled, name }, method: 'POST' })
}

export function uninstallKit(name: string, deleteProfile: boolean): Promise<unknown> {
  return api('/uninstall', { body: { delete_profile: deleteProfile, name }, method: 'POST' })
}

export function writeConfig(name: string, values: Record<string, string>): Promise<{ written: string[] }> {
  return api('/config', { body: { name, values }, method: 'POST' })
}

export function refreshTriggers(name: string): Promise<{ job: { id: string } }> {
  return api('/triggers', { body: { name, regenerate: false }, method: 'POST' })
}

export function installZip(file: { bytes: ArrayBuffer; filename: string }): Promise<{ job: { id: string } }> {
  return api('/install', {
    method: 'POST',
    timeoutMs: 60_000,
    upload: { bytes: file.bytes, contentType: 'application/zip', filename: file.filename }
  })
}
