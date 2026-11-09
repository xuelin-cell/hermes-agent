/** Bounded, ephemeral correlation; prompts and transcripts are never retained here. */
export interface TelemetryInput {
  id: string
  profile: string
  sessionId: string
  requestHash: string
  requestKind: 'user' | 'resume' | 'hidden'
  resumeFrom?: string
  userInput?: string
}

export class TelemetryInputs {
  private entries = new Map<string, { id: string; home: string; session: string; hash: string; input?: string; expires: number; turn?: string;
    kind: TelemetryInput['requestKind']; resumeFrom?: string; recordedAt: number }>()

  remember(home: string, value: TelemetryInput): void {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(value.id) || !/^[0-9a-f]{64}$/.test(value.requestHash) ||
        !['user', 'resume', 'hidden'].includes(value.requestKind) ||
        (value.resumeFrom !== undefined && !/^[0-9a-f]{64}$/.test(value.resumeFrom)) ||
        (value.userInput !== undefined && typeof value.userInput !== 'string') ||
        typeof value.sessionId !== 'string' || !value.sessionId) {return}

    this.prune()

    if (this.entries.has(value.id)) {return}

    const input = value.requestKind !== 'user' || value.userInput === undefined ? undefined : Array.from(value.userInput)
      .filter(c => /[\n\r\t]/.test(c) || !/[\p{Cc}\p{Cs}]/u.test(c)).slice(0, 2000).join('')

    const recordedAt = Date.now()
    this.entries.set(value.id, { id: value.id, home, session: value.sessionId, hash: value.requestHash, input, recordedAt,
      kind: value.requestKind, resumeFrom: value.requestKind === 'resume' ? value.resumeFrom : undefined,
      expires: recordedAt + 30 * 60_000 })

    while (this.entries.size > 1000) {this.entries.delete(this.entries.keys().next().value!)}
  }

  find(home: string, hash: string, turn: string, sessions: string[]): {
    submissionId?: string; userInput?: string; requestKind?: TelemetryInput['requestKind']; resumeFrom?: string; recordedAt?: number
  } {
    this.prune()

    const matches = [...this.entries.values()].filter(e => e.home === home && sessions.includes(e.session) &&
      e.hash === hash && (!e.turn || e.turn === turn))

    // Concurrent identical submissions must not be matched by "latest" or consumed from a guessed FIFO.
    if (matches.length !== 1 || !turn) {return {}}
    matches[0].turn = turn

    return { submissionId: matches[0].id, requestKind: matches[0].kind, recordedAt: matches[0].recordedAt,
      ...(matches[0].resumeFrom ? { resumeFrom: matches[0].resumeFrom } : {}),
      ...(matches[0].input === undefined ? {} : { userInput: matches[0].input }) }
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expires < Date.now()) {this.entries.delete(key)}
    }
  }
}
