import process from 'node:process'

import WebSocket from 'ws'

const [baseUrl, username, password] = process.argv.slice(2)

if (!baseUrl || !username || !password) {
  console.error('Usage: node scripts/verify-browser-deployment.mjs <url> <username> <password>')
  process.exit(2)
}

const url = new URL(baseUrl)
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
const request = path => fetch(new URL(path, url), { headers: { authorization } })

const anonymous = await fetch(url)
if (anonymous.status !== 401) {
  throw new Error(`Expected anonymous request to return 401, received ${anonymous.status}`)
}

const indexResponse = await request(url.pathname)
if (!indexResponse.ok) {
  throw new Error(`Index request failed: ${indexResponse.status}`)
}
const html = await indexResponse.text()
const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map(match => match[1])
  .filter(path => path.startsWith(url.pathname))
const assetResults = await Promise.all(
  assetPaths.map(async path => {
    const response = await request(path)
    return { path, status: response.status }
  })
)
const failedAssets = assetResults.filter(item => item.status !== 200)
if (failedAssets.length) {
  throw new Error(`Static asset checks failed: ${JSON.stringify(failedAssets)}`)
}

const statusResponse = await request(`${url.pathname}__hermes_backend/api/status`)
if (!statusResponse.ok) {
  throw new Error(`Backend status failed: ${statusResponse.status} ${await statusResponse.text()}`)
}
const status = await statusResponse.json()

const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
const wsUrl = new URL(`${url.pathname}api/ws`, url)
wsUrl.protocol = wsProtocol
const gatewayEvent = await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl, { headers: { authorization } })
  const timeout = setTimeout(() => {
    socket.terminate()
    reject(new Error('WebSocket timed out'))
  }, 15_000)

  socket.on('error', reject)
  socket.on('message', data => {
    clearTimeout(timeout)
    socket.close()
    resolve(JSON.parse(data.toString()))
  })
})

if (gatewayEvent?.params?.type !== 'gateway.ready') {
  throw new Error(`Expected gateway.ready, received ${JSON.stringify(gatewayEvent)}`)
}

const report = {
  anonymousStatus: anonymous.status,
  assetCount: assetResults.length,
  backendVersion: status.version,
  browserBuildMarker: html.includes('/hermes/assets/'),
  gatewayEvent: gatewayEvent.params.type,
  indexStatus: indexResponse.status
}

console.log(JSON.stringify(report, null, 2))
