/**
 * The active destination or route, the same on every server: a server that
 * is not the master takes the master's course over, and a change made here
 * (a destination set at this station, the next point of the route) is sent
 * to the master, which all the others then take over. What is kept in step
 * is the setting itself, never the action that led to it, so two servers
 * that both move on to the next point at an arrival end on the same point.
 *
 * Both servers are read each second through their Course API. This server's
 * course is written with its own admin token, the master's with the control
 * token there. Each server works out the rest of the course (bearings, XTE)
 * from its own position; the start of a leg from the vessel position is
 * where that server was when it took the course over.
 */

import { isDeepStrictEqual } from 'node:util'

import type { MasterControlAccess, MasterOfBoat } from './master-control.js'
import type { OwnServerAccess } from './own-access.js'
import { PeerHttpError, callPeer, callServer } from './peer-client.js'

export const COURSE_PATH = '/signalk/v2/api/vessels/self/navigation/course'
export const COURSE_POLL_MS = 1_000

interface Position {
  latitude: number
  longitude: number
}

/** The part of a course the user sets. */
export interface CourseSetting {
  route: { href: string; pointIndex: number; reverse: boolean } | null
  /** The destination when no route is active. */
  point: { href: string } | { position: Position } | null
  arrivalCircle: number
  targetArrivalTime: string | null
}

type Call = (method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<unknown>

export interface CourseHost {
  /** The master to follow; null when this server is the master or there is none. */
  master: () => MasterOfBoat | null
  control: MasterControlAccess
  own: OwnServerAccess
  /** This server, over loopback: `http(s)://127.0.0.1:<port>`. */
  ownUrl: () => string
  debug: (msg: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asPosition(value: unknown): Position | null {
  return isRecord(value) &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number'
    ? { latitude: value.latitude, longitude: value.longitude }
    : null
}

/** The setting in a Course API answer; null for an answer that is not one. */
export function courseSetting(raw: unknown): CourseSetting | null {
  if (!isRecord(raw)) {
    return null
  }
  const active = raw.activeRoute
  const next = raw.nextPoint
  let route: CourseSetting['route'] = null
  let point: CourseSetting['point'] = null
  if (isRecord(active) && typeof active.href === 'string') {
    route = {
      href: active.href,
      pointIndex: typeof active.pointIndex === 'number' ? active.pointIndex : 0,
      reverse: active.reverse === true
    }
  } else if (isRecord(next)) {
    const position = asPosition(next.position)
    point = typeof next.href === 'string' ? { href: next.href } : position ? { position } : null
  }
  return {
    route,
    point,
    arrivalCircle: typeof raw.arrivalCircle === 'number' ? raw.arrivalCircle : 0,
    targetArrivalTime: typeof raw.targetArrivalTime === 'string' ? raw.targetArrivalTime : null
  }
}

/** Makes the course `call` reaches, now `from`, into `to`. */
export async function writeCourse(
  call: Call,
  from: CourseSetting,
  to: CourseSetting
): Promise<void> {
  let cleared = false
  if (to.route) {
    if (!isDeepStrictEqual(from.route, to.route)) {
      await call('PUT', '/activeRoute', { ...to.route, arrivalCircle: to.arrivalCircle })
    }
  } else if (to.point) {
    if (from.route || !isDeepStrictEqual(from.point, to.point)) {
      await call('PUT', '/destination', { ...to.point, arrivalCircle: to.arrivalCircle })
    }
  } else if (from.route || from.point) {
    await call('DELETE', '')
    cleared = true
  }
  if (from.arrivalCircle !== to.arrivalCircle) {
    await call('PUT', '/arrivalCircle', { value: to.arrivalCircle })
  }
  // Clearing the course clears its arrival time too.
  if ((cleared ? null : from.targetArrivalTime) !== to.targetArrivalTime) {
    await call('PUT', '/targetArrivalTime', { value: to.targetArrivalTime })
  }
}

export class MasterCourse {
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** The course both servers last agreed on, and the master it was agreed with. */
  private agreed: { masterId: string; course: CourseSetting } | null = null
  /** A course set here whose sending to the master has not completed: sent again while it stays. */
  private sending: { masterId: string; course: CourseSetting } | null = null
  private stopped = false

  constructor(private readonly host: CourseHost) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.sync()
    }, COURSE_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
  }

  /** One pass; never rejects. */
  async sync(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      await this.syncOnce()
    } catch (error) {
      this.host.debug(`Multihelm: the course from the master: ${errorText(error)}`)
    } finally {
      this.running = false
    }
  }

  private async syncOnce(): Promise<void> {
    const master = this.host.master()
    if (!master) {
      this.agreed = null
      this.sending = null
      return
    }
    const ownToken = await this.host.own.token()
    if (ownToken === null) {
      return
    }
    const here = this.ownCall(ownToken)
    const refusedHere = (): void => {
      this.host.own.revoked()
    }
    const theirs = await this.readMaster(master)
    const ours = courseSetting(await this.guarded(() => here('GET', ''), refusedHere))
    if (!theirs || !ours || !this.stillFor(master)) {
      return
    }
    const agreed = this.agreed?.masterId === master.id ? this.agreed.course : null
    if (isDeepStrictEqual(ours, theirs)) {
      this.agreed = { masterId: master.id, course: theirs }
      this.sending = null
      return
    }
    const resend =
      this.sending?.masterId === master.id && isDeepStrictEqual(this.sending.course, ours)
    // Changed here alone, or still on its way: the master takes it over. Otherwise the master's course holds.
    if (resend || (agreed && isDeepStrictEqual(theirs, agreed))) {
      await this.send(master, ours, resend ? null : agreed)
      return
    }
    this.sending = null
    await this.guarded(() => writeCourse(here, ours, theirs), refusedHere)
    this.agreed = { masterId: master.id, course: theirs }
    this.host.debug("Multihelm: took the master's course over")
  }

  /** Sends `ours` to the master, if the master's course is still `expected` (any, when null). */
  private async send(
    master: MasterOfBoat,
    ours: CourseSetting,
    expected: CourseSetting | null
  ): Promise<void> {
    const controlToken = await this.host.control.token(master)
    if (controlToken === null) {
      return
    }
    const theirs = await this.readMaster(master)
    if (!theirs || !this.stillFor(master) || (expected && !isDeepStrictEqual(theirs, expected))) {
      return
    }
    this.sending = { masterId: master.id, course: ours }
    await this.guarded(
      () => writeCourse(this.masterCall(master, controlToken), theirs, ours),
      () => {
        this.host.control.revoked(master.id, controlToken)
      }
    )
    this.sending = null
    this.agreed = { masterId: master.id, course: ours }
    this.host.debug('Multihelm: sent the course set here to the master')
  }

  private async readMaster(master: MasterOfBoat): Promise<CourseSetting | null> {
    return courseSetting(await callPeer('GET', master.access, COURSE_PATH, master.access.token))
  }

  /** Whether a pass begun for `master` may still write: not stopped, and the master unchanged. */
  private stillFor(master: MasterOfBoat): boolean {
    return !this.stopped && this.host.master()?.id === master.id
  }

  private async guarded<T>(work: () => Promise<T>, refused: () => void): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        refused()
      }
      throw error
    }
  }

  private ownCall(token: string): Call {
    return (method, path, body) =>
      callServer(method, `${this.host.ownUrl()}${COURSE_PATH}${path}`, token, body)
  }

  private masterCall(master: MasterOfBoat, token: string): Call {
    return (method, path, body) =>
      callPeer(method, master.access, `${COURSE_PATH}${path}`, token, body)
  }
}
