/**
 * The `resources` dataset: the routes, waypoints, regions and notes of this
 * server, one entry per resource keyed `<type>/<id>`, kept in step between
 * the boat's servers with no master. They are read and written through the
 * server's Resources API, so every provider is covered and every change
 * reaches the clients as a delta. Each resource is mirrored as a JSON file
 * in the data dir, because a dataset entry is made of files.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js'

export const RESOURCES_DATASET = 'signalk-multihelm/resources'
export const RESOURCE_TYPES = ['routes', 'waypoints', 'regions', 'notes'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

const FILE = 'resource.json'
/** What the server's Resources API requires of an id for these types. */
const RESOURCE_ID =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/
/** Added by the provider on every read, not part of the resource. */
const READ_ONLY_FIELDS = new Set(['timestamp', '$source'])
const STORED_CHECKS = 20
const STORED_CHECK_MS = 100

export interface ResourcesHost {
  list: (type: ResourceType) => Promise<Record<string, unknown>>
  set: (type: ResourceType, id: string, resource: Record<string, unknown>) => Promise<void>
  delete: (type: ResourceType, id: string) => Promise<void>
  /** Where the mirror files live. */
  mirrorDir: string
  debug: (msg: string) => void
}

/** Plugins reach the Resources API in process; a server without it has nothing to keep in step. */
export function hasResourcesApi(app: object): boolean {
  const api = (app as { resourcesApi?: { setResource?: unknown } }).resourcesApi
  return typeof api?.setResource === 'function'
}

function isResourceType(type: string): type is ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(type)
}

export function isResourceKey(key: string): boolean {
  const [type, id, ...rest] = key.split('/')
  return (
    rest.length === 0 && type !== undefined && isResourceType(type) && RESOURCE_ID.test(id ?? '')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sorted keys, so the same resource always gives the same file and nothing churns. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    )
  }
  return value
}

export function resourceText(resource: Record<string, unknown>): string {
  const stored = Object.fromEntries(
    Object.entries(resource).filter(([k]) => !READ_ONLY_FIELDS.has(k))
  )
  return JSON.stringify(canonical(stored))
}

function splitKey(key: string): { type: ResourceType; id: string } {
  const [type, id] = key.split('/') as [ResourceType, string]
  return { type, id }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export function resourcesDataset(host: ResourcesHost): DatasetDefinition {
  const mirrorPath = (type: ResourceType, id: string): string =>
    path.join(host.mirrorDir, type, `${id}.json`)

  async function mirrored(type: ResourceType): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    let names: string[]
    try {
      names = await fs.promises.readdir(path.join(host.mirrorDir, type))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return found
      }
      throw error
    }
    for (const name of names) {
      const id = name.replace(/\.json$/, '')
      if (name.endsWith('.json') && RESOURCE_ID.test(id)) {
        found.set(id, await fs.promises.readFile(path.join(host.mirrorDir, type, name), 'utf8'))
      }
    }
    return found
  }

  /** Rewrites a mirror file only when its resource changed, so its time stays what was hashed. */
  async function mirror(type: ResourceType, id: string, text: string, had?: string): Promise<void> {
    if (had === text) {
      return
    }
    const file = mirrorPath(type, id)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.part`
    await fs.promises.writeFile(tmp, text)
    await fs.promises.rename(tmp, file)
  }

  /**
   * The resources of one type as they are now. A type that cannot be read,
   * or reads as empty where it had resources, keeps its last listing: the
   * server's Resources API answers a failing provider with an empty list,
   * and taking that for a deletion would delete them on every server.
   */
  async function current(type: ResourceType): Promise<Map<string, string>> {
    const before = await mirrored(type)
    let listed: Record<string, unknown>
    try {
      listed = await host.list(type)
    } catch (error) {
      host.debug(
        `Multihelm: cannot list the ${type}: ${error instanceof Error ? error.message : String(error)}`
      )
      return before
    }
    const now = new Map<string, string>()
    for (const [id, resource] of Object.entries(listed)) {
      if (RESOURCE_ID.test(id) && isRecord(resource)) {
        now.set(id, resourceText(resource))
      }
    }
    if (now.size === 0 && before.size > 0) {
      host.debug(`Multihelm: the ${type} read as empty; keeping the ${String(before.size)} known`)
      return before
    }
    for (const [id, text] of now) {
      await mirror(type, id, text, before.get(id))
    }
    for (const id of before.keys()) {
      if (!now.has(id)) {
        await fs.promises.rm(mirrorPath(type, id), { force: true })
      }
    }
    return now
  }

  /** The Resources API answers before the provider has written: wait until it has. */
  async function whenStored(type: ResourceType, id: string, text: string | null): Promise<void> {
    for (let check = 0; check < STORED_CHECKS; check++) {
      const listed = await host.list(type)
      const resource = listed[id]
      const stored = isRecord(resource) ? resourceText(resource) : null
      if (stored === text) {
        return
      }
      await sleep(STORED_CHECK_MS)
    }
    throw new Error(`the server did not store ${type}/${id}`)
  }

  return {
    id: RESOURCES_DATASET,
    isValidKey: isResourceKey,

    list: async (): Promise<DatasetEntry[]> => {
      const entries: DatasetEntry[] = []
      for (const type of RESOURCE_TYPES) {
        for (const id of (await current(type)).keys()) {
          const file = mirrorPath(type, id)
          const stat = await fs.promises.stat(file)
          entries.push({
            key: `${type}/${id}`,
            meta: null,
            files: [{ name: FILE, path: file, size: stat.size, mtimeMs: stat.mtimeMs }]
          })
        }
      }
      return entries
    },

    apply: async (entry: IncomingEntry): Promise<void> => {
      const file = entry.files.find((f) => f.name === FILE)
      if (!file || entry.files.length !== 1) {
        throw new Error(`a resource has one file, ${entry.key} has ${String(entry.files.length)}`)
      }
      const { type, id } = splitKey(entry.key)
      const resource: unknown = JSON.parse(await fs.promises.readFile(file.path, 'utf8'))
      if (!isRecord(resource)) {
        throw new Error(`${entry.key} is not a resource`)
      }
      const text = resourceText(resource)
      await host.set(type, id, resource)
      await whenStored(type, id, text)
      await mirror(type, id, text)
    },

    remove: async (key: string): Promise<boolean> => {
      const { type, id } = splitKey(key)
      await host.delete(type, id)
      await whenStored(type, id, null)
      await fs.promises.rm(mirrorPath(type, id), { force: true })
      return true
    }
  }
}
