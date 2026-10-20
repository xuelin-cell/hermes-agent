import { type PluginRestOptions } from '@hermes/plugin-sdk'

import { normalizeRow } from './partition'
import type { BundledStatus, Catalog, ExpertDirectory, JobView } from './types'

type Rest = <T>(path: string, opts?: PluginRestOptions) => Promise<T>

let rest: null | Rest = null
/** 用系统浏览器打开授权页；插件注册时由 bindOpener 换成宿主提供的实现，之前一律返回 false。 */
let openExternal: (url: string) => Promise<boolean> = async () => false

/** 插件注册时记下宿主给的 REST 调用入口。 */
export function bindApi(next: Rest): void {
  rest = next
}

/** 插件注册时记下宿主打开外部链接的方法。 */
export function bindOpener(next: (url: string) => Promise<boolean>): void {
  openExternal = next
}

/** 在系统浏览器里打开 MCP 的授权页。 */
export function openAuthorization(url: string): Promise<boolean> {
  return openExternal(url)
}

/** 调用本插件的后端接口；还没接上后端时直接报错。 */
function api<T>(path: string, opts?: PluginRestOptions): Promise<T> {
  if (!rest) {
    return Promise.reject(new Error('套件页还没有接上后端'))
  }

  return rest<T>(path, opts)
}

/** 取套件页的全部卡片，并把旧版后端缺的字段补齐。 */
export function fetchCatalog(): Promise<Catalog> {
  return api<Catalog>('/').then(catalog => ({ plugins: (catalog?.plugins ?? []).map(normalizeRow) }))
}

/** 取内置套件和专家的安装进度。 */
export function fetchBundled(): Promise<BundledStatus> {
  return api<BundledStatus>('/bundled')
}

/** 取召唤名单：全部已装专家和最近召唤的几位。 */
export function fetchExperts(): Promise<ExpertDirectory> {
  return api<ExpertDirectory>('/experts')
}

/** 取一位专家的头像（data URL）。 */
export function fetchExpertAvatar(name: string): Promise<{ data_url: string }> {
  return api(`/experts/${encodeURIComponent(name)}/avatar`)
}

/** 记一次召唤，返回新的「最近召唤」名单。 */
export function recordSummon(name: string): Promise<{ recent: string[] }> {
  return api('/experts/recent', { body: { name }, method: 'POST' })
}

/** 取后台安装或刷新任务的状态和日志尾巴。 */
export function fetchJob(id: string): Promise<JobView> {
  return api<JobView>(`/jobs/${id}`)
}

/** 取一个包最近一次安装记录的全文。 */
export function fetchReceipt(name: string): Promise<{ name: string; text: string }> {
  return api(`/receipts/${encodeURIComponent(name)}`)
}

/** 启用或停用一个套件。 */
export function toggleKit(name: string, enabled: boolean): Promise<unknown> {
  return api('/toggle', { body: { enabled, name }, method: 'POST' })
}

/** 卸载一个包；专家要明确传 deleteProfile 才会连档案一起删。 */
export function uninstallKit(name: string, deleteProfile: boolean): Promise<unknown> {
  return api('/uninstall', { body: { delete_profile: deleteProfile, name }, method: 'POST' })
}

/** 把用户填的配置项写进对应档案的 .env。 */
export function writeConfig(name: string, values: Record<string, string>): Promise<{ written: string[] }> {
  return api('/config', { body: { name, values }, method: 'POST' })
}

/** 在后台补齐一个套件的触发词，返回任务号。 */
export function refreshTriggers(name: string): Promise<{ job: { id: string } }> {
  return api('/triggers', { body: { name, regenerate: false }, method: 'POST' })
}

/** 上传 zip 并在后台安装，返回任务号。 */
export function installZip(file: { bytes: ArrayBuffer; filename: string }): Promise<{ job: { id: string } }> {
  return api('/install', {
    method: 'POST',
    timeoutMs: 60_000,
    upload: { bytes: file.bytes, contentType: 'application/zip', filename: file.filename }
  })
}
