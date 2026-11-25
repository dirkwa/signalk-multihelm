import type { PeerInfo } from '../api.js'
import type { DiscoveredServer } from '../discovery.js'
import type { Status } from '../status.js'

export type Tone = 'success' | 'info' | 'warning' | 'danger'

export interface Notice {
  tone: Tone
  text: string
}

function servers(n: number): string {
  return n === 1 ? '1 server' : `${String(n)} servers`
}

export function roleNotice(status: Status, now: number): Notice {
  if (!status.running) {
    return { tone: 'danger', text: 'Multihelm is not running. Enable it above.' }
  }
  if (status.masterConflict) {
    return {
      tone: 'danger',
      text: "More than one server is set to be the boat's master. Set one only."
    }
  }
  if (status.role === 'master') {
    const paired = status.pairedBy.length
    const online = status.pairedBy.filter((s) => s.online).length
    return {
      tone: 'info',
      text:
        paired === 0
          ? "This server is the boat's master. No other server is paired with it yet."
          : `This server is the boat's master. ${String(online)} of the ${servers(paired)} paired with it ${online === 1 ? 'is' : 'are'} online.`
    }
  }
  if (status.master) {
    return {
      tone: 'success',
      text: `The boat's master is ${status.master.name}; it answered ${ago(status.master.lastSeen, now)}.`
    }
  }
  const paired = status.peers.filter((p) => p.state === 'paired')
  const offline = paired.filter((p) => p.online === false)
  if (status.majority === false) {
    return {
      tone: 'danger',
      text: `No master: this server reaches too few of the boat's servers (${offline.map((p) => p.name).join(', ')} ${offline.length === 1 ? 'is' : 'are'} not reachable), so the plugins that run on the master only are stopped here.`
    }
  }
  if (offline.length > 0) {
    return {
      tone: 'danger',
      text: `No master found: ${offline.map((p) => p.name).join(', ')} ${offline.length === 1 ? 'is' : 'are'} not reachable.`
    }
  }
  if (paired.length === 0) {
    return {
      tone: 'warning',
      text: "No master found: this server is not paired yet. Pair it with the server set to be the boat's master below."
    }
  }
  return {
    tone: 'warning',
    text: "No master found: none of the paired servers is set to be the boat's master."
  }
}

function sameServer(server: DiscoveredServer, peer: PeerInfo): boolean {
  return server.url === peer.url || server.name.toLowerCase() === peer.name.toLowerCase()
}

/** The servers found on the network that this one is not paired with. */
export function unpairedServers(status: Status): DiscoveredServer[] {
  return status.discovered.filter((server) => !status.peers.some((p) => sameServer(server, p)))
}

/** A peer is named by its address until it has answered once; the network may know its name. */
export function peerName(peer: PeerInfo, discovered: DiscoveredServer[]): string {
  if (peer.id !== '') {
    return peer.name
  }
  return discovered.find((s) => s.url === peer.url)?.name ?? peer.name
}

/** Approves an access request on the server the admin UI runs on. */
/**
 * Signal K answers an approval with 404 or 500 when it no longer holds the
 * request as pending, after a restart for one; Multihelm then asks anew.
 */
export function approveErrorText(message: string): string {
  return /^HTTP (404|500)$/.test(message)
    ? 'This request is no longer waiting on the server. Multihelm asks again; approve the new one in a moment.'
    : message
}

export function approveAccessUrl(request: string): string {
  return `/skServer/security/access/requests/${encodeURIComponent(request)}/approved`
}

export function versionText(server: { signalk?: string; multihelm?: string }): string {
  return [
    server.signalk && `Signal K ${server.signalk}`,
    server.multihelm && `Multihelm ${server.multihelm}`
  ]
    .filter(Boolean)
    .join(' · ')
}

export function accessRequestsUrl(serverUrl: string): string {
  return `${serverUrl}/admin/#/security/access/requests`
}

export function ago(time: number | undefined, now: number): string {
  if (time === undefined) {
    return 'never'
  }
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 10) {
    return 'just now'
  }
  if (seconds < 90) {
    return `${String(seconds)} s ago`
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) {
    return `${String(minutes)} min ago`
  }
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} days ago`
}

/** The ids of the server's data connections, from `/skServer/providers`. */
export function connectionIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((p) => (typeof p === 'object' && p !== null ? (p as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .sort((a, b) => a.localeCompare(b))
}

/** Paths typed one per line, or separated by commas. */
export function pathsFromText(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean)
    )
  ]
}

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

/**
 * The App Store's install route on this server, a scoped name keeping its
 * `/`; null for a name or version that is not a plain npm package and
 * version, which a peer could otherwise turn into another route here.
 */
export function appInstallUrl(name: string, version: string): string | null {
  if (name.length > 214 || !PACKAGE_NAME.test(name) || !SEMVER.test(version)) {
    return null
  }
  const parts = name.split('/').map(encodeURIComponent).join('/')
  return `/skServer/appstore/install/${parts}/${encodeURIComponent(version)}`
}

/** Digit strings of any length, exactly: a valid version has no leading zeros. */
function compareNumbers(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/
  if (numeric.test(a) && numeric.test(b)) {
    return compareNumbers(a, b)
  }
  if (numeric.test(a) !== numeric.test(b)) {
    return numeric.test(a) ? -1 : 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** SemVer precedence: build metadata is ignored, a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = a.split('+')[0]?.split(/-(.*)/s) ?? []
  const [coreB = '', preB] = b.split('+')[0]?.split(/-(.*)/s) ?? []
  const numsA = coreA.split('.')
  const numsB = coreB.split('.')
  for (let i = 0; i < 3; i++) {
    const d = compareNumbers(numsA[i] ?? '0', numsB[i] ?? '0')
    if (d !== 0) {
      return d
    }
  }
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1
  }
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    const d = compareIdentifiers(partsA[i] ?? '', partsB[i] ?? '')
    if (d !== 0) {
      return d
    }
  }
  return partsA.length - partsB.length
}

export function newestVersion(versions: string[]): string {
  return versions.reduce(
    (newest, v) => (compareVersions(v, newest) > 0 ? v : newest),
    versions[0] ?? ''
  )
}

/** "USVMAIN 1.4.0, Salon 1.3.2" */
export function serversText(servers: { name: string; version: string }[]): string {
  return servers.map((s) => `${s.name} ${s.version}`).join(', ')
}

export type InstallState = 'pending' | 'done' | 'failed'

/**
 * The App Store installs an `APP_STORE_CHANGED` server event lists, by
 * package; null for any other event. An entry stays listed after its install
 * ended, until the server restarts, so a result may be an earlier attempt's.
 */
export function installStates(event: unknown): Map<string, InstallState> | null {
  if (typeof event !== 'object' || event === null) {
    return null
  }
  const { type, data } = event as { type?: unknown; data?: unknown }
  if (type !== 'APP_STORE_CHANGED' || typeof data !== 'object' || data === null) {
    return null
  }
  const installing = (data as { installing?: unknown }).installing
  const states = new Map<string, InstallState>()
  for (const entry of Array.isArray(installing) ? (installing as unknown[]) : []) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const e = entry as Record<string, unknown>
    if (typeof e.name !== 'string' || e.isRemove === true) {
      continue
    }
    states.set(
      e.name,
      e.isWaiting === true || e.isInstalling === true
        ? 'pending'
        : e.installFailed === true
          ? 'failed'
          : 'done'
    )
  }
  return states
}

export function installState(event: unknown, name: string): InstallState | null {
  return installStates(event)?.get(name) ?? null
}

/** The App Store answers 404 for a package it does not offer, such as one installed from git. */
export function installErrorText(message: string): string {
  return message === 'HTTP 404'
    ? 'The App Store does not offer this package; install it the way it was installed on the other server.'
    : message
}
