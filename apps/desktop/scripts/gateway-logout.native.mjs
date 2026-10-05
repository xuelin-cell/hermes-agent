import assert from 'node:assert/strict'
import {mkdtemp, access, readdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'

import {startFixtureGateway, gatewayOperation, cleanupFixtureGateways, prepareFixtureAutostart, fixtureTask, startFixtureRestartWatcher} from './gateway-logout.fixture.mjs'

test('P20 原版真实网关：账号与同名 Profile 停止，另一 Home 保持健康，重复停止不重启',
  {timeout:240_000,skip:process.platform!=='win32'},async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'hermes-mt-gateway-'))
    const source=path.resolve(import.meta.dirname,'../../..')
    const context={installationRoot:source,python:path.join(source,'.venv/Scripts/python.exe'),home:path.join(root,'account-a'),fixtureAppData:path.join(root,'appdata')}
    const taskNames=['Hermes_Gateway_fixture_'+randomUUID(),'Hermes_Gateway_fixture_'+randomUUID()]
    const registered=[]
    console.log(`P20 真实网关夹具：${root}`)
    try {
      const own=await startFixtureGateway(context,context.home)
      const profile=await startFixtureGateway(context,path.join(context.home,'profiles','coder'))
      const foreign=await startFixtureGateway(context,path.join(root,'account-b','profiles','coder'))
      for (const [home,name] of [[own.home,taskNames[0]],[foreign.home,taskNames[1]]]) {
        await prepareFixtureAutostart(context,home,name)
        registered.push(name)
      }
      const saved=await gatewayOperation(context,'snapshot')
      assert.deepEqual([...new Set(saved.map(row => row.home))].sort(),[own.home,profile.home].sort())
      assert.ok(saved.every(row => row.created>0 && !row.launcher))
      // 错误创建时间模拟 PID 已重用，不能作用于另一账号的真实进程。
      await gatewayOperation(context,'stop',[...saved,{...saved[0],pid:foreign.child.pid,created:saved[0].created-100}])
      await delay(1500)
      await gatewayOperation(context,'check')
      assert.equal(await fixtureTask(taskNames[0]),false)
      assert.equal(await fixtureTask(taskNames[1]),true)
      assert.equal((await readdir(path.join(own.home,'gateway-service','disabled-autostart'))).length,1)
      assert.equal((await readdir(path.join(context.fixtureAppData,'Microsoft/Windows/Start Menu/Programs/Startup'))).length,1)
      assert.equal((await fetch(`http://127.0.0.1:${foreign.port}/health`)).ok,true)
      for (const gateway of [own,profile]) {
        assert.ok(gateway.child.exitCode !== null || gateway.child.signalCode !== null)
        await assert.rejects(fetch(`http://127.0.0.1:${gateway.port}/health`))
        await access(path.join(gateway.home,'config.yaml'))
      }
      await gatewayOperation(context,'stop',saved)
      assert.equal((await fetch(`http://127.0.0.1:${foreign.port}/health`)).ok,true)
      const watcher=startFixtureRestartWatcher(context)
      await delay(500)
      const launchers=await gatewayOperation(context,'snapshot')
      assert.ok(launchers.some(row => row.launcher && row.pid===watcher.pid))
      await gatewayOperation(context,'stop',launchers)
      assert.ok(watcher.exitCode !== null || watcher.signalCode !== null)
      startFixtureRestartWatcher(context,true)
      await delay(500)
      await assert.rejects(gatewayOperation(context,'stop'),/网关停止验证失败/)
      assert.equal((await fetch(`http://127.0.0.1:${foreign.port}/health`)).ok,true)
    } finally {
      await cleanupFixtureGateways()
      for (const name of registered) await fixtureTask(name,true)
    }
})
