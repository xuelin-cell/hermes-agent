import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { expect, it } from 'vitest'

import { waitForBackendExit } from '../backend-child'

import { listLogoutProcesses, logoutProcessTree, stopLogoutProcesses } from './logout-processes'

it.skipIf(process.platform !== 'win32')('真实 Windows 进程子树停止且无关进程存活，不依赖模拟 taskkill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hermes-logout-tree-'))
  const marker = path.join(root,'leaf.json')
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid})); setInterval(()=>{},1000)`
  const parent = spawn(process.execPath,['-e',script],{stdio:'ignore',windowsHide:true})
  const unrelated = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  let owned: ReturnType<typeof logoutProcessTree> = []

  try {
    const deadline = Date.now()+10_000

    while (!fs.existsSync(marker) && Date.now()<deadline) {await delay(50)}
    const leaf = JSON.parse(fs.readFileSync(marker,'utf8')).pid
    owned = logoutProcessTree(listLogoutProcesses(),[parent.pid!])
    expect(owned.map(row => row.pid)).toEqual(expect.arrayContaining([parent.pid,leaf]))
    expect(owned.some(row => row.pid===unrelated.pid)).toBe(false)
    const foreign = listLogoutProcesses().find(row => row.pid === unrelated.pid)!

    // 使用真实无关 PID 配旧创建时间模拟 PID 重用，批量清理仍不得误杀。
    stopLogoutProcesses([...owned, { ...foreign, started: (BigInt(foreign.started) - 10_000_000n).toString() }])
    await waitForBackendExit(parent, { forceKillProcessTree: () => { throw new Error('父进程应已停止') } })
    expect(() => process.kill(leaf,0)).toThrow()
    expect(unrelated.exitCode).toBeNull()
    expect(unrelated.signalCode).toBeNull()
    process.kill(unrelated.pid!, 0)
  } finally {
    if (owned.length) {stopLogoutProcesses(owned)}

    for (const child of [parent,unrelated]) {
      if (child.exitCode===null && child.signalCode===null) { child.kill(); await once(child,'exit') }
    }

    fs.rmSync(root,{recursive:true,force:true})
  }
},60_000)
