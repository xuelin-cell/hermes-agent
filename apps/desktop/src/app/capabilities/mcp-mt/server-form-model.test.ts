import { expect, it } from 'vitest'

import {
  blankForm,
  entryFromForm,
  formFromEntry,
  needsReload,
  placeServer,
  type ServerForm,
  validateForm
} from './server-form-model'

it('round-trips a stdio entry through the form and keeps fields the form does not show', () => {
  const entry = {
    command: 'npx',
    args: ['-y', 'pkg', 'two words', 'say "hi"', ''],
    env: { TOKEN: '${TOKEN}' },
    cwd: '/work',
    timeout: 90,
    tools: { exclude: ['delete'] },
    trust: 'untrusted',
    enabled: false
  }

  const form = formFromEntry('files', entry)
  expect(form).toMatchObject({
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    env: [{ key: 'TOKEN', value: '${TOKEN}' }]
  })
  expect(entryFromForm(form, entry)).toEqual(entry)
})

it('replaces only transport fields when the type switches, and drops empty collections', () => {
  const stdio = { command: 'uvx', args: ['tool'], env: { A: '1' }, cwd: '/x', timeout: 600, auth: 'oauth' }

  const http: ServerForm = {
    ...formFromEntry('svc', stdio),
    transport: 'http',
    url: ' https://example.invalid/mcp ',
    headers: [
      { key: 'X-Key', value: 'v' },
      { key: ' ', value: 'ignored' }
    ]
  }

  expect(entryFromForm(http, stdio)).toEqual({
    url: 'https://example.invalid/mcp',
    headers: { 'X-Key': 'v' },
    timeout: 600,
    auth: 'oauth'
  })

  const sse = { url: 'https://example.invalid/sse', transport: 'sse', headers: { A: 'b' }, timeout: 30 }
  const back: ServerForm = { ...formFromEntry('svc', sse), transport: 'stdio', command: 'node', args: '', env: [] }
  expect(entryFromForm(back, sse)).toEqual({ command: 'node', timeout: 30 })
})

it('explains why a form cannot be saved yet', () => {
  const http = { ...blankForm('http'), name: 'svc', url: 'https://example.invalid' }
  expect(validateForm(http, [])).toBeNull()
  expect(validateForm({ ...http, name: '  ' }, [])).toBe('nameRequired')
  expect(validateForm({ ...http, name: ' other ' }, ['other'])).toBe('nameTaken')
  expect(validateForm({ ...http, url: ' ' }, [])).toBe('urlRequired')

  const stdio = { ...blankForm('stdio'), name: 'svc', command: 'node' }
  expect(validateForm(stdio, [])).toBeNull()
  expect(validateForm({ ...stdio, command: '' }, [])).toBe('commandRequired')
  expect(validateForm({ ...stdio, args: 'run "unterminated' }, [])).toBe('argsQuote')
})

it('renames in place, appends new servers and reloads only when a running server changes', () => {
  const servers = { a: { command: 'a' }, b: { command: 'b', enabled: false }, c: { url: 'u' } }

  expect(Object.keys(placeServer(servers, 'b', 'renamed', { command: 'b', enabled: false }))).toEqual([
    'a',
    'renamed',
    'c'
  ])
  expect(Object.keys(placeServer(servers, null, 'd', { url: 'd', enabled: false }))).toEqual(['a', 'b', 'c', 'd'])

  expect(needsReload(servers, { ...servers, b: { command: 'b2', enabled: false } })).toBe(false)
  expect(needsReload(servers, placeServer(servers, null, 'd', { url: 'd', enabled: false }))).toBe(false)
  expect(needsReload(servers, { ...servers, a: { command: 'a', enabled: false } })).toBe(true)
  expect(needsReload(servers, { ...servers, b: { command: 'b' } })).toBe(true)
  const { c: _removed, ...withoutC } = servers
  expect(needsReload(servers, withoutC)).toBe(true)
})
