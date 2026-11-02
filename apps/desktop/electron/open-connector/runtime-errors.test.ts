import { expect, it } from 'vitest'

import { isValidationTimeout } from './runtime'

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 400 })

it('treats a credential validation that ran out of time as a timeout, not a rejected credential', async () => {
  const timedOut = {
    error: {
      code: 'credential_verification_failed',
      message: 'SMTP credential validation exceeded 15000ms (SMTP smtp.wo.cn:465)'
    }
  }

  const rejected = {
    error: {
      code: 'credential_verification_failed',
      message: 'Verify that Wo Mail IMAP/SMTP service is enabled and use the mailbox authorization code.'
    }
  }

  expect(await isValidationTimeout(reply(timedOut))).toBe(true)
  expect(await isValidationTimeout(reply(rejected))).toBe(false)
  expect(await isValidationTimeout(reply({ error: { code: 'invalid_input', message: 'timed out' } }))).toBe(false)
  expect(await isValidationTimeout(new Response('not json', { status: 400 }))).toBe(false)
})
