/**
 * This server's admin device token on itself, for writing what follows the
 * master through the server's own REST API: vessel settings, and which
 * plugins run. Asked for once; until the user approves it nothing is written.
 */

import { pollAccess, requestAccess, type AccessRequestResult } from './peer-client.js'
import type { MultihelmStore, OwnAccess } from './store.js'

export interface OwnAccessHost {
  store: MultihelmStore
  serverId: string
  /** This server, over loopback: `http(s)://127.0.0.1:<port>`. */
  ownUrl: () => string
  debug: (msg: string) => void
}

export class OwnServerAccess {
  private access: OwnAccess
  /** One request or poll at a time, shared by everyone waiting for the token. */
  private asking: Promise<string | null> | null = null

  constructor(private readonly host: OwnAccessHost) {
    this.access = host.store.loadOwnAccess()
  }

  /** Whether the user has to approve this server's own access request. */
  waitingForApproval(): boolean {
    return this.access.state === 'waiting-approval'
  }

  /**
   * Looks again at a request waiting for approval, which is otherwise done
   * only when there is something to write: one the server has forgotten is
   * replaced, so the settings never offer to approve a request that is gone.
   */
  recheck(): void {
    if (this.access.state === 'waiting-approval') {
      this.token().catch((error: unknown) => {
        this.host.debug(
          `Multihelm: access request on this server: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
  }

  /** The identifier of the access request on this server, as Security -> Access Requests lists it. */
  requestId(): string {
    return `signalk-multihelm-self-${this.host.serverId}`
  }

  /** Whether the user denied it; it is asked for again only after a restart. */
  denied(): boolean {
    return this.access.state === 'denied'
  }

  /** The server refused the token: it is asked for again. */
  revoked(): void {
    this.save({ token: '', state: 'none' })
  }

  /** The token, empty without security; null while there is none to use. */
  token(): Promise<string | null> {
    if (this.access.state === 'granted') {
      return Promise.resolve(this.access.token)
    }
    if (this.access.state === 'denied') {
      return Promise.resolve(null)
    }
    this.asking ??= this.ask().finally(() => {
      this.asking = null
    })
    return this.asking
  }

  private async ask(): Promise<string | null> {
    const base = this.host.ownUrl()
    const request = (): Promise<AccessRequestResult> =>
      requestAccess(
        { url: base },
        this.requestId(),
        'Multihelm: write the settings that follow the master on this server',
        'admin'
      )
    let result: AccessRequestResult
    try {
      result =
        this.access.state === 'waiting-approval' && this.access.requestHref
          ? await pollAccess({ url: base }, this.access.requestHref)
          : await request()
      if (result.kind === 'gone') {
        result = await request()
      }
    } catch (error) {
      this.host.debug(
        `Multihelm: access request on this server: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
    switch (result.kind) {
      case 'no-security':
        this.save({ token: '', state: 'granted' })
        return ''
      case 'approved':
        this.save({ token: result.token, state: 'granted' })
        return result.token
      case 'pending':
        this.save({ token: '', requestHref: result.href, state: 'waiting-approval' })
        return null
      case 'denied':
        this.host.store.saveOwnAccess({ token: '', state: 'none' })
        this.access = { token: '', state: 'denied' }
        return null
      case 'gone':
        this.save({ token: '', state: 'none' })
        return null
      case 'error':
        this.host.debug(`Multihelm: access request on this server: ${result.message}`)
        return null
    }
  }

  private save(access: OwnAccess): void {
    this.access = access
    this.host.store.saveOwnAccess(access)
  }
}
