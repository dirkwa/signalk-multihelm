/**
 * What `GET /plugins/signalk-multihelm/status` answers. The configuration
 * panel reads it, so it grows by addition.
 */

import type { PeerInfo, Role } from './api.js'
import type { MasterChoice } from './boat-master.js'
import type { DiscoveredServer } from './discovery.js'
import type { Placement } from './placement.js'
import type { ServerPlan } from './plan.js'
import type { PairedServer } from './store.js'

/**
 * This server's own admin access request, which a server needs to write the
 * master's vessel settings and to switch the plugins that run on the master;
 * null while none waits or was denied. `request` is its identifier, so the
 * panel can approve it.
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
  /** The versions this server runs; older versions leave them out. */
  signalk?: string
  multihelm?: string
  role: Role | null
  master: PeerInfo | null
  masterConflict: boolean
  /**
   * This server reaches most of the boat's servers; without that it is not
   * the master. Older versions leave it out.
   */
  majority?: boolean
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
  /** The plugins that run on the boat's master only, the same on every server. */
  masterPlugins: string[]
  /** The plugins whose settings are the same on every server. */
  sharedPlugins: string[]
  /**
   * This server's request to send commands to the master's autopilot, while
   * it waits for approval on the master; `request` is its identifier there.
   */
  controlAccess: { masterId: string; request: string } | null
  /**
   * The boat plan by server id: each server's settings, the same on every
   * server. A server is listed once it runs a Multihelm that knows the plan.
   * Older versions leave it out.
   */
  plan?: Record<string, ServerPlan>
  /**
   * The plugins placed on chosen servers: each runs on the first server of
   * its list that is there. The same on every server; older versions leave it out.
   */
  placement?: Placement
  /**
   * The boat's choice of master, made from the console or in a server's
   * plugin settings; null while none was made. Older versions leave it out.
   */
  masterChoice?: MasterChoice | null
  /**
   * The servers known to follow that choice: this one and the paired peers
   * whose Multihelm knows it. Older versions leave it out.
   */
  followsChoice?: string[]
}
