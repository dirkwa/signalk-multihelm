import type { PeerInfo } from '../api.js'
import type { DiscoveredServer } from '../discovery.js'
import type { Status } from '../status.js'

export type Tone = 'success' | 'info' | 'warning' | 'danger'

export interface Notice {
  tone: Tone
  text: string
}

export function roleNotice(status: Status): Notice {
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
    return { tone: 'info', text: "This server is the boat's master." }
  }
  if (status.master) {
    return { tone: 'success', text: `The boat's master is ${status.master.name}.` }
  }
  if (!status.peers.some((p) => p.state === 'paired')) {
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
export function approveAccessUrl(request: string): string {
  return `/skServer/security/access/requests/${encodeURIComponent(request)}/approved`
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
