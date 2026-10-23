import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import type { InstallStamp } from './install-stamp'
import { packagedResourceRoot } from './universal-resources'

// 架构是纯路径选择输入；验证每种载荷独立且错误目标不降级到别的架构。
test('selects matching sealed universal resources and preserves single-arch layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-resources-'))
  const stamp = { commit: 'a'.repeat(40) } as InstallStamp

  try {
    expect(packagedResourceRoot(root, 'agent-payload', stamp)).toBe(path.join(root, 'agent-payload'))
    fs.writeFileSync(path.join(root, 'universal-layout.json'), JSON.stringify({ schema: 1, commit: stamp.commit }))

    for (const arch of ['x64', 'arm64']) {
      for (const name of ['agent-payload', 'open-connector'] as const) {
        const expected = path.join(root, name, `darwin-${arch}`)
        fs.mkdirSync(expected, { recursive: true })
        expect(packagedResourceRoot(root, name, stamp, arch, { commit: stamp.commit!, arch })).toBe(expected)
      }
    }

    expect(() => packagedResourceRoot(root, 'agent-payload', stamp, 'ia32', { commit: stamp.commit!, arch: 'ia32' })).toThrow()
    expect(() => packagedResourceRoot(root, 'agent-payload', { ...stamp, commit: 'different' }, 'arm64', { commit: stamp.commit!, arch: 'arm64' })).toThrow()
    expect(() => packagedResourceRoot(root, 'agent-payload', stamp, 'x64', { commit: stamp.commit!, arch: 'arm64' })).toThrow()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
