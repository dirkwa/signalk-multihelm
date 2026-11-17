/**
 * Alarms are matched by path: each server gives its alarms ids of its own,
 * and stations on one NMEA 2000 bus raise the same alarm themselves.
 */

import { isDeepStrictEqual } from 'node:util'

import type {
  AlarmProperties,
  AlarmRaiseOptions,
  AlarmUpdateOptions,
  ALARM_STATE,
  NotificationId,
  NotificationsApi,
  Path,
  Value
} from '@signalk/server-api'

import type { MasterControlAccess, MasterOfBoat } from './master-control.js'
import { PeerHttpError, callPeer } from './peer-client.js'

export const NOTIFICATIONS_PATH = '/signalk/v2/api/notifications'
export const ALARMS_POLL_MS = 1_000
/** In the data of an alarm shown for the master: the master's server id, and its id for the alarm. */
export const FROM_MASTER = 'multihelmMaster'
export const MASTER_ALARM = 'multihelmMasterAlarm'

export interface LocalNotifications {
  list: () => Record<string, AlarmProperties>
  raise: (options: AlarmRaiseOptions) => NotificationId
  update: (id: NotificationId, options: AlarmUpdateOptions) => void
  clear: (id: NotificationId) => void
  silence: (id: NotificationId) => void
  acknowledge: (id: NotificationId) => void
}

/**
 * The server's Notifications API, while the server manages notifications:
 * older servers lack it, and with management off it still raises alarms but
 * can no longer clear, silence or acknowledge them.
 */
export function managedNotifications(api: unknown): LocalNotifications | null {
  const notifications = api as Partial<LocalNotifications & NotificationsApi> | undefined
  if (typeof notifications?.list !== 'function' || typeof notifications.getId !== 'function') {
    return null
  }
  try {
    notifications.getId('signalk-multihelm-probe' as NotificationId)
  } catch {
    return null
  }
  return notifications as LocalNotifications
}

export interface AlarmsHost {
  /** The master to follow; null when this server is the master or there is none. */
  master: () => MasterOfBoat | null
  control: MasterControlAccess
  notifications: LocalNotifications
  debug: (msg: string) => void
}

export interface Alarm {
  id: string
  path: string
  state: ALARM_STATE
  message: string
  data: Record<string, Value>
  silenced: boolean
  acknowledged: boolean
}

const ACTIVE = new Set(['alert', 'warn', 'alarm', 'emergency'])

function isActive(state: unknown): state is ALARM_STATE {
  return typeof state === 'string' && ACTIVE.has(state)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The active alarms in a Notifications API listing. */
export function activeAlarms(listing: unknown): Alarm[] {
  if (!isRecord(listing)) {
    return []
  }
  const alarms: Alarm[] = []
  for (const [id, entry] of Object.entries(listing)) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !isRecord(entry.value)) {
      continue
    }
    const value = entry.value
    const status = isRecord(value.status) ? value.status : {}
    if (!isActive(value.state)) {
      continue
    }
    alarms.push({
      id,
      path: entry.path,
      state: value.state,
      message: typeof value.message === 'string' ? value.message : '',
      data: isRecord(value.data) ? (value.data as Record<string, Value>) : {},
      silenced: status.silenced === true,
      acknowledged: status.acknowledged === true
    })
  }
  return alarms
}

function isMirror(alarm: Alarm): boolean {
  return typeof alarm.data[FROM_MASTER] === 'string'
}

function byPath(alarms: Alarm[]): Map<string, Alarm> {
  const paths = new Map<string, Alarm>()
  for (const alarm of alarms) {
    if (!paths.has(alarm.path)) {
      paths.set(alarm.path, alarm)
    }
  }
  return paths
}

type Action = 'silence' | 'acknowledge'

/** Where an alarm here was after the last pass, and for which alarm of which master. */
interface Seen {
  masterId: string
  theirId: string
  silenced: boolean
  acknowledged: boolean
  /** Given here, and not yet taken by the master. */
  unsent: Action | null
}

export class MasterAlarms {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false
  private seen = new Map<string, Seen>()

  constructor(private readonly host: AlarmsHost) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.sync()
    }, ALARMS_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
    this.clearMirrors(() => false)
  }

  /** One pass; never rejects. */
  async sync(): Promise<void> {
    if (this.running || this.stopped) {
      return
    }
    this.running = true
    try {
      await this.syncOnce()
    } catch (error) {
      this.host.debug(`Multihelm: the alarms from the master: ${errorText(error)}`)
    } finally {
      this.running = false
    }
  }

  private async syncOnce(): Promise<void> {
    const master = this.host.master()
    if (!master) {
      this.clearMirrors(() => false)
      return
    }
    // Before asking, so a new master that does not answer leaves no alarms of the old one sounding.
    this.clearMirrors((mirror) => mirror.data[FROM_MASTER] === master.id)
    const listing: unknown = await callPeer(
      'GET',
      master.access,
      NOTIFICATIONS_PATH,
      master.access.token
    )
    if (!this.stillFor(master)) {
      return
    }
    // A server that was a member a moment ago may still show another master's alarms.
    const theirs = byPath(activeAlarms(listing).filter((alarm) => !isMirror(alarm)))
    this.clearMirrors(
      (mirror) =>
        mirror.data[FROM_MASTER] === master.id &&
        mirror.data[MASTER_ALARM] === theirs.get(mirror.path)?.id
    )
    const seen = new Map<string, Seen>()
    for (const [path, alarm] of theirs) {
      if (!this.stillFor(master)) {
        return
      }
      try {
        const here = this.alarmHere(path, alarm, master.id)
        seen.set(here.id, await this.keepInStep(master, here, alarm))
      } catch (error) {
        this.host.debug(`Multihelm: the master's alarm ${path}: ${errorText(error)}`)
      }
    }
    this.seen = seen
  }

  private stillFor(master: MasterOfBoat): boolean {
    return !this.stopped && this.host.master()?.id === master.id
  }

  /**
   * This server's own alarm on the path, or the one shown for the master's.
   * Read again for each alarm, since the server may have raised one of its own while a send waited.
   */
  private alarmHere(path: string, theirs: Alarm, masterId: string): Alarm {
    const here = activeAlarms(this.host.notifications.list()).filter((a) => a.path === path)
    const own = here.find((alarm) => !isMirror(alarm))
    const mirror = here.find(isMirror)
    if (!own) {
      return this.mirrored(mirror, theirs, masterId)
    }
    if (mirror) {
      this.host.notifications.clear(mirror.id as NotificationId)
    }
    return own
  }

  /** The alarm shown here for the master's, made to show what the master's does. */
  private mirrored(mirror: Alarm | undefined, theirs: Alarm, masterId: string): Alarm {
    const notifications = this.host.notifications
    const data = { ...theirs.data, [FROM_MASTER]: masterId, [MASTER_ALARM]: theirs.id }
    const shown = { ...theirs, data, silenced: false, acknowledged: false }
    if (!mirror) {
      const id = notifications.raise({
        state: theirs.state,
        message: theirs.message,
        path: theirs.path as Path,
        data
      })
      return { ...shown, id }
    }
    if (
      mirror.state === theirs.state &&
      mirror.message === theirs.message &&
      isDeepStrictEqual(mirror.data, data)
    ) {
      return mirror
    }
    notifications.update(mirror.id as NotificationId, {
      state: theirs.state,
      message: theirs.message,
      data
    })
    // The server takes a silence and an acknowledgement off an alarm whose state changes.
    return mirror.state === theirs.state
      ? { ...mirror, message: theirs.message, data }
      : { ...shown, id: mirror.id }
  }

  /** Brings a silence or acknowledgement given on one side to the other; returns where this one is now. */
  private async keepInStep(master: MasterOfBoat, here: Alarm, theirs: Alarm): Promise<Seen> {
    const last = this.seen.get(here.id)
    const before = last?.masterId === master.id && last.theirId === theirs.id ? last : null
    const now: Seen = {
      masterId: master.id,
      theirId: theirs.id,
      silenced: here.silenced,
      acknowledged: here.acknowledged,
      unsent: null
    }
    const id = here.id as NotificationId
    if (theirs.acknowledged && !here.acknowledged) {
      this.host.notifications.acknowledge(id)
      return { ...now, acknowledged: true }
    }
    if (theirs.silenced && !here.silenced && !here.acknowledged) {
      this.host.notifications.silence(id)
      return { ...now, silenced: true }
    }
    if (!before) {
      return now
    }
    const unsent =
      here.acknowledged &&
      !theirs.acknowledged &&
      (!before.acknowledged || before.unsent === 'acknowledge')
        ? 'acknowledge'
        : here.silenced &&
            !theirs.silenced &&
            !theirs.acknowledged &&
            (!before.silenced || before.unsent === 'silence')
          ? 'silence'
          : null
    if (unsent && !(await this.sendToMaster(master, theirs, unsent))) {
      return { ...now, unsent }
    }
    return now
  }

  /** Whether the master took it. */
  private async sendToMaster(master: MasterOfBoat, alarm: Alarm, action: Action): Promise<boolean> {
    const token = await this.host.control.token(master)
    if (token === null || !this.stillFor(master)) {
      return false
    }
    try {
      await callPeer(
        'POST',
        master.access,
        `${NOTIFICATIONS_PATH}/${encodeURIComponent(alarm.id)}/${action}`,
        token
      )
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        this.host.control.revoked(master.id, token)
      }
      this.host.debug(
        `Multihelm: sending the ${action} of ${alarm.path} to the master: ${errorText(error)}`
      )
      return false
    }
    this.host.debug(`Multihelm: sent the ${action} of ${alarm.path} to the master`)
    return true
  }

  /** Takes off every alarm shown here for a master but those to keep. */
  private clearMirrors(keep: (mirror: Alarm) => boolean): void {
    const notifications = this.host.notifications
    for (const alarm of activeAlarms(notifications.list())) {
      if (isMirror(alarm) && !keep(alarm)) {
        try {
          notifications.clear(alarm.id as NotificationId)
        } catch (error) {
          this.host.debug(`Multihelm: clearing ${alarm.path}: ${errorText(error)}`)
        }
      }
    }
  }
}
