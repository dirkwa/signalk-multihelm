/**
 * Values only one server sees, such as engine data from a bus of its own,
 * shared with the boat's other servers. A server serves what it shares as a
 * stream of deltas at `shared-data`; each other server reads it with its
 * pairing token and puts the values in under the source
 * `multihelm.<server>-<id>.<source>`. Values under such a source are never shared
 * again, so nothing goes round in circles, and no master is involved, so a
 * change of master changes nothing here.
 */

import type http from 'node:http'

import type { Request, Response } from 'express'

import type { PeerAddress } from './peer-client.js'

export const SHARED_DATA_ROUTE = '/shared-data'
export const SHARED_SOURCE_PREFIX = 'multihelm.'
/** Values are sent at most this often per path and source, the latest one. */
export const SHARE_INTERVAL_MS = 1_000
/** A stream with nothing to send says so this often, so a dead one is noticed. */
export const HEARTBEAT_MS = 15_000
export const RECONNECT_MIN_MS = 5_000
const RECONNECT_MAX_MS = 60_000
const MAX_EVENT_LENGTH = 1_000_000
/** Events are sent in pieces this size, well within what a receiver takes. */
const SENT_EVENT_LENGTH = 200_000
/** A peer that lets this much pile up unread is dropped; it opens the stream again. */
export const MAX_QUEUED_BYTES = 1_000_000
/** Of a path's metadata, what a server needs to show a value it does not know. */
const META_FIELDS = ['units', 'description', 'displayName'] as const

export interface SharedUpdate {
  $source: string
  timestamp: string
  values: { path: string; value: unknown }[]
  meta?: { path: string; value: Record<string, unknown> }[]
}

export interface ShareSettings {
  paths: string[]
  /** Data connection ids: every value whose source is one of them is shared. */
  connections: string[]
}

export interface SharingPeer extends PeerAddress {
  id: string
  name: string
  /** Empty when the peer runs without security. */
  token: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Signal K path patterns: `*` stands for any run of characters. */
export function pathMatcher(patterns: string[]): (path: string) => boolean {
  const expressions = patterns.map(
    (p) => new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`)
  )
  return (path) => expressions.some((e) => e.test(path))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** The settings as the user typed them, without blanks. */
export function shareSettings(paths: unknown, connections: unknown): ShareSettings {
  const clean = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter(Boolean)
      : []
  return { paths: clean(paths), connections: clean(connections) }
}

/** A part of a `$source`: letters, digits, `_`, `-`, and `.` where `dots` allows. */
function sourcePart(text: string, dots: boolean): string {
  return text.replace(dots ? /[^\w.-]/g : /[^\w-]/g, '-') || '-'
}

/** Servers left with the default host name share it, so the server id goes along. */
export function sharedSource(server: { id: string; name: string }, source: string): string {
  const id = sourcePart(server.id, false)
  return `${SHARED_SOURCE_PREFIX}${sourcePart(server.name, false)}-${id}.${sourcePart(source, true)}`
}

interface Client {
  res: Response
  /** Path → the metadata last sent for it on this stream. */
  metaSent: Map<string, string>
}

export interface SharerHost {
  settings: ShareSettings
  /** Multihelm itself, whose own values (the master's alarms, for one) are never shared. */
  selfId: string
  /** The metadata of a path of this vessel, as the server holds it. */
  meta: (path: string) => unknown
}

export interface SharedValue {
  $source: string
  timestamp: string
  path: string
  value: unknown
}

/** One update per source and timestamp. */
function grouped(values: Iterable<SharedValue>): SharedUpdate[] {
  const updates = new Map<string, SharedUpdate>()
  for (const { $source, timestamp, path, value } of values) {
    const key = `${$source}\n${timestamp}`
    let update = updates.get(key)
    if (!update) {
      update = { $source, timestamp, values: [] }
      updates.set(key, update)
    }
    update.values.push({ path, value })
  }
  return [...updates.values()]
}

/**
 * The updates as events of at most `SENT_EVENT_LENGTH`; an update too long
 * goes one value at a time, and a single value too long for any event is
 * left out, since no receiver would take it.
 */
export function events(
  updates: SharedUpdate[],
  dropped: (path: string) => void = () => undefined
): string[] {
  const out: string[] = []
  let batch: string[] = []
  let length = 0
  const close = (): void => {
    if (batch.length > 0) {
      out.push(`data: {"updates":[${batch.join(',')}]}\n\n`)
      batch = []
      length = 0
    }
  }
  const add = (text: string): void => {
    if (length + text.length > SENT_EVENT_LENGTH) {
      close()
    }
    batch.push(text)
    length += text.length + 1
  }
  for (const update of updates) {
    const text = JSON.stringify(update)
    if (text.length <= SENT_EVENT_LENGTH) {
      add(text)
      continue
    }
    for (const v of update.values) {
      const meta = update.meta?.filter((m) => m.path === v.path) ?? []
      const one = JSON.stringify({
        $source: update.$source,
        timestamp: update.timestamp,
        values: [v],
        ...(meta.length > 0 ? { meta } : {})
      })
      if (one.length <= SENT_EVENT_LENGTH) {
        add(one)
      } else {
        dropped(v.path)
      }
    }
  }
  close()
  return out
}

/** The serving side: collects the values to share and streams them to every peer reading. */
export class DataSharer {
  private readonly matches: (path: string) => boolean
  private readonly pending = new Map<string, SharedValue>()
  /** The last value of every path and source, for a peer that begins to read. */
  private readonly latest = new Map<string, SharedValue>()
  private readonly clients = new Set<Client>()
  private readonly flushTimer: NodeJS.Timeout
  private readonly heartbeatTimer: NodeJS.Timeout

  constructor(private readonly host: SharerHost) {
    this.matches = pathMatcher(host.settings.paths)
    this.flushTimer = setInterval(() => {
      this.flush()
    }, SHARE_INTERVAL_MS)
    this.heartbeatTimer = setInterval(() => {
      this.write(':\n\n')
    }, HEARTBEAT_MS)
  }

  shares(): boolean {
    return this.host.settings.paths.length > 0 || this.host.settings.connections.length > 0
  }

  /** The paths to subscribe to on this server. */
  subscribePaths(): string[] {
    return this.host.settings.connections.length > 0 ? ['*'] : this.host.settings.paths
  }

  /** One update of this vessel's deltas, as the server's subscription hands it over. */
  offer(update: unknown): void {
    if (!isPlainObject(update)) {
      return
    }
    const source = update.$source
    const values = update.values
    if (typeof source !== 'string' || !Array.isArray(values) || !this.mayShare(source)) {
      return
    }
    const timestamp =
      typeof update.timestamp === 'string' ? update.timestamp : new Date().toISOString()
    const ofConnection = this.fromConnection(source)
    for (const entry of values) {
      if (!isPlainObject(entry) || typeof entry.path !== 'string' || entry.value === undefined) {
        continue
      }
      if (ofConnection || this.matches(entry.path)) {
        const key = `${source}\n${entry.path}`
        const shared = { $source: source, timestamp, path: entry.path, value: entry.value }
        this.latest.set(key, shared)
        if (this.clients.size > 0) {
          this.pending.set(key, shared)
        }
      }
    }
  }

  private mayShare(source: string): boolean {
    const self = this.host.selfId
    return (
      !source.startsWith(SHARED_SOURCE_PREFIX) && source !== self && !source.startsWith(`${self}.`)
    )
  }

  private fromConnection(source: string): boolean {
    return this.host.settings.connections.some((c) => source === c || source.startsWith(`${c}.`))
  }

  serve(req: Request, res: Response): void {
    if (!this.shares()) {
      res.status(404).json({ error: 'this server shares no data' })
      return
    }
    // no-transform keeps the server's compression from holding the stream back.
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.flushHeaders()
    res.write(':\n\n')
    const client: Client = { res, metaSent: new Map() }
    this.clients.add(client)
    req.on('close', () => {
      this.clients.delete(client)
    })
    if (this.latest.size > 0) {
      // The replay is no more than what this server keeps anyway, so it is not held to the queue limit.
      this.sendUpdates(client, grouped(this.latest.values()), true)
    }
  }

  /** Sends what came in since the last time. */
  flush(): void {
    if (this.pending.size === 0) {
      return
    }
    const updates = grouped(this.pending.values())
    this.pending.clear()
    for (const client of this.clients) {
      this.sendUpdates(client, updates)
    }
  }

  private sendUpdates(client: Client, updates: SharedUpdate[], replay = false): void {
    const sending = new Map<string, string>()
    const pieces = updates.map((u) => this.withMeta(u, client.metaSent, sending))
    const out = events(pieces, (path) => sending.delete(path))
    for (const [path, text] of sending) {
      client.metaSent.set(path, text)
    }
    for (const event of out) {
      this.send(client, event, replay)
    }
  }

  /** A path's metadata goes along with a value whenever it differs from what this stream last got. */
  private withMeta(
    update: SharedUpdate,
    sent: ReadonlyMap<string, string>,
    sending: Map<string, string>
  ): SharedUpdate {
    const meta: NonNullable<SharedUpdate['meta']> = []
    for (const { path } of update.values) {
      const known = this.host.meta(path)
      if (!isPlainObject(known)) {
        continue
      }
      const value: Record<string, unknown> = {}
      for (const field of META_FIELDS) {
        if (known[field] !== undefined) {
          value[field] = known[field]
        }
      }
      const text = JSON.stringify(value)
      if (Object.keys(value).length > 0 && sent.get(path) !== text) {
        sending.set(path, text)
        meta.push({ path, value })
      }
    }
    return meta.length > 0 ? { ...update, meta } : update
  }

  private write(text: string): void {
    for (const client of this.clients) {
      this.send(client, text)
    }
  }

  private send(client: Client, text: string, replay = false): void {
    if (!replay && client.res.writableLength > MAX_QUEUED_BYTES) {
      this.clients.delete(client)
      client.res.destroy()
      return
    }
    client.res.write(text)
  }

  stop(): void {
    clearInterval(this.flushTimer)
    clearInterval(this.heartbeatTimer)
    for (const client of this.clients) {
      client.res.end()
    }
    this.clients.clear()
    this.pending.clear()
    this.latest.clear()
  }
}

/** A peer's delta, checked and put under that peer's source; what does not fit is left out. */
export function relabel(server: { id: string; name: string }, delta: unknown): SharedUpdate[] {
  if (!isPlainObject(delta) || !Array.isArray(delta.updates)) {
    return []
  }
  const updates: SharedUpdate[] = []
  for (const update of delta.updates) {
    if (
      !isPlainObject(update) ||
      typeof update.$source !== 'string' ||
      update.$source.startsWith(SHARED_SOURCE_PREFIX) ||
      typeof update.timestamp !== 'string' ||
      !Array.isArray(update.values)
    ) {
      continue
    }
    const values = update.values.filter(
      (v): v is { path: string; value: unknown } =>
        isPlainObject(v) && typeof v.path === 'string' && v.path !== '' && v.value !== undefined
    )
    const meta = Array.isArray(update.meta)
      ? update.meta.filter(
          (m): m is { path: string; value: Record<string, unknown> } =>
            isPlainObject(m) && typeof m.path === 'string' && isPlainObject(m.value)
        )
      : []
    if (values.length === 0 && meta.length === 0) {
      continue
    }
    updates.push({
      $source: sharedSource(server, update.$source),
      timestamp: update.timestamp,
      values: values.map(({ path, value }) => ({ path, value })),
      ...(meta.length > 0 ? { meta: meta.map(({ path, value }) => ({ path, value })) } : {})
    })
  }
  return updates
}

/**
 * A value this server has from a source of its own, such as the same bus
 * seen by two stations, is not taken a second time; the shared one stands
 * in once the own source has been quiet this long.
 */
export const OWN_SOURCE_FRESH_MS = 30_000

function hasFreshOwnSource(node: unknown, now: number): boolean {
  if (!isPlainObject(node)) {
    return false
  }
  const sources = isPlainObject(node.values)
    ? Object.entries(node.values).map(([source, v]) => [
        source,
        isPlainObject(v) ? v.timestamp : undefined
      ])
    : [[node.$source, node.timestamp]]
  return sources.some(
    ([source, timestamp]) =>
      typeof source === 'string' &&
      !source.startsWith(SHARED_SOURCE_PREFIX) &&
      typeof timestamp === 'string' &&
      // A clock ahead must not keep an own source fresh long after it went quiet.
      Math.abs(now - Date.parse(timestamp)) <= OWN_SOURCE_FRESH_MS
  )
}

/** The fields of `meta` this server has no metadata for yet. */
function missingMeta(
  meta: NonNullable<SharedUpdate['meta']>,
  local: (path: string) => unknown
): NonNullable<SharedUpdate['meta']> {
  const missing: NonNullable<SharedUpdate['meta']> = []
  for (const { path, value } of meta) {
    const node = local(path)
    const own = isPlainObject(node) && isPlainObject(node.meta) ? node.meta : {}
    const fields = Object.entries(value).filter(([field]) => own[field] === undefined)
    if (fields.length > 0) {
      missing.push({ path, value: Object.fromEntries(fields) })
    }
  }
  return missing
}

/**
 * Leaves out the values this server has a fresh source of its own for, each
 * handed to `held`, and the metadata fields it has already.
 */
export function withoutOwn(
  updates: SharedUpdate[],
  local: (path: string) => unknown,
  now: number,
  held: (value: SharedValue) => void = () => undefined
): SharedUpdate[] {
  const kept: SharedUpdate[] = []
  for (const update of updates) {
    const values = update.values.filter((v) => {
      if (!hasFreshOwnSource(local(v.path), now)) {
        return true
      }
      held({ $source: update.$source, timestamp: update.timestamp, path: v.path, value: v.value })
      return false
    })
    const meta = missingMeta(update.meta ?? [], local)
    if (values.length > 0 || meta.length > 0) {
      kept.push({
        $source: update.$source,
        timestamp: update.timestamp,
        values,
        ...(meta.length > 0 ? { meta } : {})
      })
    }
  }
  return kept
}

export interface ReceiverHost {
  peers: () => SharingPeer[]
  open: (peer: SharingPeer) => Promise<{ status: number; stream: http.IncomingMessage }>
  inject: (updates: SharedUpdate[]) => void
  /** This vessel's node at a path, as the server holds it: `value`, `$source`, `timestamp`, `values`, `meta`. */
  local: (path: string) => unknown
  debug: (msg: string) => void
}

interface Reading {
  peer: SharingPeer
  stream: http.IncomingMessage | null
  stopped: boolean
}

/** The taking side: one stream from each peer that shares, opened again after it ends. */
export class SharedDataReceiver {
  private readonly readings = new Map<string, Reading>()
  /** Peer id → the last values held back for a fresh source of this server's own, to stand in once it is quiet. */
  private readonly held = new Map<string, Map<string, SharedValue>>()

  constructor(private readonly host: ReceiverHost) {}

  /**
   * Opens streams to peers that began to share, closes those of peers that
   * stopped or moved, and puts in held values whose own source went quiet.
   */
  check(): void {
    const wanted = new Map(this.host.peers().map((p) => [p.id, p]))
    for (const [id, reading] of this.readings) {
      const peer = wanted.get(id)
      if (
        !peer ||
        peer.url !== reading.peer.url ||
        peer.token !== reading.peer.token ||
        peer.ca !== reading.peer.ca
      ) {
        this.close(id, reading)
      }
    }
    for (const [id, peer] of wanted) {
      if (!this.readings.has(id)) {
        const reading: Reading = { peer, stream: null, stopped: false }
        this.readings.set(id, reading)
        void this.read(reading)
      }
    }
    this.standIn()
  }

  private standIn(): void {
    const now = Date.now()
    for (const values of this.held.values()) {
      const due = [...values.entries()].filter(
        ([, v]) => !hasFreshOwnSource(this.host.local(v.path), now)
      )
      for (const [key] of due) {
        values.delete(key)
      }
      if (due.length > 0) {
        this.host.inject(grouped(due.map(([, v]) => v)))
      }
    }
  }

  private close(id: string, reading: Reading): void {
    this.held.delete(id)
    reading.stopped = true
    reading.stream?.destroy()
    this.readings.delete(id)
  }

  private async read(reading: Reading): Promise<void> {
    // `close()` sets it while this waits.
    const stopped = (): boolean => reading.stopped
    let wait = RECONNECT_MIN_MS
    while (!stopped()) {
      try {
        const { status, stream } = await this.host.open(reading.peer)
        if (stopped()) {
          stream.destroy()
          return
        }
        reading.stream = stream
        if (status === 200) {
          this.host.debug(`Multihelm: taking the data ${reading.peer.name} shares`)
          await this.consume(reading.peer, stream)
          this.held.delete(reading.peer.id)
          wait = RECONNECT_MIN_MS
        } else {
          stream.resume()
          this.host.debug(
            `Multihelm: ${reading.peer.name} answered ${String(status)} for its shared data`
          )
          wait = Math.min(wait * 2, RECONNECT_MAX_MS)
        }
      } catch (error) {
        this.host.debug(
          `Multihelm: reading the data ${reading.peer.name} shares: ${error instanceof Error ? error.message : String(error)}`
        )
        wait = Math.min(wait * 2, RECONNECT_MAX_MS)
      }
      reading.stream = null
      if (!stopped()) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
  }

  /** Resolves when the stream ends, however it ends. */
  private consume(peer: SharingPeer, stream: http.IncomingMessage): Promise<void> {
    return new Promise((resolve) => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          this.event(peer, buffer.slice(0, end))
          buffer = buffer.slice(end + 2)
        }
        if (buffer.length > MAX_EVENT_LENGTH) {
          stream.destroy(new Error('an event too long'))
        }
      })
      stream.on('close', () => {
        resolve()
      })
      stream.on('error', () => undefined)
    })
  }

  private event(peer: SharingPeer, text: string): void {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data === '') {
      return
    }
    let delta: unknown
    try {
      delta = JSON.parse(data)
    } catch {
      return
    }
    let held = this.held.get(peer.id)
    if (!held) {
      held = new Map()
      this.held.set(peer.id, held)
    }
    const peerHeld = held
    const updates = withoutOwn(relabel(peer, delta), this.host.local, Date.now(), (v) => {
      peerHeld.set(`${v.$source}\n${v.path}`, v)
    })
    for (const update of updates) {
      for (const { path } of update.values) {
        peerHeld.delete(`${update.$source}\n${path}`)
      }
    }
    if (updates.length > 0) {
      this.host.inject(updates)
    }
  }

  stop(): void {
    for (const [id, reading] of this.readings) {
      this.close(id, reading)
    }
  }
}
