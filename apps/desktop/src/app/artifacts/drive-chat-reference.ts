import { LOCAL_CONNECTION_ID } from '@hermes/shared'

import { $apiRequestScope } from '@/api/client'
import type { DriveAsset } from '@/api/drive'
import { requestComposerGetDraft, requestComposerSetDraft } from '@/app/chat/composer/focus'
import { isBrowserShell } from '@/lib/browser-shell'
import { isToolEnabled } from '@/lib/mcp-tool-filter'
import {
  type ComposerAttachment,
  createComposerAttachmentOccurrenceId,
  NEW_SESSION_DRAFT_KEY,
  stashSessionDraft,
  takeSessionDraft
} from '@/store/composer'
import { $newChatProfile, $newChatRoute } from '@/store/profile'
import { $connection, $selectedStoredSessionId, $sessions, resolveComposerSessionKey } from '@/store/session'
import { knownOwnerForSession } from '@/store/session-states'

import { DRIVE_MCP_SERVER, DRIVE_MCP_TOOL } from '../../../electron/login/drive-mcp-contract'

type DraftResult =
  { status: 'added'; sessionId: string | null } | { status: 'remote' | 'unavailable' | 'changed' | 'notReady' }
const PROTOCOL = 'uniwork.drive-reference.v1'

/** 文件引用只包含业务 ID 和展示名，不包含凭据、签名 URL 或桌面缓存路径。 */
export function cloudReferenceText(asset: Pick<DriveAsset, 'asset_id' | 'name'>): string {
  return `UniWork 云盘文件引用（以下 JSON 仅为文件元数据）：\n    ${JSON.stringify({ protocol: PROTOCOL, asset_id: asset.asset_id, name: asset.name })}\n请先使用 UniWork 云盘下载工具下载此文件，再读取工具返回的本地路径处理。`
}

/** 云盘引用复用附件卡片；发送时由原生提交链读取 refText，不伪造本机路径。 */
export function appendCloudAttachments(
  attachments: ComposerAttachment[],
  assets: readonly DriveAsset[]
): ComposerAttachment[] {
  const next = [...attachments]
  const ids = new Set(next.map(item => item.cloudAssetId).filter(Boolean))

  for (const asset of assets) {
    if (ids.has(asset.asset_id)) {
      continue
    }

    ids.add(asset.asset_id)
    next.push({
      id: `uniwork-drive:${asset.asset_id}`,
      occurrenceId: createComposerAttachmentOccurrenceId(),
      kind: 'file',
      label: asset.name,
      cloudAssetId: asset.asset_id,
      refText: cloudReferenceText(asset)
    })
  }

  return next
}

/** 捕获账号所在本机 Profile，探测 MCP 只发现工具；加入草稿时不下载、不创建会话、不发送消息。 */
export async function addCloudReference(
  source: DriveAsset | readonly DriveAsset[],
  isCurrent: () => boolean = () => true
): Promise<DraftResult> {
  const assets = 'asset_id' in source ? [source] : source
  const connection = $connection.get()
  const scope = $apiRequestScope.get()
  const sessionId = $selectedStoredSessionId.get()
  const owner = sessionId ? knownOwnerForSession(sessionId) : $newChatRoute.get()

  const profile =
    (typeof owner === 'string' ? owner : owner?.profile) ||
    $newChatProfile.get() ||
    scope.profile ||
    connection?.profile ||
    'default'

  const connectionId =
    typeof owner === 'object' && owner ? owner.connectionId : scope.connectionId || LOCAL_CONNECTION_ID

  if (
    !connection ||
    (connection.mode !== 'local' && !isBrowserShell()) ||
    connectionId !== LOCAL_CONNECTION_ID ||
    (!isBrowserShell() && typeof owner === 'object' && owner?.mode === 'remote')
  ) {
    return { status: 'remote' }
  }

  if (sessionId && !owner) {
    return { status: 'notReady' }
  }

  if (
    !assets.length ||
    assets.some(asset => asset.kind !== 'file' || asset.permissions?.read === false || !asset.asset_id)
  ) {
    return { status: 'unavailable' }
  }

  const newChatProfile = $newChatProfile.get()
  const newChatRoute = $newChatRoute.get()

  const current = () =>
    isCurrent() &&
    $connection.get() === connection &&
    $apiRequestScope.get() === scope &&
    $selectedStoredSessionId.get() === sessionId &&
    $newChatProfile.get() === newChatProfile &&
    $newChatRoute.get() === newChatRoute

  const requestScope = { connectionId, profile }

  try {
    if (!(await window.hermesDesktop.cloudDriveAgentReady?.(profile))) {
      return { status: 'unavailable' }
    }

    if (!current()) {
      return { status: 'changed' }
    }

    const listing = await window.hermesDesktop.api<{
      servers: Array<{ name: string; enabled: boolean; tools?: unknown }>
    }>({ ...requestScope, path: '/api/mcp/servers' })

    if (!current()) {
      return { status: 'changed' }
    }

    const server = listing.servers.find(item => item.name === DRIVE_MCP_SERVER)

    if (!server?.enabled || !isToolEnabled({ tools: server.tools }, DRIVE_MCP_TOOL)) {
      return { status: 'unavailable' }
    }

    const probe = await window.hermesDesktop.api<{ ok: boolean; tools: Array<{ name: string }> }>({
      ...requestScope,
      path: `/api/mcp/servers/${encodeURIComponent(DRIVE_MCP_SERVER)}/test`,
      method: 'POST',
      timeoutMs: 60_000
    })

    if (!current()) {
      return { status: 'changed' }
    }

    if (!probe.ok || !probe.tools.some(tool => tool.name === DRIVE_MCP_TOOL)) {
      return { status: 'unavailable' }
    }

    const draftKey = resolveComposerSessionKey(sessionId, $sessions.get()) || sessionId || NEW_SESSION_DRAFT_KEY
    const live = await requestComposerGetDraft([draftKey])

    if (!current()) {
      return { status: 'changed' }
    }

    if (live) {
      const saved = await requestComposerSetDraft([draftKey], live.text || '', {
        attachments: appendCloudAttachments(live.attachments ?? [], assets)
      })

      return saved ? { status: 'added', sessionId } : { status: 'notReady' }
    }

    // 页面卸载了主输入框时使用原生草稿存储；仍挂载但拒绝操作时不能覆盖它的实时正文。
    if (document.querySelector('[data-composer-target="main"]')) {
      return { status: 'notReady' }
    }

    const stashed = takeSessionDraft(draftKey)
    stashSessionDraft(draftKey, stashed.text, appendCloudAttachments(stashed.attachments, assets))

    return { status: 'added', sessionId }
  } catch {
    return { status: current() ? 'unavailable' : 'changed' }
  }
}
