/**
 * On a server that is not the master: takes the vessel data and path
 * metadata over from the master. They are read from the master with the
 * pairing token and written here through this server's own REST API, the
 * way its settings pages write them, so they survive a restart. Writing
 * needs an admin device token on this server, asked for once; until it is
 * approved nothing is written.
 */

import { isDeepStrictEqual } from 'node:util'

import {
  PeerHttpError,
  callServer,
  fetchVesselSettings,
  pollAccess,
  requestAccess,
  type AccessRequestResult
} from './peer-client.js'
import type { MultihelmStore, OwnAccess } from './store.js'
import {
  VESSEL_FIELDS,
  parseVesselSettings,
  type VesselData,
  type VesselSettings
} from './vessel-settings.js'

export interface FollowHost {
  store: MultihelmStore
  serverId: string
  /** This server, over loopback: `http(s)://127.0.0.1:<port>`. */
  ownUrl: () => string
  /** What this server holds now; null when the server does not expose it. */
  localSettings: () => VesselSettings | null
  /** The master to follow, or null when this server is the master or there is none. */
  master: () => { url: string; token: string } | null
  followVessel: boolean
  followMeta: boolean
  debug: (msg: string) => void
  error: (msg: string) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function metaUrl(base: string, path: string): string {
  const segments = path.split('.').map((s) => encodeURIComponent(s))
  return `${base}/signalk/v1/api/vessels/self/${segments.join('/')}/meta`
}

export class MasterFollower {
  private access: OwnAccess

  constructor(private readonly host: FollowHost) {
    this.access = host.store.loadOwnAccess()
  }

  /** Whether the user has to approve this server's own access request. */
  waitingForApproval(): boolean {
    return this.access.state === 'waiting-approval'
  }

  /** Whether the user denied it; it is asked for again only after a restart. */
  denied(): boolean {
    return this.access.state === 'denied'
  }

  async run(): Promise<void> {
    const { followVessel, followMeta } = this.host
    const master = this.host.master()
    const local = this.host.localSettings()
    if ((!followVessel && !followMeta) || !master || !local) {
      return
    }
    let remote: VesselSettings | null
    try {
      remote = parseVesselSettings(await fetchVesselSettings(master.url, master.token))
    } catch (error) {
      this.host.debug(`Multihelm: vessel settings from the master: ${errorText(error)}`)
      return
    }
    if (!remote) {
      return
    }
    const vesselChanged =
      followVessel && VESSEL_FIELDS.some((k) => remote.vessel[k] !== local.vessel[k])
    const metaChanged = followMeta
      ? [...new Set([...Object.keys(remote.meta), ...Object.keys(local.meta)])].filter(
          (p) => !isDeepStrictEqual(remote.meta[p], local.meta[p])
        )
      : []
    if (!vesselChanged && metaChanged.length === 0) {
      return
    }
    const token = await this.ownToken()
    if (token === null) {
      return
    }
    const base = this.host.ownUrl()
    try {
      if (vesselChanged) {
        await this.writeVessel(base, token, remote.vessel)
      }
      for (const path of metaChanged) {
        const value = remote.meta[path]
        await (value === undefined
          ? callServer('DELETE', metaUrl(base, path), token)
          : callServer('PUT', metaUrl(base, path), token, { value }))
      }
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        this.setAccess({ token: '', state: 'none' })
      }
      this.host.error(`Multihelm: taking over the master's vessel settings: ${errorText(error)}`)
    }
  }

  /** The vessel route writes every field, so the ones that stay here are sent back as they are. */
  private async writeVessel(base: string, token: string, vessel: VesselData): Promise<void> {
    const current = await callServer('GET', `${base}/skServer/vessel`, token)
    const body: Record<string, unknown> =
      typeof current === 'object' && current !== null ? { ...current } : {}
    for (const key of VESSEL_FIELDS) {
      body[key] = vessel[key]
    }
    await callServer('PUT', `${base}/skServer/vessel`, token, body)
  }

  private setAccess(access: OwnAccess): void {
    this.access = access
    this.host.store.saveOwnAccess(access)
  }

  private async ownToken(): Promise<string | null> {
    const base = this.host.ownUrl()
    if (this.access.state === 'granted') {
      return this.access.token
    }
    if (this.access.state === 'denied') {
      return null
    }
    let result: AccessRequestResult
    try {
      result =
        this.access.state === 'waiting-approval' && this.access.requestHref
          ? await pollAccess(base, this.access.requestHref)
          : await requestAccess(
              base,
              `signalk-multihelm-self-${this.host.serverId}`,
              'Multihelm: take the vessel settings over from the master',
              'admin'
            )
    } catch (error) {
      this.host.debug(`Multihelm: access request on this server: ${errorText(error)}`)
      return null
    }
    switch (result.kind) {
      case 'no-security':
        this.setAccess({ token: '', state: 'granted' })
        return ''
      case 'approved':
        this.setAccess({ token: result.token, state: 'granted' })
        return result.token
      case 'pending':
        this.setAccess({ token: '', requestHref: result.href, state: 'waiting-approval' })
        return null
      case 'denied':
        this.host.store.saveOwnAccess({ token: '', state: 'none' })
        this.access = { token: '', state: 'denied' }
        return null
      case 'error':
        this.host.debug(`Multihelm: access request on this server: ${result.message}`)
        return null
    }
  }
}
