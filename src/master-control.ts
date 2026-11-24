/**
 * This server's readwrite device token on the master, for sending it the
 * commands a station gives: the autopilot's, and changes of the course.
 * Asked for once and approved by the user under Security -> Access Requests
 * on the master; a token for one master is no use for another.
 */

import type { MasterAccess } from './master-proxy.js'
import { pollAccess, requestAccess, type AccessRequestResult } from './peer-client.js'
import type { ControlAccess, MultihelmStore } from './store.js'

export interface MasterOfBoat {
  id: string
  access: MasterAccess
}

export interface ControlHost {
  store: MultihelmStore
  serverId: string
  /** The id of the master now, whose access is the one kept; null when there is none. */
  currentMaster: () => string | null
  debug: (msg: string) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MasterControlAccess {
  private control: ControlAccess | null
  /** The access request or poll in flight for each master, shared by everyone waiting for it. */
  private readonly asking = new Map<string, Promise<string | null>>()

  constructor(private readonly host: ControlHost) {
    this.control = host.store.loadControlAccess()
  }

  requestId(): string {
    return `signalk-multihelm-control-${this.host.serverId}`
  }

  /** The request the user has to approve on the master; null on the master itself. */
  waitingForApproval(isMaster: boolean): { masterId: string; request: string } | null {
    return !isMaster && this.control?.state === 'waiting-approval'
      ? { masterId: this.control.masterId, request: this.requestId() }
      : null
  }

  /** Whether the master denied it; it is asked for again only after a restart. */
  denied(): boolean {
    return this.control?.state === 'denied'
  }

  /** The master refused `token`: it is asked for again, unless a newer one is saved by now. */
  revoked(masterId: string, token: string): void {
    if (this.control?.masterId === masterId && this.control.token === token) {
      this.save(null)
    }
  }

  /** The token, empty without security; null until approved. */
  token(master: MasterOfBoat): Promise<string | null> {
    if (this.host.currentMaster() !== master.id) {
      return Promise.resolve(null)
    }
    let token = this.asking.get(master.id)
    if (!token) {
      token = this.ask(master).finally(() => {
        this.asking.delete(master.id)
      })
      this.asking.set(master.id, token)
    }
    return token
  }

  private async ask(master: MasterOfBoat): Promise<string | null> {
    if (this.control && this.control.masterId !== master.id) {
      this.save(null)
    }
    if (this.control?.state === 'granted') {
      return this.control.token
    }
    if (this.control?.state === 'denied') {
      return null
    }
    const request = (): Promise<AccessRequestResult> =>
      requestAccess(
        master.access,
        this.requestId(),
        'Multihelm: send commands to the master from another station',
        'readwrite'
      )
    let result: AccessRequestResult
    try {
      result =
        this.control?.state === 'waiting-approval' && this.control.requestHref
          ? await pollAccess(master.access, this.control.requestHref)
          : await request()
      if (result.kind === 'gone') {
        result = await request()
      }
    } catch (error) {
      this.host.debug(`Multihelm: access request on the master: ${errorText(error)}`)
      return null
    }
    // The master moved on during the request: its answer must not replace the new master's access.
    if (this.host.currentMaster() !== master.id) {
      return null
    }
    switch (result.kind) {
      case 'no-security':
        this.save({ masterId: master.id, token: '', state: 'granted' })
        return ''
      case 'approved':
        this.save({ masterId: master.id, token: result.token, state: 'granted' })
        return result.token
      case 'pending':
        this.save({
          masterId: master.id,
          token: '',
          requestHref: result.href,
          state: 'waiting-approval'
        })
        return null
      case 'denied':
        // Asked again after a restart, as the user may have denied it by mistake.
        this.host.store.saveControlAccess(null)
        this.control = { masterId: master.id, token: '', state: 'denied' }
        return null
      case 'gone':
        this.save(null)
        return null
      case 'error':
        this.host.debug(`Multihelm: access request on the master: ${result.message}`)
        return null
    }
  }

  private save(access: ControlAccess | null): void {
    this.control = access
    this.host.store.saveControlAccess(access)
  }
}
