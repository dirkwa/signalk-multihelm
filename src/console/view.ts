import {
  accessRequestsUrl,
  ago,
  roleNotice,
  versionText,
  type Notice
} from '../configpanel/view.js'
import type { Status } from '../status.js'

export type ServerState = 'online' | 'offline' | 'waiting-approval' | 'needs-pairing'

export interface ServerColumn {
  id: string
  name: string
  /** The server this console is served by. */
  here: boolean
  master: boolean
  state: ServerState
  versions: string
  lastSeen?: number
  /** Paired with this server, but this server is not paired with it. */
  oneWay: boolean
}

export interface InstalledPlugin {
  id: string
  name: string
  enabled: boolean
}

export interface Attention extends Notice {
  link?: { href: string; text: string }
}

export const SETTINGS_URL = '/admin/#/serverConfiguration/plugins/signalk-multihelm'
const OWN_ACCESS_URL = '/admin/#/security/access/requests'

/** This server first, then the servers it pairs with, then those that only pair with it. */
export function serverColumns(status: Status): ServerColumn[] {
  const here: ServerColumn = {
    id: status.serverId ?? '',
    name: status.name,
    here: true,
    master: status.role === 'master',
    state: 'online',
    versions: '',
    oneWay: false
  }
  const peers = status.peers.map((peer): ServerColumn => ({
    id: peer.id,
    name: peer.name,
    here: false,
    master: status.master !== null && status.master.id === peer.id,
    state: peer.state === 'paired' ? (peer.online === true ? 'online' : 'offline') : peer.state,
    versions: versionText(peer),
    ...(peer.lastSeen === undefined ? {} : { lastSeen: peer.lastSeen }),
    oneWay: false
  }))
  const known = new Set([here.id, ...peers.map((p) => p.id)])
  const pairedBy = status.pairedBy
    .filter((server) => !known.has(server.id))
    .map((server): ServerColumn => ({
      id: server.id,
      name: server.name,
      here: false,
      master: false,
      state: server.online ? 'online' : 'offline',
      versions: versionText(server),
      lastSeen: server.lastSeen,
      oneWay: true
    }))
  return [here, ...peers, ...pairedBy]
}

/** From `/skServer/plugins`; entries without an id are left out. */
export function installedPlugins(raw: unknown): InstalledPlugin[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .filter(
      (p): p is { id: string; name?: unknown; data?: { enabled?: unknown } } =>
        typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string'
    )
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' && p.name !== '' ? p.name : p.id,
      enabled: p.data?.enabled === true
    }))
}

export function pluginName(id: string, installed: InstalledPlugin[]): string {
  return installed.find((p) => p.id === id)?.name ?? id
}

/**
 * The plugins that run on the master only, as they stand on this server
 * while it is the master: those it lacks or has not started yet.
 */
export function masterPluginProblems(status: Status, installed: InstalledPlugin[]): Attention[] {
  if (status.role !== 'master' || installed.length === 0) {
    return []
  }
  return status.masterPlugins.flatMap((id): Attention[] => {
    const plugin = installed.find((p) => p.id === id)
    if (!plugin) {
      return [{ tone: 'danger', text: `${id} runs on the master only, but is not installed here.` }]
    }
    return plugin.enabled
      ? []
      : [
          {
            tone: 'warning',
            text: `${plugin.name} runs on the master only and is not started here yet.`
          }
        ]
  })
}

/** The panel's notice, but pairing is done in the settings, not below. */
export function consoleRoleNotice(status: Status, now: number): Attention {
  const unpaired =
    status.running &&
    !status.masterConflict &&
    status.role !== 'master' &&
    status.master === null &&
    status.majority !== false &&
    !status.peers.some((p) => p.state === 'paired')
  return unpaired
    ? {
        tone: 'warning',
        text: "No master found: this server is not paired yet. Pair it with the boat's master in the settings.",
        link: { href: SETTINGS_URL, text: 'Settings' }
      }
    : roleNotice(status, now)
}

/** What needs someone to act besides the role, most pressing first. */
export function attention(status: Status, installed: InstalledPlugin[]): Attention[] {
  const items: Attention[] = []
  if (status.ownAccess?.state === 'waiting-approval') {
    items.push({
      tone: 'warning',
      text: 'Multihelm waits for admin access to this server.',
      link: { href: OWN_ACCESS_URL, text: 'Approve' }
    })
  } else if (status.ownAccess?.state === 'denied') {
    items.push({
      tone: 'danger',
      text: 'Admin access to this server was denied, so Multihelm cannot write here.',
      link: { href: SETTINGS_URL, text: 'Settings' }
    })
  }
  if (status.controlAccess) {
    const master = status.peers.find((p) => p.id === status.controlAccess?.masterId)
    items.push({
      tone: 'warning',
      text: `The master${master ? `, ${master.name},` : ''} has not approved commands from this server yet.`,
      ...(master ? { link: { href: accessRequestsUrl(master.url), text: 'Approve there' } } : {})
    })
  }
  for (const peer of status.peers) {
    if (peer.state === 'waiting-approval') {
      items.push({
        tone: 'warning',
        text: `Pairing with ${peer.name} waits for approval there.`,
        link: { href: accessRequestsUrl(peer.url), text: 'Approve there' }
      })
    } else if (peer.state === 'needs-pairing') {
      items.push({
        tone: 'danger',
        text: `${peer.name} needs to be paired again${peer.lastError ? `: ${peer.lastError}` : '.'}`,
        link: { href: SETTINGS_URL, text: 'Settings' }
      })
    }
  }
  items.push(...masterPluginProblems(status, installed))
  return items
}

export function stateText(column: ServerColumn, now: number): string {
  switch (column.state) {
    case 'online':
      return column.here ? 'This server' : `Online, answered ${ago(column.lastSeen, now)}`
    case 'offline':
      return `Offline, last answered ${ago(column.lastSeen, now)}`
    case 'waiting-approval':
      return 'Waiting for approval'
    case 'needs-pairing':
      return 'Needs pairing again'
  }
}
