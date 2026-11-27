/**
 * Plugins placed on chosen servers: each runs on the first server of its
 * list that is there, and the next one takes it over while it is gone, for
 * services such as a database that should run once on the boat but not
 * necessarily on the master. The lists are the same on every server, kept
 * in step as a dataset with no master; each server switches only its own
 * plugins. While the network is split, two servers may both run such a
 * plugin, so plugins that send to a shared bus belong on the master only.
 */

import fs from 'node:fs'
import path from 'node:path'

import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js'
import { isPluginId } from './master-plugins.js'

export const PLACEMENT_DATASET = 'signalk-multihelm/placement'
const KEY = 'plugins'
const FILE = 'placement.json'
export const MAX_PLACED_SERVERS = 9
const MAX_PLACED_PLUGINS = 100

const ServerOrderSchema = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
  minItems: 1,
  maxItems: MAX_PLACED_SERVERS
})

export const PlacementSchema = Type.Record(Type.String(), ServerOrderSchema)
export type Placement = Static<typeof PlacementSchema>

/** A placement as sent, cleaned: valid plugin ids, each server once; null when it is not one. */
export function parsePlacement(raw: unknown): Placement | null {
  if (!Value.Check(PlacementSchema, raw)) {
    return null
  }
  const entries = Object.entries(raw)
  if (entries.length > MAX_PLACED_PLUGINS || !entries.every(([id]) => isPluginId(id))) {
    return null
  }
  return Object.fromEntries(
    entries
      .map(([id, servers]): [string, string[]] => [id, [...new Set(servers)]])
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

/** A server counts as back only once it has been there this long, so a flapping one does not take a plugin back and forth. */
export const PLACEMENT_HOLD_MS = 2 * 60_000

export interface Liveness {
  /** When this server's Multihelm started. */
  startedAt: number
  /** When the server last answered or asked; undefined when never. */
  lastSeen: (serverId: string) => number | undefined
  /** Since when the server has been there without a break; undefined while it is not. */
  upSince: (serverId: string) => number | undefined
  /** How long a server may stay silent and still count as there. */
  staleMs: number
}

/**
 * Whether a placed plugin should run here: true when every server before
 * this one in its list has been gone a while, counted from this server's own
 * start too; false when this server is not on the list, or one before it has
 * been back long enough; null in between, to leave it as it is.
 */
export function placedHere(
  order: readonly string[],
  selfId: string,
  live: Liveness,
  now: number
): boolean | null {
  const place = order.indexOf(selfId)
  if (place === -1) {
    return false
  }
  const before = order.slice(0, place)
  const gone = (id: string): boolean =>
    now - Math.max(live.lastSeen(id) ?? 0, live.startedAt) > live.staleMs
  if (before.every(gone)) {
    return true
  }
  const back = (id: string): boolean => {
    const since = live.upSince(id)
    return since !== undefined && now - since >= PLACEMENT_HOLD_MS
  }
  return before.some(back) ? false : null
}

/** Since when each server has been there without a break, from what this server saw of it. */
export class UpSince {
  private readonly since = new Map<string, number>()

  update(
    ids: readonly string[],
    lastSeen: (id: string) => number | undefined,
    staleMs: number,
    now: number
  ): void {
    // A server left off every list starts afresh once it is placed again.
    const tracked = new Set(ids)
    for (const id of this.since.keys()) {
      if (!tracked.has(id)) {
        this.since.delete(id)
      }
    }
    for (const id of ids) {
      const seen = lastSeen(id)
      if (seen !== undefined && now - seen <= staleMs) {
        if (!this.since.has(id)) {
          this.since.set(id, now)
        }
      } else {
        this.since.delete(id)
      }
    }
  }

  get(id: string): number | undefined {
    return this.since.get(id)
  }
}

export class PluginPlacement {
  private readonly file: string
  private current: Placement
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void
  ) {
    this.file = path.join(dir, FILE)
    this.current = this.read()
  }

  get(): Placement {
    return this.current
  }

  ids(): string[] {
    return Object.keys(this.current)
  }

  set(placement: Placement): Promise<void> {
    return this.queued(() => this.write(placement))
  }

  readonly dataset: DatasetDefinition = {
    id: PLACEMENT_DATASET,
    isValidKey: (key) => key === KEY,

    list: (): Promise<DatasetEntry[]> =>
      Promise.resolve(
        fs.existsSync(this.file) ? [{ key: KEY, meta: this.current, files: [] }] : []
      ),

    apply: (entry: IncomingEntry): Promise<void> => {
      const placement = parsePlacement(entry.meta)
      if (placement === null || entry.files.length > 0) {
        return Promise.reject(new Error('not a plugin placement'))
      }
      return this.queued(() => this.write(placement))
    },

    remove: (): Promise<boolean> =>
      this.queued(async () => {
        await fs.promises.rm(this.file, { force: true })
        this.changed({})
      }).then(() => true)
  }

  private queued(work: () => Promise<void>): Promise<void> {
    const result = this.writes.then(work)
    this.writes = result.catch(() => undefined)
    return result
  }

  private read(): Placement {
    try {
      return parsePlacement(JSON.parse(fs.readFileSync(this.file, 'utf8'))) ?? {}
    } catch {
      return {}
    }
  }

  private async write(placement: Placement): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.part`
    await fs.promises.writeFile(tmp, JSON.stringify(placement))
    await fs.promises.rename(tmp, this.file)
    this.changed(placement)
  }

  private changed(placement: Placement): void {
    const before = JSON.stringify(this.current)
    this.current = placement
    if (JSON.stringify(placement) !== before) {
      this.onChange()
    }
  }
}
