/**
 * The master's alarms on every server, silenced and acknowledged from any of
 * them. A server that is not the master reads the master's active alarms
 * each second and shows each one whose path it has no alarm of its own for,
 * as an alarm of its own raised through its Notifications API and marked as
 * the master's. An alarm on the same path that this server raises itself
 * (all servers on one NMEA 2000 bus see the same alarm) is left as it is and
 * only kept in step.
 *
 * Silencing or acknowledging here goes to the master, with the control token
 * there; whatever the master has silenced or acknowledged is then done here
 * too. Alarms are matched by path, as each server gives them ids of its own.
 * An alarm the master does not have stays this server's own business.
 */

import type {
  AlarmProperties,
  AlarmRaiseOptions,
  AlarmUpdateOptions,
  ALARM_STATE,
  NotificationId,
  Path,
  Value
} from '@signalk/server-api'

import type { MasterControlAccess, MasterOfBoat } from './master-control.js'
import { PeerHttpError, callPeer } from './peer-client.js'

export const NOTIFICATIONS_PATH = '/signalk/v2/api/notifications'
export const ALARMS_POLL_MS = 1_000
/** In the data of an alarm shown for the master: the master's server id. */
export const FROM_MASTER = 'multihelmMaster'

/** The part of the server's Notifications API that Multihelm uses. */
export interface LocalNotifications {
  list: () => Record<string, AlarmProperties>
  raise: (options: AlarmRaiseOptions) => NotificationId
  update: (id: NotificationId, options: AlarmUpdateOptions) => void
  clear: (id: NotificationId) => void
  silence: (id: NotificationId) => void
  acknowledge: (id: NotificationId) => void
}

export interface AlarmsHost {
  /** The master to follow; null when this server is the master or there is none. */
  master: () => MasterOfBoat | null
  control: MasterControlAccess
  notifications: LocalNotifications
  debug: (msg: string) => void
}

/** One alarm, as far as keeping it in step goes. */
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

export class MasterAlarms {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false
  /** What each alarm here was after the last pass, to tell a silence or acknowledgement given here since. */
  private seen = new Map<string, { silenced: boolean; acknowledged: boolean }>()

  constructor(private readonly host: AlarmsHost) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.sync()
    }, ALARMS_POLL_MS)
  }

  /** Stops, and takes the master's alarms off this server. */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
    this.clearMirrors(new Map(), null)
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
      this.clearMirrors(new Map(), null)
      return
    }
    const listing: unknown = await callPeer(
      'GET',
      master.access,
      NOTIFICATIONS_PATH,
      master.access.token
    )
    if (this.stopped || this.host.master()?.id !== master.id) {
      return
    }
    // A server that was a member a moment ago may still show another master's alarms.
    const theirs = byPath(activeAlarms(listing).filter((alarm) => !isMirror(alarm)))
    const ours = activeAlarms(this.host.notifications.list())
    const own = byPath(ours.filter((alarm) => !isMirror(alarm)))
    this.clearMirrors(theirs, master.id, own)
    const mirrors = byPath(activeAlarms(this.host.notifications.list()).filter(isMirror))
    const seen = new Map<string, { silenced: boolean; acknowledged: boolean }>()
    for (const [path, alarm] of theirs) {
      try {
        const here = own.get(path) ?? this.mirrored(mirrors.get(path), alarm, master.id)
        if (here) {
          seen.set(here.id, await this.keepInStep(master, here, alarm))
        }
      } catch (error) {
        this.host.debug(`Multihelm: the master's alarm ${path}: ${errorText(error)}`)
      }
    }
    this.seen = seen
  }

  /** The alarm shown here for the master's, once it shows what the master's does. */
  private mirrored(mirror: Alarm | undefined, theirs: Alarm, masterId: string): Alarm | null {
    const notifications = this.host.notifications
    const data = { ...theirs.data, [FROM_MASTER]: masterId }
    if (!mirror) {
      notifications.raise({
        state: theirs.state,
        message: theirs.message,
        path: theirs.path as Path,
        data
      })
      return null
    }
    if (mirror.state !== theirs.state || mirror.message !== theirs.message) {
      notifications.update(mirror.id as NotificationId, {
        state: theirs.state,
        message: theirs.message,
        data
      })
      return null
    }
    return mirror
  }

  /** Brings a silence or acknowledgement given on one side to the other; returns what this one is now. */
  private async keepInStep(
    master: MasterOfBoat,
    here: Alarm,
    theirs: Alarm
  ): Promise<{ silenced: boolean; acknowledged: boolean }> {
    const before = this.seen.get(here.id)
    const now = { silenced: here.silenced, acknowledged: here.acknowledged }
    const id = here.id as NotificationId
    if (theirs.acknowledged && !here.acknowledged) {
      this.host.notifications.acknowledge(id)
      return { silenced: here.silenced, acknowledged: true }
    }
    if (theirs.silenced && !here.silenced && !here.acknowledged) {
      this.host.notifications.silence(id)
      return { silenced: true, acknowledged: false }
    }
    if (!before) {
      return now
    }
    if (here.acknowledged && !before.acknowledged && !theirs.acknowledged) {
      await this.sendToMaster(master, theirs, 'acknowledge')
    } else if (here.silenced && !before.silenced && !theirs.silenced && !theirs.acknowledged) {
      await this.sendToMaster(master, theirs, 'silence')
    }
    return now
  }

  private async sendToMaster(
    master: MasterOfBoat,
    alarm: Alarm,
    action: 'silence' | 'acknowledge'
  ): Promise<void> {
    const token = await this.host.control.token(master)
    if (token === null || this.stopped || this.host.master()?.id !== master.id) {
      return
    }
    try {
      await callPeer(
        'POST',
        master.access,
        `${NOTIFICATIONS_PATH}/${encodeURIComponent(alarm.id)}/${action}`,
        token
      )
      this.host.debug(`Multihelm: sent the ${action} of ${alarm.path} to the master`)
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        this.host.control.revoked(master.id, token)
      }
      throw error
    }
  }

  /**
   * Takes off the alarms shown for a master that no longer has them, for
   * another master, or where this server has an alarm of its own on the path.
   */
  private clearMirrors(
    theirs: Map<string, Alarm>,
    masterId: string | null,
    own: Map<string, Alarm> = new Map()
  ): void {
    const notifications = this.host.notifications
    for (const alarm of activeAlarms(notifications.list())) {
      if (
        isMirror(alarm) &&
        (alarm.data[FROM_MASTER] !== masterId || !theirs.has(alarm.path) || own.has(alarm.path))
      ) {
        try {
          notifications.clear(alarm.id as NotificationId)
        } catch (error) {
          this.host.debug(`Multihelm: clearing ${alarm.path}: ${errorText(error)}`)
        }
      }
    }
  }
}
