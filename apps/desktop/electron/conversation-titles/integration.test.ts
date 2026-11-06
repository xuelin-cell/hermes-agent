import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, it, vi } from 'vitest'

import { startTitleBridge } from './bridge'
import { TitleModelService } from './service'

it('真实Python插件HTTP与钩子经本机桥落盘，主消息保持不变，重启及手动命名有效', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'title-chain-'))

  let parallelArrivals = 0
  let releaseParallel!: () => void
  const bothArrived = new Promise<void>(resolve => { releaseParallel = resolve })

  const request = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(init!.body as string).messages[1].content)

    if (input.intent.startsWith('并行')) {
      parallelArrivals += 1

      if (parallelArrivals === 2) {releaseParallel()}
      await bothArrived

      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: input.intent } }] }))
    }

    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '房屋租赁合同条款' } }] }))
  }).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '标题：格式错误的回复' } }] })))

  const bridge = await startTitleBridge(
    new TitleModelService(
      () => ({
        status: 'available',
        plan: {
          apiKey: 'isolated-key',
          mainModelIndex: 0,
          models: [{ id: 'test', name: 'digital-employee', baseUrl: 'https://digital.example/v1' }]
        }
      }),
      request
    )
  )

  try {
    const result = await promisify(execFile)(
      process.env.HERMES_PYTHON || path.join(root, '.venv-desktop', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      [path.join(root, 'tests/apps/desktop/fixtures/conversation_titles_probe.py')],
      {
        cwd: root,
        timeout: 15000,
        env: {
          ...process.env,
          ...bridge.env,
          HERMES_HOME: home,
          HERMES_DISABLE_LAZY_INSTALLS: '1',
          PYTHONPATH: root,
          PYTHONPYCACHEPREFIX: path.join(home, 'pycache')
        }
      }
    )

    expect(result.stdout + result.stderr).toContain('"mainMessagesUnchanged": true')
    expect(request).toHaveBeenCalledTimes(4)
    expect(parallelArrivals).toBe(2)
    const [, options] = request.mock.calls[0] as unknown as [URL, RequestInit]
    const body = JSON.parse(options.body as string)
    expect(body.model).toBe('digital-employee')
    const content = JSON.parse(body.messages[1].content)
    expect(content.intent).toBe('')
    expect(content.material).toContain('押金')
    expect(JSON.stringify(body)).not.toContain('89413')
  } finally {
    releaseParallel()
    await bridge.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 20000)
