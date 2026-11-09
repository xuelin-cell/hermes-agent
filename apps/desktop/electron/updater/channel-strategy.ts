import type { ChannelResolver, ChannelTarget } from './channel'
import type { ChannelBuild } from './channel-protocol'

import type { UpdaterApplyResultWire, UpdaterPrepareResult, UpdaterStatusWire, UpdaterStrategy } from './index'

export interface ChannelRetirementStatus {
  state: 'discontinued'
  destination: string
  version: string
  message?: string
}
export interface ChannelStrategyDeps {
  resolver: Pick<ChannelResolver, 'resolve'>
  build: ChannelBuild
  mechanism: 'electron-updater' | 'app-installer'
  nativeFactory: (target: ChannelTarget) => UpdaterStrategy
}
interface NativeSelection {
  kind: 'native'
  strategy: UpdaterStrategy
  available: boolean
}
interface RetirementSelection {
  kind: 'retirement'
  value: unknown
  state: ChannelRetirementStatus['state']
}
type Selection = NativeSelection | RetirementSelection | { kind: 'empty' }

/** One selection owns a check/apply operation; background checks cannot retarget it. */
export class ChannelStrategy implements UpdaterStrategy {
  readonly mechanism: ChannelStrategyDeps['mechanism']
  private selection: Selection | null = null
  private busy = false

  constructor(private readonly deps: ChannelStrategyDeps) {
    this.mechanism = deps.mechanism
  }

  private enter(): void {
    if (this.busy) {
      throw new Error('An update operation is already in progress.')
    }

    this.busy = true
  }

  async check(): Promise<UpdaterStatusWire> {
    this.enter()

    try {
      return await this.select()
    } finally {
      this.busy = false
    }
  }

  private async select(): Promise<UpdaterStatusWire> {
    // Failed reads invalidate prior availability, never leave a stale install action.
    this.selection = null
    const result = await this.deps.resolver.resolve()

    const base: UpdaterStatusWire = {
      supported: true,
      mechanism: this.mechanism,
      channel: this.deps.build.channel,
      currentVersion: this.deps.build.version,
      fetchedAt: Date.now()
    }

    if (result.kind === 'empty') {
      this.selection = { kind: 'empty' }

      return { ...base, updateAvailable: false, reason: 'no-build-published' }
    }

    if (result.kind === 'retirement') {
      // In-place retirement IS a same-identity update to the pinned stable
      // build: run it through the native factory (app-installer/electron-updater
      // available → download → apply), identical to a stable update. The
      // suffixed-identity tier never updates at all.
      if (result.retirement.receiverKind === 'in-place') {
        // Sequence counters are per-channel; a retired preview's sequence says
        // nothing about the pinned stable build. The native strategy's own
        // version comparison decides availability, exactly as for stable.
        return await this.selectNative(base, result.retirement.target, { crossChannel: true })
      }

      // Discontinued (suffixed identity): notice only. No migration callbacks,
      // no download — the user uninstalls; data stays on disk.
      this.selection = { kind: 'retirement', value: result.retirement, state: 'discontinued' }

      return {
        ...base,
        retirement: {
          state: 'discontinued',
          destination: result.retirement.target.channel.name,
          version: result.retirement.target.manifest.request.version
        }
      }
    }

    return await this.selectNative(base, result.target)
  }

  private async selectNative(
    base: UpdaterStatusWire,
    target: ChannelTarget,
    options: { crossChannel?: boolean } = {}
  ): Promise<UpdaterStatusWire> {
    if (!options.crossChannel && target.manifest.request.sequence <= this.deps.build.sequence) {
      this.selection = { kind: 'empty' }

      return { ...base, updateAvailable: false }
    }

    const strategy = this.deps.nativeFactory(target)
    const status = await strategy.check()

    if (status.error || status.updateAvailable === undefined) {
      throw new Error(status.error || 'Native update availability unknown')
    }

    this.selection = { kind: 'native', strategy, available: status.updateAvailable }

    return {
      ...status,
      ...base,
      latestTag: `v${target.manifest.request.version}`,
      targetSha: target.manifest.request.commit
    }
  }

  /**
   * Download the selected native build without installing it. Selection runs
   * exactly as check() does, so the prompt can only appear for a build the
   * channel has already accepted.
   */
  async prepare(): Promise<UpdaterPrepareResult> {
    this.enter()

    try {
      if (!this.selection) {
        await this.select()
      }

      const selected = this.selection

      if (selected?.kind !== 'native' || !selected.available) {
        return { ready: false, version: null }
      }

      const prepare = selected.strategy.prepare

      if (!prepare) {
        return { ready: false, version: null }
      }

      return await prepare.call(selected.strategy)
    } finally {
      this.busy = false
    }
  }

  async apply(): Promise<UpdaterApplyResultWire> {
    this.enter()

    try {
      if (!this.selection) {
        await this.select()
      }

      const selected = this.selection

      if (selected?.kind === 'retirement') {
        return { ok: false, error: 'This build is discontinued; uninstall it and install an official release.' }
      }

      if (selected?.kind === 'native' && selected.available) {
        return await selected.strategy.apply()
      }

      return { ok: true, mechanism: this.mechanism }
    } finally {
      this.busy = false
    }
  }

  /** Forward to the selected native build; false before a selection exists
   *  and once that build's transfer has already settled. */
  cancel(): boolean {
    const selected = this.selection

    if (selected?.kind !== 'native') {
      return false
    }

    return selected.strategy.cancel?.() ?? false
  }
}
