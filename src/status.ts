/**
 * What `GET /plugins/signalk-multihelm/status` answers. The configuration
 * panel reads it, so it grows by addition.
 */

import type { PeerInfo, Role } from './api.js'
import type { DiscoveredServer } from './discovery.js'

/**
 * This server's own admin access request, which a member needs to write the
 * master's vessel settings; null while none waits or was denied. `request` is
 * its identifier, so the panel can approve it.
 */
export type OwnAccessState =
  { state: 'waiting-approval'; request: string } | { state: 'denied' } | null

export interface Status {
  /** The server lets peers read the peer routes with a readonly token (2.31 and later). */
  available: boolean
  running: boolean
  serverId: string | null
  /** This server's host name, as the peers show it. */
  name: string
  role: Role | null
  master: PeerInfo | null
  masterConflict: boolean
  datasets: string[]
  peers: PeerInfo[]
  discovered: DiscoveredServer[]
  ownAccess: OwnAccessState
}
