import { createInterface } from 'node:readline'
import { mailAction, quotaStatus, tools, validateMail } from './mail.ts'

// The shared protocol logs diagnostic fields; stdio here is a private JSON transport.
console.log = console.info = console.warn = console.error = () => undefined

for await (const line of createInterface({ input: process.stdin })) {
  let request: any
  try {
    request = JSON.parse(line)
    const result = request.operation === 'tools' ? tools
      : request.operation === 'quota' ? quotaStatus(request.directory, request.values.email)
      : request.operation === 'validate' ? await validateMail(request.values)
      : await mailAction(request)
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
  } catch {
    // Provider errors can contain account details; they never cross this boundary.
    process.stdout.write(JSON.stringify({ id: request?.id, error: '邮箱操作失败，请检查开通状态、发送限额或稍后重试。发送结果不确定时请先检查已发送邮件，勿重复发送。' }) + '\n')
  }
}
