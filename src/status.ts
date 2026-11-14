/**
 * What `GET /plugins/signalk-multihelm/status` answers. The configuration
 * panel reads it, so it grows by addition.
 */

import type { PeerInfo, Role } from './api.js'
import type { DiscoveredServer } from './discovery.js'
import type { PairedServer } from './store.js'

/**
 * This server's own admin access request, which a member needs to write the
 * master's vessel settings; null while none waits or was denied. `request` is
 * its identifier, so the panel can approve it.
 */
export type OwnAccessState =
  { state: 'waiting-approval'; request: string } | { state: 'denied' } | null

/** A server that paired with this one; online while it asked within the last rounds. */
export type PairedByInfo = PairedServer & { online: boolean }

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
  /** The servers this one pairs with: it takes over what they share. */
  peers: PeerInfo[]
  /**
   * The servers that paired with this one, as they said when they last asked
   * for its `hello`; older Multihelm versions do not say.
   */
  pairedBy: PairedByInfo[]
  discovered: DiscoveredServer[]
  ownAccess: OwnAccessState
}
