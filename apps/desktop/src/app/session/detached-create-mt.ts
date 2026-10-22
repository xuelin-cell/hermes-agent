/**
 * desktop-mt: 新对话发出后、会话还没建好时用户又开了新对话，建好的会话转到后台继续跑，
 * 不再把页面拽回去、也不清掉新对话的草稿。
 *
 * 上游 createBackendSessionForSend 在 session.create 返回后靠路由和选中会话判断用户是否切走；
 * 两个新对话的路由都是 '/'、选中都是 null，所以「新对话 → 新对话」被判为没切走，随后
 * navigate 到刚建好的会话。这里每开一次新对话把代次加一：发送时记下代次，会话建好时代次变了，
 * 就说明用户已经在另一个新对话里。
 */

let freshDraftEpoch = 0

/** startFreshSessionDraft 调用：又开了一个新对话。 */
export function bumpFreshDraftEpoch(): void {
  freshDraftEpoch += 1
}

export function currentFreshDraftEpoch(): number {
  return freshDraftEpoch
}

/** 新对话还没有会话时的提交锁按代次区分，后台还在建的第一个对话不挡住第二个新对话的发送。 */
export function pendingNewChatSubmitLockKey(): string {
  return `__pending_new__:${freshDraftEpoch}`
}

export interface DetachCreateInput {
  /** 发送时的代次。 */
  startEpoch: number
  /** session.create 返回的 stored id；没有就没法在侧栏里继续，不转后台。 */
  stored: null | string
  /** 新手引导等带标题、带种子消息的创建要留在前台。 */
  createdWithOverrides: boolean
  startConnection: string | undefined
  nowConnection: string | undefined
  startProfile: string
  nowProfile: string
  /** 正在切换连接。 */
  switching: boolean
}

/** 会话建好时是否转后台：普通发送、拿到了 stored id、发送后又开了新对话，并且后端和身份都没换。 */
export function shouldDetachCreate(input: DetachCreateInput): boolean {
  return (
    input.startEpoch !== freshDraftEpoch &&
    Boolean(input.stored) &&
    !input.createdWithOverrides &&
    !input.switching &&
    input.startConnection === input.nowConnection &&
    input.startProfile === input.nowProfile
  )
}

const MAX_DETACHED = 20
const detachedCreates = new Map<string, string>()

/** 转后台的创建：记下 runtime id → stored id，由发起发送的 submit 取走。 */
export function markDetachedCreate(runtimeId: string, storedSessionId: string): void {
  detachedCreates.set(runtimeId, storedSessionId)

  // 斜杠命令等调用方不取，留几条就够，避免一直增长。
  for (const key of detachedCreates.keys()) {
    if (detachedCreates.size <= MAX_DETACHED) {
      break
    }

    detachedCreates.delete(key)
  }
}

export function takeDetachedCreate(runtimeId: null | string | undefined): null | string {
  if (!runtimeId) {
    return null
  }

  const stored = detachedCreates.get(runtimeId) ?? null
  detachedCreates.delete(runtimeId)

  return stored
}

export function _resetDetachedCreateForTests(): void {
  freshDraftEpoch = 0
  detachedCreates.clear()
}
