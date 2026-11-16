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
const DELETE_CONFIRM_MS = 2000

export interface ResourcesHost {
  list: (type: ResourceType) => Promise<Record<string, unknown>>
  set: (type: ResourceType, id: string, resource: Record<string, unknown>) => Promise<void>
  delete: (type: ResourceType, id: string) => Promise<void>
  /** Where the mirror files live. */
  mirrorDir: string
  debug: (msg: string) => void
  error: (msg: string) => void
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

/** The resource a `resources.<type>.<id>` delta path names, or null. */
export function resourceOfPath(deltaPath: string): { type: ResourceType; id: string } | null {
  const [root, type, id, ...rest] = deltaPath.split('.')
  return root === 'resources' &&
    rest.length === 0 &&
    type !== undefined &&
    isResourceType(type) &&
    RESOURCE_ID.test(id ?? '')
    ? { type, id: id ?? '' }
    : null
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

export interface ResourcesDataset {
  dataset: DatasetDefinition
  /** The server announced a deletion with a null value on `resources.<type>.<id>`. */
  deleted: (type: ResourceType, id: string) => Promise<void>
  /** The server announced a stored value on `resources.<type>.<id>`. */
  written: (type: ResourceType, id: string) => void
}

export function resourcesDataset(host: ResourcesHost): ResourcesDataset {
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
    if (had !== text) {
      const file = mirrorPath(type, id)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.part`
      await fs.promises.writeFile(tmp, text)
      await fs.promises.rename(tmp, file)
    }
    pendingRemovals.delete(`${type}/${id}`)
  }

  /**
   * The resources of one type, added to and updated from the server's
   * listing but never shortened by it: the Resources API leaves a failing
   * provider out of its answer, so a resource missing from it may still be
   * there. Deletions come from the server's deltas instead (`deleted`).
   */
  async function current(type: ResourceType): Promise<Map<string, string>> {
    const known = await mirrored(type)
    let listed: Record<string, unknown>
    try {
      listed = await host.list(type)
    } catch (error) {
      host.debug(
        `Multihelm: cannot list the ${type}: ${error instanceof Error ? error.message : String(error)}`
      )
      return known
    }
    for (const [id, resource] of Object.entries(listed)) {
      if (!RESOURCE_ID.test(id) || !isRecord(resource)) {
        continue
      }
      if (deletedHere.has(`${type}/${id}`)) {
        continue
      }
      const text = resourceText(resource)
      await mirror(type, id, text, known.get(id))
      known.set(id, text)
    }
    return known
  }

  /**
   * Deleted on this server and not written again since: a listing read
   * before the deletion must not bring them back.
   */
  const deletedHere = new Set<string>()
  const awaitingDeletion = new Map<string, () => void>()
  /** Deleted on the server, but their mirror files could not be removed yet. */
  const pendingRemovals = new Set<string>()

  /** Mirror files are written and removed one after the other, so a deletion cannot race a rewrite. */
  let mirrorWork: Promise<unknown> = Promise.resolve()
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = mirrorWork.then(work)
    mirrorWork = result.catch(() => undefined)
    return result
  }

  async function removeMirror(key: string): Promise<void> {
    const { type, id } = splitKey(key)
    try {
      await fs.promises.rm(mirrorPath(type, id), { force: true })
      pendingRemovals.delete(key)
    } catch (error) {
      pendingRemovals.add(key)
      host.error(
        `Multihelm: cannot remove the copy of ${key}, trying again: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** The Resources API answers before the provider has written: wait until it has. */
  async function whenStored(type: ResourceType, id: string, text: string): Promise<void> {
    for (let check = 0; check < STORED_CHECKS; check++) {
      const resource = (await host.list(type))[id]
      if (isRecord(resource) && resourceText(resource) === text) {
        return
      }
      await sleep(STORED_CHECK_MS)
    }
    throw new Error(`the server did not store ${type}/${id}`)
  }

  /** Only the server's delta says a deletion was stored; a listing that lacks the resource may just be failing. */
  function whenDeleted(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        awaitingDeletion.delete(key)
        reject(new Error(`the server did not delete ${key}`))
      }, DELETE_CONFIRM_MS)
      awaitingDeletion.set(key, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async function deleted(type: ResourceType, id: string): Promise<void> {
    const key = `${type}/${id}`
    deletedHere.add(key)
    await exclusive(() => removeMirror(key))
    awaitingDeletion.get(key)?.()
    awaitingDeletion.delete(key)
  }

  const dataset: DatasetDefinition = {
    id: RESOURCES_DATASET,
    isValidKey: isResourceKey,

    list: async (): Promise<DatasetEntry[]> => {
      const entries: DatasetEntry[] = []
      for (const key of [...pendingRemovals]) {
        await exclusive(async () => {
          if (pendingRemovals.has(key)) {
            await removeMirror(key)
          }
        })
      }
      for (const type of RESOURCE_TYPES) {
        for (const id of (await exclusive(() => current(type))).keys()) {
          if (pendingRemovals.has(`${type}/${id}`)) {
            continue
          }
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
      deletedHere.delete(entry.key)
      await host.set(type, id, resource)
      await whenStored(type, id, text)
      await exclusive(() => mirror(type, id, text))
    },

    /**
     * A delete the server refuses is taken as done: it cannot say whether
     * the resource is already gone or its provider failed, and should it
     * still be there, the next listing offers it to the peers again. A
     * failure can bring a deleted route back, but never lose one.
     */
    remove: async (key: string): Promise<boolean> => {
      const { type, id } = splitKey(key)
      const confirmed = whenDeleted(key)
      try {
        await host.delete(type, id)
      } catch (error) {
        awaitingDeletion.get(key)?.()
        host.debug(
          `Multihelm: the server refused to delete ${key}: ${error instanceof Error ? error.message : String(error)}`
        )
        await exclusive(() => removeMirror(key))
        return true
      }
      await confirmed
      return true
    }
  }

  function written(type: ResourceType, id: string): void {
    deletedHere.delete(`${type}/${id}`)
  }

  return { dataset, deleted, written }
}
