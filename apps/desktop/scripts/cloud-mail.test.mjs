import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createServer } from 'node:net'

it('reuses Wo Mail input validation and persistent, account-scoped sending quota', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-mail-'))
  try {
    const file = path.join(root, 'mail.mjs')
    await build({ entryPoints: ['services/open-connector/cloud/mail.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file,
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: 'silent' })
    const { mailAction, quotaStatus } = await import(pathToFileURL(file).href)
    const sent = []
    const base = { 'wo_mail.send_email': async (args, context) => {
      const credential = await context.getCredential('wo_mail')
      sent.push(credential.values.email)
      return { ok: true, output: { messageId: String(sent.length) } }
    } }
    for (const name of ['alice', 'bob']) await mkdir(path.join(root, name))
    const request = owner => ({ name: 'send_email', args: { to: ['recipient@example.org'], subject: 'Hello', text: 'Body' },
      values: { email: owner + '@wo.cn', authorizationCode: 'private-code' }, directory: path.join(root, owner, 'quota'), attachments: path.join(root, owner, 'attachments') })
    await expect(mailAction({ ...request('alice'), args: { to: [] } }, base)).rejects.toThrow()
    expect(sent).toHaveLength(0)
    for (let index = 0; index < 50; index++) await mailAction(request('alice'), base)
    await expect(mailAction(request('alice'), base)).rejects.toThrow(/limit/)
    await mailAction(request('bob'), base)
    expect(quotaStatus(request('alice').directory, 'alice@wo.cn').todaySent).toBe(50)
    expect(quotaStatus(request('bob').directory, 'bob@wo.cn').todaySent).toBe(1)
    expect(await readFile(path.join(request('alice').directory, 'agent-mail-quota.json'), 'utf8')).not.toMatch(/private-code|alice@wo.cn/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('sends through the shared mail protocol over a real SMTP socket', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-mail-smtp-'))
  const received = []
  const server = createServer(socket => {
    let buffer = '', data = false, message = []
    socket.write('220 test ESMTP\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString()
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data) {
          if (line === '.') { received.push(message.join('\n')); message = []; data = false; socket.write('250 accepted\r\n') }
          else message.push(line)
        } else if (/^EHLO/.test(line)) socket.write('250-test\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH/.test(line)) socket.write('235 authenticated\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 message\r\n') }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const file = path.join(root, 'protocol.mjs')
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      export {createMailProtocol} from './services/open-connector/src/mail/imap-smtp/protocol.ts';
      export {executeMailAction} from './services/open-connector/src/mail/imap-smtp/runtime.ts';
      export {woMailRuntimeConfig} from './services/open-connector/src/providers/wo_mail/config.ts';
      export {default as nodemailer} from './services/open-connector/node_modules/nodemailer/lib/nodemailer.js';
    ` }, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent',
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" } })
    const { createMailProtocol, executeMailAction, woMailRuntimeConfig, nodemailer } = await import(pathToFileURL(file).href)
    const protocol = createMailProtocol({ displayName: 'Test Mail', attachmentFallbackPrefix: 'mail', saveSentCopy: false }, {
      createSmtpTransport: config => nodemailer.createTransport({ ...config, host: '127.0.0.1', port: server.address().port,
        secure: false, requireTLS: false, ignoreTLS: true })
    })
    const result = await executeMailAction('send_email', { to: ['receiver@example.org'], subject: 'Cloud SMTP', text: 'Body' }, {
      config: woMailRuntimeConfig, values: { email: '13800001111@wo.cn', authorizationCode: 'test-code' }, protocol, fetcher: fetch
    })
    expect(result.accepted).toContain('receiver@example.org')
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('Subject: Cloud SMTP')
    expect(received[0]).toContain('Body')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
