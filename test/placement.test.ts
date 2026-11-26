import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PluginList } from '../src/master-plugins.js'
import { registerRoutes } from '../src/routes.js'

import {
  PLACEMENT_HOLD_MS,
  PluginPlacement,
  UpSince,
  parsePlacement,
  placedHere,
  type Liveness
} from '../src/placement.js'
import { orderText, placedOn, type ServerColumn } from '../src/console/view.js'

const STALE = 150_000
const now = 10_000_000

function live(
  seen: Record<string, number>,
  up: Record<string, number> = {},
  startedAt = 0
): Liveness {
  return {
    startedAt,
    lastSeen: (id) => seen[id],
    upSince: (id) => up[id],
    staleMs: STALE
  }
}

describe('placing plugins on chosen servers', () => {
  it('takes a placement of plugin ids to servers, each server once', () => {
    expect(parsePlacement({ questdb: ['b', 'a', 'b'] })).toEqual({ questdb: ['b', 'a'] })
    expect(parsePlacement({ '../x': ['a'] })).toBeNull()
    expect(parsePlacement({ questdb: [] })).toBeNull()
    expect(parsePlacement({ questdb: 'a' })).toBeNull()
    expect(parsePlacement({ questdb: Array.from({ length: 10 }, (_, i) => String(i)) })).toBeNull()
  })

  it('runs a plugin on the first server of its list, and nowhere off the list', () => {
    expect(placedHere(['own', 'b'], 'own', live({}), now)).toBe(true)
    expect(placedHere(['a', 'b'], 'own', live({}), now)).toBe(false)
  })

  it('takes over once the servers before have been gone a while, counted from its own start too', () => {
    const gone = now - STALE - 1
    expect(placedHere(['a', 'own'], 'own', live({ a: now - 10_000 }), now)).toBeNull()
    expect(placedHere(['a', 'own'], 'own', live({ a: gone }), now)).toBe(true)
    expect(placedHere(['a', 'own'], 'own', live({}), now)).toBe(true)
    expect(placedHere(['a', 'own'], 'own', live({}, {}, now - 1_000), now)).toBeNull()
  })

  it('gives a plugin back once a server before has been back long enough', () => {
    const seen = { a: now - 5_000 }
    expect(placedHere(['a', 'own'], 'own', live(seen, { a: now - PLACEMENT_HOLD_MS }), now)).toBe(
      false
    )
    expect(placedHere(['a', 'own'], 'own', live(seen, { a: now - 60_000 }), now)).toBeNull()
  })

  it('knows since when a server has been there, and forgets it once it is gone', () => {
    const up = new UpSince()
    const seen: Record<string, number> = { a: now }
    up.update(['a', 'b'], (id) => seen[id], STALE, now)
    up.update(['a', 'b'], (id) => seen[id], STALE, now + 30_000)
    expect([up.get('a'), up.get('b')]).toEqual([now, undefined])
    up.update(['a'], (id) => seen[id], STALE, now + STALE + 1)
    expect(up.get('a')).toBeUndefined()
  })
})

describe('the placement dataset', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-placement-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('offers its placement once set, takes a peer’s, and refuses what is not one', async () => {
    let changes = 0
    const placement = new PluginPlacement(dir, () => {
      changes++
    })
    expect(await placement.dataset.list()).toEqual([])
    await placement.set({ questdb: ['a', 'b'] })
    expect(await placement.dataset.list()).toEqual([
      { key: 'plugins', meta: { questdb: ['a', 'b'] }, files: [] }
    ])
    await placement.dataset.apply({ key: 'plugins', meta: { grafana: ['b'] }, files: [] })
    expect(placement.get()).toEqual({ grafana: ['b'] })
    expect(new PluginPlacement(dir, () => undefined).get()).toEqual({ grafana: ['b'] })
    await expect(
      placement.dataset.apply({ key: 'plugins', meta: { grafana: 'b' }, files: [] })
    ).rejects.toThrow()
    expect(changes).toBe(2)
  })
})

describe('the console with placed plugins', () => {
  const column = (id: string, name: string, state: ServerColumn['state']): ServerColumn => ({
    id,
    name,
    here: false,
    master: false,
    state,
    versions: '',
    oneWay: false
  })
  const columns = [column('a', 'vmsignalk', 'offline'), column('b', 'pi5-fly-port', 'online')]

  it('shows a placed plugin on the first of its servers that is online', () => {
    expect(placedOn({ questdb: ['a', 'b'], grafana: ['x'] }, columns)).toEqual(
      new Map([['b', ['questdb']]])
    )
  })

  it('names the servers of a placement in order', () => {
    expect(orderText(['a', 'b', 'c0ffee1234'], columns)).toBe(
      'vmsignalk, then pi5-fly-port, then a server not seen (c0ffee12)'
    )
  })
})

describe('the placement route', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-placement-route-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function put(
    placement: PluginPlacement,
    masterList: PluginList,
    body: unknown
  ): Promise<{ status: number; body: unknown }> {
    const e = express()
    e.use(express.json())
    const router = express.Router()
    registerRoutes(
      router,
      () => null,
      () => [],
      undefined,
      undefined,
      undefined,
      () => masterList,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => placement
    )
    e.use(router)
    const server = e.listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${String(port)}/placement`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      return { status: res.status, body: await res.json() }
    } finally {
      server.close()
    }
  }

  it('saves a placement, and refuses one for a plugin that runs on the master only', async () => {
    const placement = new PluginPlacement(dir, () => undefined)
    const masterList = new PluginList(path.join(dir, 'master'), () => undefined)
    await masterList.set(['autopilot'])
    expect(await put(placement, masterList, { plugins: { questdb: ['a'] } })).toEqual({
      status: 200,
      body: { plugins: { questdb: ['a'] } }
    })
    const refused = await put(placement, masterList, { plugins: { autopilot: ['a'] } })
    expect(refused.status).toBe(400)
    expect((await put(placement, masterList, { plugins: { questdb: 'a' } })).status).toBe(400)
    expect(placement.get()).toEqual({ questdb: ['a'] })
  })
})
