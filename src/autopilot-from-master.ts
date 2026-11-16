/**
 * On a server that is not the master: the master's autopilot, served by this
 * server's Autopilot API. Multihelm registers itself as the autopilot
 * provider here and sends every command on to the master's Autopilot API, so
 * a chartplotter at any station operates the one autopilot the master drives,
 * and only the master sends to it. Its state is read from the master every
 * second and published here as the provider's update.
 *
 * Reading uses the readonly pairing token; commands need a readwrite device
 * token on the master, asked for once when the master is first found to have
 * an autopilot, and approved by the user under Security -> Access Requests
 * there.
 */

import { isDeepStrictEqual } from 'node:util'

import type {
  AutopilotInfo,
  AutopilotProvider,
  TackGybeDirection,
  Value
} from '@signalk/server-api'

import type { MasterAccess } from './master-proxy.js'
import {
  PeerHttpError,
  callPeer,
  pollAccess,
  requestAccess,
  type AccessRequestResult
} from './peer-client.js'
import type { ControlAccess, MultihelmStore } from './store.js'

export const AUTOPILOTS_PATH = '/signalk/v2/api/vessels/self/autopilots'
export const STATE_POLL_MS = 1_000
export const DEVICES_POLL_MS = 10_000

export interface MasterOfBoat {
  id: string
  access: MasterAccess
}

export interface AutopilotHost {
  store: MultihelmStore
  serverId: string
  /** The master to send to; null when this server is the master or there is none. */
  master: () => MasterOfBoat | null
  /** Whether this server is the master: its own autopilot provider serves, never this one. */
  isMaster: () => boolean
  register: (provider: AutopilotProvider, devices: string[]) => void
  unregister: () => void
  update: (deviceId: string, info: Record<string, Value>) => void
  debug: (msg: string) => void
  error: (msg: string) => void
}

/** What the server's Autopilot API makes of a provider's rejection: its status and message. */
export class AutopilotError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The provider answers in the shape the server hands on, so the master's answer passes as it is. */
function asInfo(value: unknown): AutopilotInfo {
  if (!isRecord(value)) {
    throw new AutopilotError(502, 'the master sent no autopilot data')
  }
  return value as unknown as AutopilotInfo
}

function valueOf(answer: unknown): unknown {
  return isRecord(answer) ? answer.value : undefined
}

export class MasterAutopilot {
  private registered = false
  private devices: string[] = []
  private readonly published = new Map<string, Record<string, Value>>()
  private control: ControlAccess | null
  private stateTimer: NodeJS.Timeout | null = null
  private devicesTimer: NodeJS.Timeout | null = null
  private polling = false

  constructor(private readonly host: AutopilotHost) {
    this.control = host.store.loadControlAccess()
  }

  start(): void {
    this.devicesTimer = setInterval(() => {
      void this.findDevices()
    }, DEVICES_POLL_MS)
    this.stateTimer = setInterval(() => {
      void this.pollState()
    }, STATE_POLL_MS)
    void this.findDevices()
  }

  stop(): void {
    for (const timer of [this.devicesTimer, this.stateTimer]) {
      if (timer) {
        clearInterval(timer)
      }
    }
    this.devicesTimer = null
    this.stateTimer = null
  }

  /**
   * Called when the role changes. On the master its own provider must have
   * the devices, so this one steps aside before that provider starts.
   */
  roleChanged(): void {
    if (this.host.isMaster()) {
      this.withdraw()
    } else {
      void this.findDevices()
    }
  }

  /** The user has to approve this server's request on the master to send it commands. */
  waitingForApproval(): { masterId: string; request: string } | null {
    return this.control?.state === 'waiting-approval'
      ? { masterId: this.control.masterId, request: this.requestId() }
      : null
  }

  requestId(): string {
    return `signalk-multihelm-control-${this.host.serverId}`
  }

  async findDevices(): Promise<void> {
    if (this.host.isMaster()) {
      this.withdraw()
      return
    }
    const master = this.host.master()
    if (!master) {
      return
    }
    let answer: unknown
    try {
      answer = await callPeer('GET', master.access, AUTOPILOTS_PATH, master.access.token)
    } catch (error) {
      this.host.debug(`Multihelm: the master's autopilots: ${errorText(error)}`)
      return
    }
    const devices = isRecord(answer) ? Object.keys(answer).sort() : []
    if (devices.length === 0 || this.host.isMaster()) {
      return
    }
    this.devices = devices
    // Again each time: a device this server's own provider held until it stopped is free now.
    this.host.register(this.provider, devices)
    this.registered = true
    await this.controlToken(master)
  }

  async pollState(): Promise<void> {
    const master = this.host.master()
    if (this.polling || !this.registered || !master) {
      return
    }
    this.polling = true
    try {
      for (const device of this.devices) {
        let info: AutopilotInfo
        try {
          info = asInfo(await this.read(master, device, ''))
        } catch (error) {
          this.host.debug(
            `Multihelm: the state of the master's autopilot ${device}: ${errorText(error)}`
          )
          continue
        }
        const update: Record<string, Value> = {
          state: info.state,
          mode: info.mode,
          target: info.target,
          engaged: info.engaged
        }
        const actions = (info.options as { actions?: unknown } | undefined)?.actions
        if (Array.isArray(actions)) {
          update.actions = actions as Value
        }
        if (!isDeepStrictEqual(this.published.get(device), update)) {
          this.published.set(device, update)
          this.host.update(device, update)
        }
      }
    } finally {
      this.polling = false
    }
  }

  private withdraw(): void {
    if (this.registered) {
      this.host.unregister()
      this.registered = false
      this.published.clear()
    }
  }

  private masterOrFail(): MasterOfBoat {
    const master = this.host.isMaster() ? null : this.host.master()
    if (!master) {
      throw new AutopilotError(503, 'no other server is the master now')
    }
    return master
  }

  private async read(master: MasterOfBoat, device: string, rest: string): Promise<unknown> {
    try {
      return await callPeer(
        'GET',
        master.access,
        `${AUTOPILOTS_PATH}/${encodeURIComponent(device)}${rest}`,
        master.access.token
      )
    } catch (error) {
      throw this.asAutopilotError(error)
    }
  }

  private async send(
    method: 'POST' | 'PUT' | 'DELETE',
    device: string,
    rest: string,
    body?: unknown
  ): Promise<void> {
    const master = this.masterOrFail()
    const token = await this.controlToken(master)
    if (token === null) {
      throw new AutopilotError(
        403,
        `approve Multihelm's request "${this.requestId()}" under Security -> Access Requests on the master to steer from this station`
      )
    }
    try {
      await callPeer(
        method,
        master.access,
        `${AUTOPILOTS_PATH}/${encodeURIComponent(device)}${rest}`,
        token,
        body
      )
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        this.saveControl(null)
      }
      throw this.asAutopilotError(error)
    }
    void this.pollState()
  }

  private asAutopilotError(error: unknown): AutopilotError {
    if (error instanceof AutopilotError) {
      return error
    }
    const status = error instanceof PeerHttpError ? error.status : 502
    return new AutopilotError(status, `the master's autopilot: ${errorText(error)}`)
  }

  private saveControl(access: ControlAccess | null): void {
    this.control = access
    this.host.store.saveControlAccess(access)
  }

  /** The readwrite token on the master, asked for when there is none; null until approved. */
  private async controlToken(master: MasterOfBoat): Promise<string | null> {
    if (this.control && this.control.masterId !== master.id) {
      this.saveControl(null)
    }
    if (this.control?.state === 'granted') {
      return this.control.token
    }
    if (this.control?.state === 'denied') {
      return null
    }
    let result: AccessRequestResult
    try {
      result =
        this.control?.state === 'waiting-approval' && this.control.requestHref
          ? await pollAccess(master.access, this.control.requestHref)
          : await requestAccess(
              master.access,
              this.requestId(),
              "Multihelm: operate the master's autopilot from another station",
              'readwrite'
            )
    } catch (error) {
      this.host.debug(`Multihelm: access request on the master: ${errorText(error)}`)
      return null
    }
    switch (result.kind) {
      case 'no-security':
        this.saveControl({ masterId: master.id, token: '', state: 'granted' })
        return ''
      case 'approved':
        this.saveControl({ masterId: master.id, token: result.token, state: 'granted' })
        return result.token
      case 'pending':
        this.saveControl({
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
      case 'error':
        this.host.debug(`Multihelm: access request on the master: ${result.message}`)
        return null
    }
  }

  private readonly provider: AutopilotProvider = {
    getData: async (device) => asInfo(await this.read(this.masterOrFail(), device, '')),
    getState: async (device) =>
      (valueOf(await this.read(this.masterOrFail(), device, '/state')) as string | null) ?? null,
    getMode: async (device) =>
      (valueOf(await this.read(this.masterOrFail(), device, '/mode')) as string | null) ?? null,
    getTarget: async (device) =>
      (valueOf(await this.read(this.masterOrFail(), device, '/target')) as number | null) ?? null,
    setState: (state, device) => this.send('PUT', device, '/state', { value: state }),
    setMode: (mode, device) => this.send('PUT', device, '/mode', { value: mode }),
    setTarget: (value, device) => this.send('PUT', device, '/target', { value, units: 'rad' }),
    adjustTarget: (value, device) =>
      this.send('PUT', device, '/target/adjust', { value, units: 'rad' }),
    engage: (device) => this.send('POST', device, '/engage'),
    disengage: (device) => this.send('POST', device, '/disengage'),
    courseCurrentPoint: (device) => this.send('POST', device, '/courseCurrentPoint'),
    courseNextPoint: (device) => this.send('POST', device, '/courseNextPoint'),
    tack: (direction: TackGybeDirection, device) => this.send('POST', device, `/tack/${direction}`),
    gybe: (direction: TackGybeDirection, device) => this.send('POST', device, `/gybe/${direction}`),
    // The server maps POST to 0 (dodge on) and DELETE to null (dodge off); a PUT steers by the value.
    dodge: (value, device) =>
      value === null
        ? this.send('DELETE', device, '/dodge')
        : value === 0
          ? this.send('POST', device, '/dodge')
          : this.send('PUT', device, '/dodge', { value, units: 'rad' })
  }
}
