import { startConnectors } from './connectors.ts'

process.umask(0o077)
const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error('Missing connector runtime configuration')
  return value
}
const host = await startConnectors({
  home: required('HERMES_HOME'), encryption: required('OOMOL_CONNECT_ENCRYPTION_KEY'),
  admin: required('OOMOL_CONNECT_ADMIN_TOKEN'), runtime: required('OOMOL_CONNECT_RUNTIME_TOKEN'), port: Number(required('OOMOL_CONNECT_PORT'))
})
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  void host.close().then(() => process.exit(0), () => process.exit(1))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) stop() }, 1000).unref()
