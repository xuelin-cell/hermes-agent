export interface BrowserMaasAuth {
  token: string
  expiresAt: number
  loginId: string
}
export function browserAuthKey(basePath: string): string
export function readBrowserAuth(basePath: string): BrowserMaasAuth | null
export function clearBrowserAuth(basePath: string, loginId?: string): void
export function storeBrowserLogin(basePath: string, response: { maas_auth?: BrowserMaasAuth }): void
export function requestEntryMaas<T>(basePath: string, path: string, options?: RequestInit): Promise<T>
