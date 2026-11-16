import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DatasetDefinition, DatasetEntry } from '../src/api.js'
import {
  isResourceKey,
  resourceOfPath,
  resourcesDataset,
  type ResourcesDataset,
  type ResourceType
} from '../src/resources-dataset.js'

const ROUTE = '0f9c6a0e-5b7a-4c4e-9d1e-2a3b4c5d6e7f'
const ROUTE_2 = '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e'
const WAYPOINT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

interface Fake {
  store: Record<ResourceType, Record<string, Record<string, unknown>>>
  fail: boolean
  /** Writes land a little after the call returns, as with the server's provider. */
  lag: boolean
  neverStores: boolean
  /** The server refuses a delete, as it does for a resource no provider holds. */
  refusesDelete: boolean
  /** Runs after a listing was read and before it is answered. */
  whileListing?: () => void
}

function fakeServer(): Fake {
  return {
    store: { routes: {}, waypoints: {}, regions: {}, notes: {} },
    fail: false,
    lag: true,
    neverStores: false,
    refusesDelete: false
  }
}

function later(fake: Fake, write: () => void): void {
  if (fake.neverStores) {
    return
  }
  if (fake.lag) {
    setTimeout(write, 30)
  } else {
    write()
  }
}

describe('isResourceKey', () => {
  it('takes a known type and a resource id, nothing else', () => {
    expect(isResourceKey(`routes/${ROUTE}`)).toBe(true)
    expect(isResourceKey(`charts/${ROUTE}`)).toBe(false)
    expect(isResourceKey('routes/../x')).toBe(false)
    expect(isResourceKey(`routes/${ROUTE}/x`)).toBe(false)
  })

  it('reads the resource a delta path names', () => {
    expect(resourceOfPath(`resources.routes.${ROUTE}`)).toEqual({ type: 'routes', id: ROUTE })
    expect(resourceOfPath('resources.charts.x')).toBeNull()
    expect(resourceOfPath('navigation.position')).toBeNull()
  })
})

describe('the resources dataset', () => {
  let dir: string
  let fake: Fake
  let dataset: DatasetDefinition
  let sync: ResourcesDataset
  let errors: string[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-resources-'))
    fake = fakeServer()
    errors = []
    sync = resourcesDataset({
      list: (type) => {
        const listed = fake.fail
          ? {}
          : Object.fromEntries(
              Object.entries(fake.store[type]).map(([id, r]) => [
                id,
                { ...r, timestamp: new Date().toISOString(), $source: 'resources-provider' }
              ])
            )
        fake.whileListing?.()
        return Promise.resolve(listed)
      },
      set: (type, id, resource) => {
        later(fake, () => {
          fake.store[type][id] = resource
          sync.written(type, id)
        })
        return Promise.resolve()
      },
      delete: (type, id) => {
        if (fake.refusesDelete) {
          return Promise.reject(new Error(`No provider for ${type}`))
        }
        later(fake, () => {
          Reflect.deleteProperty(fake.store[type], id)
          void sync.deleted(type, id)
        })
        return Promise.resolve()
      },
      mirrorDir: dir,
      debug: () => undefined,
      error: (msg) => {
        errors.push(msg)
      }
    })
    dataset = sync.dataset
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const read = (entry: DatasetEntry | undefined): unknown =>
    JSON.parse(fs.readFileSync(entry?.files[0]?.path ?? '', 'utf8'))

  it('lists each resource as one file, without what the provider adds on reading', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour', feature: { type: 'Feature' } }
    fake.store.waypoints[WAYPOINT] = { name: 'Buoy' }
    const entries = await dataset.list()

    expect(entries.map((e) => e.key).sort()).toEqual([`routes/${ROUTE}`, `waypoints/${WAYPOINT}`])
    expect(read(entries.find((e) => e.key === `routes/${ROUTE}`))).toEqual({
      feature: { type: 'Feature' },
      name: 'Harbour'
    })
  })

  it('keeps a file as it is while its resource does not change', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    const [first] = await dataset.list()
    const [again] = await dataset.list()
    expect(again?.files[0]?.mtimeMs).toBe(first?.files[0]?.mtimeMs)

    fake.store.routes[ROUTE] = { name: 'Harbour entrance' }
    const [changed] = await dataset.list()
    expect(read(changed)).toEqual({ name: 'Harbour entrance' })
  })

  it('stores a peer resource on this server, waiting until it is written', async () => {
    const incoming = path.join(dir, 'incoming.json')
    fs.writeFileSync(incoming, JSON.stringify({ name: 'Anchorage' }))
    await dataset.apply({
      key: `waypoints/${WAYPOINT}`,
      meta: null,
      files: [{ name: 'resource.json', path: incoming, size: 0, sha256: '', unchanged: false }]
    })

    expect(fake.store.waypoints[WAYPOINT]).toEqual({ name: 'Anchorage' })
    expect((await dataset.list()).map((e) => e.key)).toEqual([`waypoints/${WAYPOINT}`])
  })

  it('fails a resource the server does not store, so it is tried again', async () => {
    fake.neverStores = true
    const incoming = path.join(dir, 'incoming.json')
    fs.writeFileSync(incoming, JSON.stringify({ name: 'Anchorage' }))

    await expect(
      dataset.apply({
        key: `waypoints/${WAYPOINT}`,
        meta: null,
        files: [{ name: 'resource.json', path: incoming, size: 0, sha256: '', unchanged: false }]
      })
    ).rejects.toThrow(/did not store/)
    expect(await dataset.list()).toEqual([])
  })

  it('deletes a resource a peer deleted once the server says it did', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await dataset.list()
    expect(await dataset.remove(`routes/${ROUTE}`)).toBe(true)

    expect(fake.store.routes[ROUTE]).toBeUndefined()
    expect(await dataset.list()).toEqual([])
  })

  it('does not take a deletion the server never confirms for done, even while it reads as empty', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await dataset.list()
    fake.neverStores = true
    fake.fail = true

    await expect(dataset.remove(`routes/${ROUTE}`)).rejects.toThrow(/did not delete/)
    expect((await dataset.list()).map((e) => e.key)).toEqual([`routes/${ROUTE}`])
  })

  it('takes a delete the server refuses for done, so a resource already gone does not stick', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await dataset.list()
    Reflect.deleteProperty(fake.store.routes, ROUTE)
    fake.refusesDelete = true

    expect(await dataset.remove(`routes/${ROUTE}`)).toBe(true)
    expect(await dataset.list()).toEqual([])
  })

  it('drops a resource deleted on this server, and only then', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    fake.store.waypoints[WAYPOINT] = { name: 'Buoy' }
    await dataset.list()

    Reflect.deleteProperty(fake.store.waypoints, WAYPOINT)
    expect((await dataset.list()).map((e) => e.key).sort()).toEqual([
      `routes/${ROUTE}`,
      `waypoints/${WAYPOINT}`
    ])

    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await sync.deleted('routes', ROUTE)
    expect((await dataset.list()).map((e) => e.key)).toEqual([`waypoints/${WAYPOINT}`])
  })

  it('keeps the last listing when a type suddenly reads as empty', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await dataset.list()
    fake.fail = true

    expect((await dataset.list()).map((e) => e.key)).toEqual([`routes/${ROUTE}`])
  })

  it('keeps a resource of a type whose listing lacks it, beside one it still holds', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    fake.store.routes[ROUTE_2] = { name: 'Marina' }
    await dataset.list()

    Reflect.deleteProperty(fake.store.routes, ROUTE_2)
    expect((await dataset.list()).map((e) => e.key).sort()).toEqual(
      [`routes/${ROUTE}`, `routes/${ROUTE_2}`].sort()
    )
  })

  it('lists a resource written again under a deleted id, even unchanged, but not a stale copy', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await dataset.list()

    await sync.deleted('routes', ROUTE)
    expect(await dataset.list()).toEqual([])

    sync.written('routes', ROUTE)
    const entries = await dataset.list()
    expect(entries.map((e) => e.key)).toEqual([`routes/${ROUTE}`])
    expect(read(entries[0])).toEqual({ name: 'Harbour' })
  })

  it('lists a resource written again after a deletion it had no copy of', async () => {
    await sync.deleted('routes', ROUTE)
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    expect(await dataset.list()).toEqual([])

    sync.written('routes', ROUTE)
    expect((await dataset.list()).map((e) => e.key)).toEqual([`routes/${ROUTE}`])
  })

  it('does not offer a copy whose removal keeps failing', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    const [entry] = await dataset.list()
    const file = entry?.files[0]?.path ?? ''
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('busy'))

    Reflect.deleteProperty(fake.store.routes, ROUTE)
    await sync.deleted('routes', ROUTE)
    expect(await dataset.list()).toEqual([])
    expect(await dataset.list()).toEqual([])
    expect(errors).toHaveLength(3)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('keeps a copy written again while its old one waited for removal', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    const [entry] = await dataset.list()
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('busy'))
    Reflect.deleteProperty(fake.store.routes, ROUTE)
    await sync.deleted('routes', ROUTE)

    fs.writeFileSync(path.join(dir, 'incoming.json'), JSON.stringify({ name: 'Marina' }))
    await dataset.apply({
      key: `routes/${ROUTE}`,
      meta: null,
      files: [
        {
          name: 'resource.json',
          path: path.join(dir, 'incoming.json'),
          size: 0,
          sha256: '',
          unchanged: false
        }
      ]
    })
    fake.fail = true

    const entries = await dataset.list()
    expect(entries.map((e) => e.key)).toEqual([`routes/${ROUTE}`])
    expect(read(entries[0])).toEqual({ name: 'Marina' })
    expect(entry?.files[0]?.path).toBe(entries[0]?.files[0]?.path)
  })

  it('removes the copy of a deleted resource on the next listing when it could not at once', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    const [entry] = await dataset.list()
    const file = entry?.files[0]?.path ?? ''
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('busy'))

    Reflect.deleteProperty(fake.store.routes, ROUTE)
    await sync.deleted('routes', ROUTE)
    expect(errors).toHaveLength(1)
    expect(fs.existsSync(file)).toBe(true)

    expect(await dataset.list()).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('does not take a listing read before a deletion for the resource written after it', async () => {
    fake.store.routes[ROUTE] = { name: 'Harbour' }
    await dataset.list()

    fake.whileListing = () => {
      fake.whileListing = undefined
      Reflect.deleteProperty(fake.store.routes, ROUTE)
      void sync.deleted('routes', ROUTE)
      fake.store.routes[ROUTE] = { name: 'Marina' }
      sync.written('routes', ROUTE)
    }
    expect((await dataset.list()).map((e) => e.key)).not.toContain(`routes/${ROUTE}`)

    const entries = await dataset.list()
    expect(entries.map((e) => e.key)).toContain(`routes/${ROUTE}`)
    expect(read(entries.find((e) => e.key === `routes/${ROUTE}`))).toEqual({ name: 'Marina' })
  })
})
