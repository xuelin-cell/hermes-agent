import fs from 'node:fs'
import path from 'node:path'

import { isMap, parseDocument, type YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'

import { CONNECTOR_SPECS, type ConnectorId } from './contract'

export function connectorHome(accountHome: string, profile: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    throw new Error('Invalid connector profile')
  }

  const home = profile === 'default' ? accountHome : path.join(accountHome, 'profiles', profile)

  for (const folder of profile === 'default'
    ? [accountHome]
    : [accountHome, path.join(accountHome, 'profiles'), home]) {
    const stat = fs.lstatSync(folder)

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Invalid connector profile directory')
    }
  }

  const directory = path.join(home, 'open-connector')
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false })

  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('Invalid connector data directory')
  }

  return home
}

/** Only refresh records owned by this desktop before the profile backend starts. */
export async function prepareConnectorConfig(
  home: string,
  connected: readonly ConnectorId[],
  config: (id: ConnectorId) => Promise<Record<string, unknown>>
): Promise<void> {
  const file = path.join(home, 'config.yaml')
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })

  if (!stat) {
    return
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Invalid connector config file')
  }

  const original = fs.readFileSync(file, 'utf8')
  const doc = parseDocument(original, { version: '1.1', logLevel: 'silent' })

  if (doc.errors.length || doc.warnings.length) {
    throw new Error('Cannot read connector config')
  }

  const serversNode = doc.get('mcp_servers')
  let servers: YAMLMap

  if (serversNode === undefined || serversNode === null) {
    const created = doc.createNode({})

    if (!isMap(created)) {
      throw new Error('Cannot create connector MCP configuration')
    }

    servers = created
    doc.set('mcp_servers', servers)
  } else if (!isMap(serversNode)) {
    throw new Error('Cannot read connector MCP configuration')
  } else {
    servers = serversNode
  }

  const updates: [ConnectorId, Record<string, unknown>][] = []
  const connectedIds = new Set(connected)

  for (const id of Object.keys(CONNECTOR_SPECS) as ConnectorId[]) {
    const entry = servers.get(`connector_${id}`)

    if (entry === undefined && connectedIds.has(id)) {
      updates.push([id, await config(id)])

      continue
    }

    if (!isMap(entry) || entry.get('desktop_connector') !== id) {
      continue
    }

    if (servers.anchor || entry.anchor || entry.has('<<')) {
      throw new Error('Shared connector YAML nodes are not supported')
    }

    updates.push([id, await config(id)])
  }

  // A concurrent editor wins; never replace a newer document with this snapshot.
  if (fs.readFileSync(file, 'utf8') !== original) {
    throw new Error('Connector config changed during startup')
  }

  for (const [id, next] of updates) {
    const entry = servers.get(`connector_${id}`)

    if (entry === undefined) {
      servers.set(`connector_${id}`, doc.createNode({ ...next, desktop_connector: id, enabled: true }))

      continue
    }

    if (!isMap(entry)) {
      continue
    }

    entry.set('url', next.url)
    entry.set('headers', doc.createNode(next.headers))

    if (connectedIds.has(id)) {
      entry.set('enabled', true)
    }
  }

  if (updates.length) {
    writeSecretFileAtomic(file, doc.toString({ lineWidth: 0 }), { encoding: 'utf8' })
  }
}

/** Refresh the hidden Agent Mail MCP endpoint without publishing it in the connector catalogue. */
export async function prepareAgentMailConfig(
  home: string,
  connected: boolean,
  config: () => Promise<Record<string, unknown>>,
  enabled?: boolean
): Promise<void> {
  const file = path.join(home, 'config.yaml')
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })

  if (!stat || !connected) {
    return
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Invalid connector config file')
  }

  const original = fs.readFileSync(file, 'utf8')
  const doc = parseDocument(original, { version: '1.1', logLevel: 'silent' })

  if (doc.errors.length || doc.warnings.length) {
    throw new Error('Cannot read connector config')
  }

  const serversNode = doc.get('mcp_servers')

  let servers: YAMLMap

  if (serversNode === undefined || serversNode === null) {
    const created = doc.createNode({})

    if (!isMap(created)) {
      throw new Error('Cannot create Agent Mail MCP configuration')
    }

    servers = created
    doc.set('mcp_servers', servers)
  } else if (!isMap(serversNode)) {
    throw new Error('Cannot read Agent Mail MCP configuration')
  } else {
    servers = serversNode
  }

  const entry = servers.get('connector_wo_mail')

  if (entry === undefined) {
    const next = await config()

    if (fs.readFileSync(file, 'utf8') !== original) {
      throw new Error('Connector config changed during startup')
    }

    servers.set('connector_wo_mail', doc.createNode({ ...next, desktop_agent_mail: true, enabled: enabled ?? true }))
    writeSecretFileAtomic(file, doc.toString({ lineWidth: 0 }), { encoding: 'utf8' })

    return
  }

  if (!isMap(entry) || entry.get('desktop_agent_mail') !== true) {
    return
  }

  if (servers.anchor || entry.anchor || entry.has('<<')) {
    throw new Error('Shared connector YAML nodes are not supported')
  }

  const next = await config()

  if (fs.readFileSync(file, 'utf8') !== original) {
    throw new Error('Connector config changed during startup')
  }

  entry.set('url', next.url)
  entry.set('headers', doc.createNode(next.headers))

  if (enabled !== undefined) {
    entry.set('enabled', enabled)
  }

  writeSecretFileAtomic(file, doc.toString({ lineWidth: 0 }), { encoding: 'utf8' })
}
