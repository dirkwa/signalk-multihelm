import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import express from 'express'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { Multihelm } from '../src/multihelm.js'
import { ROUTE_PREFIX, openStream } from '../src/peer-client.js'
import { registerRoutes } from '../src/routes.js'
import {
  DataSharer,
  SHARED_DATA_ROUTE,
  SharedDataReceiver,
  pathMatcher,
  relabel,
  withoutOwn,
  events,
  OWN_SOURCE_FRESH_MS,
  OwnReadings,
  STALL_MS,
  sharedSource,
  sourcePart,
  shareSettings,
  type ShareSettings,
  type SharedUpdate,
  type SharingPeer
} from '../src/shared-data.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-shared-data-'))
const T = '2026-11-23T20:00:00.000Z'

interface Station {
  name: string
  mh: Multihelm
  sharer: DataSharer
  meta: Map<string, unknown>
  url: string
  server: http.Server
}

const stations: Station[] = []

async function station(name: string, settings: ShareSettings): Promise<Station> {
  const meta = new Map<string, unknown>()
  const sharer = new DataSharer({
    settings,
    selfId: 'signalk-multihelm',
    meta: (p) => meta.get(p)
  })
  const mh = new Multihelm(new MultihelmStore(path.join(root, name)), {
    serverName: () => name,
    isMaster: () => false,
    sharesData: () => sharer.shares(),
    debug: () => undefined,
    error: () => undefined
  })
  const app = express()
  const router = express.Router()
  registerRoutes(
    router,
    () => mh,
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => sharer
  )
  app.use(ROUTE_PREFIX, router)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const s = { name, mh, sharer, meta, url: `http://127.0.0.1:${String(port)}`, server }
  stations.push(s)
  return s
}

function receiver(peers: () => SharingPeer[]): { r: SharedDataReceiver; got: SharedUpdate[] } {
  const got: SharedUpdate[] = []
  const r = new SharedDataReceiver({
    peers,
    open: (peer) => openStream(peer, SHARED_DATA_ROUTE, peer.token),
    inject: (updates) => {
      got.push(...updates)
    },
    local: () => undefined,
    debug: () => undefined
  })
  return { r, got }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const value = ($source: string, p: string, v: unknown) => ({
  $source,
  timestamp: T,
  values: [{ path: p, value: v }]
})

describe('data only one server sees', () => {
  const receivers: SharedDataReceiver[] = []

  afterEach(() => {
    for (const r of receivers.splice(0)) {
      r.stop()
    }
  })

  afterAll(() => {
    for (const s of stations) {
      s.sharer.stop()
      s.mh.stop()
      s.server.close()
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('matches path patterns and keeps the source readable', () => {
    const matches = pathMatcher(['propulsion.*', 'environment.water.temperature'])
    expect(matches('propulsion.port.revolutions')).toBe(true)
    expect(matches('environment.water.temperature')).toBe(true)
    expect(matches('environmentXwater.temperature')).toBe(false)
    expect(matches('navigation.position')).toBe(false)
    expect(sharedSource({ id: '3f2a1c9d-0000', name: 'engine room' }, 'n2k-er.23')).toBe(
      'multihelm.engine_20_room-3f2a1c9d-0000.n2k-er.23'
    )
    expect(shareSettings([' propulsion.* ', '', 3], 'x')).toEqual({
      paths: ['propulsion.*'],
      connections: []
    })
  })

  it('reaches a paired server under its own source, the chosen paths only, with their units', async () => {
    const backup = await station('backup', { paths: ['propulsion.*'], connections: [] })
    const main = await station('main', { paths: [], connections: [] })
    backup.meta.set('propulsion.port.revolutions', { units: 'Hz', zones: [{ state: 'alarm' }] })
    await main.mh.pair(backup.url)
    await main.mh.runRound()
    expect(backup.mh.hello().shares).toBe(true)
    expect(main.mh.hello().shares).toBeUndefined()
    const peers = main.mh.sharingPeers()
    expect(peers.map((p) => p.name)).toEqual(['backup'])
    const backupId = backup.mh.serverId

    const { r, got } = receiver(() => peers)
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    backup.sharer.offer(value('j1939.0', 'propulsion.port.revolutions', 30))
    backup.sharer.offer(value('j1939.0', 'propulsion.port.revolutions', 31))
    backup.sharer.offer(value('j1939.0', 'navigation.position', { latitude: 1, longitude: 2 }))
    backup.sharer.flush()
    await until(() => got.length > 0)
    expect(got).toEqual([
      {
        $source: `multihelm.backup-${backupId}.j1939.0`,
        timestamp: T,
        values: [{ path: 'propulsion.port.revolutions', value: 31 }],
        meta: [{ path: 'propulsion.port.revolutions', value: { units: 'Hz' } }]
      }
    ])

    backup.sharer.offer(value('j1939.0', 'propulsion.port.revolutions', 32))
    backup.sharer.flush()
    await until(() => got.length > 1)
    expect(got[1]?.meta).toBeUndefined()
  })

  it('shares every path of a chosen connection, and never what it took from others or raised itself', async () => {
    const er = await station('engine-room', { paths: [], connections: ['n2k-er'] })
    expect(er.sharer.subscribePaths()).toEqual(['*'])
    const { r, got } = receiver(() => [{ id: 'er', name: 'er', url: er.url, token: '' }])
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    er.sharer.offer(value('n2k-er.23', 'electrical.batteries.1.voltage', 12.8))
    er.sharer.offer(value('n2k-er', 'tanks.fuel.0.currentLevel', 0.5))
    er.sharer.offer(value('n2k-erx.1', 'navigation.speedOverGround', 3))
    er.sharer.offer(value('multihelm.main.n2k-er.5', 'propulsion.x.temperature', 300))
    er.sharer.offer(value('signalk-multihelm', 'notifications.x', { state: 'alarm' }))
    er.sharer.flush()
    await until(() => got.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(got.map((u) => u.values[0]?.path).sort()).toEqual([
      'electrical.batteries.1.voltage',
      'tanks.fuel.0.currentLevel'
    ])
  })

  it('answers 404 while sharing nothing, and opens the stream again after it ends', async () => {
    const quiet = await station('quiet', { paths: [], connections: [] })
    const res = await openStream({ url: quiet.url }, SHARED_DATA_ROUTE, '')
    res.stream.resume()
    expect(res.status).toBe(404)

    const sharing = await station('sharing', { paths: ['tanks.*'], connections: [] })
    let opened = 0
    const got: SharedUpdate[] = []
    const r = new SharedDataReceiver({
      peers: () => [{ id: 's', name: 's', url: sharing.url, token: '' }],
      open: async (peer) => {
        opened++
        const answer = await openStream(peer, SHARED_DATA_ROUTE, peer.token)
        if (opened === 1) {
          setTimeout(() => answer.stream.destroy(), 50)
        }
        return answer
      },
      inject: (updates) => {
        got.push(...updates)
      },
      local: () => undefined,
      debug: () => undefined
    })
    receivers.push(r)
    r.check()
    await until(() => opened === 2, 8000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    sharing.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.4))
    sharing.sharer.flush()
    await until(() => got.length === 1)
  }, 10_000)

  it('leaves out what does not fit, and what came from Multihelm already', () => {
    const p = { id: 'abcdef', name: 'p' }
    expect(relabel(p, null)).toEqual([])
    expect(
      relabel(p, {
        updates: [
          { $source: 'multihelm.q.a', timestamp: T, values: [{ path: 'a', value: 1 }] },
          { $source: 'a', values: [{ path: 'a', value: 1 }] },
          { $source: 'a', timestamp: T, values: [{ value: 1 }, { path: 'b' }] },
          { $source: 'a/b', timestamp: T, values: [{ path: 'c', value: 2, extra: true }] }
        ]
      })
    ).toEqual([
      { $source: 'multihelm.p-abcdef.a_2f_b', timestamp: T, values: [{ path: 'c', value: 2 }] }
    ])
    const delta = { updates: [value('n2k.0', 'a', 1)] }
    expect(relabel({ id: '111111-aaaa', name: 'raspberrypi' }, delta)[0]?.$source).not.toBe(
      relabel({ id: '111111-bbbb', name: 'raspberrypi' }, delta)[0]?.$source
    )
  })

  it('closes the stream of a peer that stopped sharing', async () => {
    const s = await station('stops', { paths: ['tanks.*'], connections: [] })
    let peers: SharingPeer[] = [{ id: 's', name: 's', url: s.url, token: '' }]
    const { r, got } = receiver(() => peers)
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    peers = []
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.4))
    s.sharer.flush()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(got).toEqual([])
  })

  it('sends the units of a path once they are known, though its first value had none', async () => {
    const s = await station('late-meta', { paths: ['tanks.*'], connections: [] })
    const { r, got } = receiver(() => [{ id: 'm', name: 'm', url: s.url, token: '' }])
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.4))
    s.sharer.flush()
    await until(() => got.length === 1)
    expect(got[0]?.meta).toBeUndefined()
    s.meta.set('tanks.fuel.0.currentLevel', { units: 'ratio' })
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.39))
    s.sharer.flush()
    await until(() => got.length === 2)
    expect(got[1]?.meta).toEqual([{ path: 'tanks.fuel.0.currentLevel', value: { units: 'ratio' } }])
  })

  it('opens the stream again with the certificate a peer was paired again with', () => {
    const opened: (string | undefined)[] = []
    let peer: SharingPeer = { id: 'c', name: 'c', url: 'https://127.0.0.1:1', token: '', ca: 'old' }
    const r = new SharedDataReceiver({
      peers: () => [peer],
      open: (p) => {
        opened.push(p.ca)
        return new Promise(() => undefined)
      },
      inject: () => undefined,
      local: () => undefined,
      debug: () => undefined
    })
    receivers.push(r)
    r.check()
    r.check()
    peer = { ...peer, ca: 'new' }
    r.check()
    expect(opened).toEqual(['old', 'new'])
  })

  function fakeClient(sharer: DataSharer, full = false) {
    const written: string[] = []
    let room = !full
    let destroyed = false
    const res = Object.assign(new EventEmitter(), {
      status: () => res,
      set: () => res,
      flushHeaders: () => undefined,
      write: (text: string) => {
        written.push(text)
        return room
      },
      destroy: () => {
        destroyed = true
      },
      end: () => undefined
    })
    sharer.serve({ on: () => undefined } as never, res as never)
    return {
      data: () => written.filter((w) => w.startsWith('data:')),
      fill: (full: boolean) => {
        room = !full
      },
      drain: () => res.emit('drain'),
      destroyed: () => destroyed
    }
  }

  it('waits for a slow peer to drain and then sends only the latest, keeping the others served', () => {
    const sharer = new DataSharer({
      settings: { paths: ['a'], connections: [] },
      selfId: 'signalk-multihelm',
      meta: () => undefined
    })
    const slow = fakeClient(sharer)
    const fast = fakeClient(sharer)
    slow.fill(true)
    for (const v of [1, 2, 3]) {
      sharer.offer(value('s', 'a', v))
      sharer.flush()
    }
    expect(slow.data()).toHaveLength(1)
    expect(fast.data()).toHaveLength(3)
    slow.fill(false)
    slow.drain()
    expect(slow.data()).toHaveLength(2)
    expect(slow.data()[1]).toContain('"value":3')
    expect(slow.data()[1]).not.toContain('"value":2')
    sharer.stop()
  })

  it('writes the replay a piece at a time as the peer drains', () => {
    const sharer = new DataSharer({
      settings: { paths: ['big.*'], connections: [] },
      selfId: 'signalk-multihelm',
      meta: () => undefined
    })
    for (const n of [1, 2, 3]) {
      sharer.offer(value('s', `big.${String(n)}`, 'x'.repeat(150_000)))
    }
    const late = fakeClient(sharer, true)
    expect(late.data()).toHaveLength(1)
    late.drain()
    expect(late.data()).toHaveLength(2)
    late.fill(false)
    late.drain()
    expect(late.data()).toHaveLength(3)
    expect(late.data().join('')).toContain('big.3')
    sharer.stop()
  })

  it('drops a peer whose buffer stays full, and keeps serving the others', () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const sharer = new DataSharer({
      settings: { paths: ['a'], connections: [] },
      selfId: 'signalk-multihelm',
      meta: () => undefined
    })
    const stuck = fakeClient(sharer)
    const fast = fakeClient(sharer)
    stuck.fill(true)
    sharer.offer(value('s', 'a', 1))
    sharer.flush()
    sharer.offer(value('s', 'a', 2))
    clock.mockReturnValue(now + STALL_MS - 1)
    sharer.flush()
    expect(stuck.destroyed()).toBe(false)
    clock.mockReturnValue(now + STALL_MS + 1)
    sharer.flush()
    expect(stuck.destroyed()).toBe(true)
    sharer.offer(value('s', 'a', 3))
    sharer.flush()
    expect(stuck.data()).toHaveLength(1)
    expect(fast.data()).toHaveLength(3)
    clock.mockRestore()
    sharer.stop()
  })

  it('skips an event too long that came in one piece, and takes the next', async () => {
    const stream = new PassThrough()
    const got: SharedUpdate[] = []
    const r = new SharedDataReceiver({
      peers: () => [{ id: 'p', name: 'p', url: 'http://127.0.0.1:1', token: '' }],
      open: () => Promise.resolve({ status: 200, stream: stream as never }),
      inject: (updates) => {
        got.push(...updates)
      },
      local: () => undefined,
      debug: () => undefined
    })
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const long = JSON.stringify({ updates: [value('s', 'a', 'x'.repeat(1_100_000))] })
    const short = JSON.stringify({ updates: [value('s', 'b', 1)] })
    stream.write(`data: ${long}\n\ndata: ${short}\n\n`)
    await until(() => got.length > 0)
    expect(got.map((u) => u.values.map((v) => v.path))).toEqual([['b']])
    expect(stream.destroyed).toBe(false)
  })

  it('takes no value it has a fresh source of its own for, and stands in once that source is quiet', () => {
    const now = Date.parse(T)
    const fresh = new Date(now - 1000).toISOString()
    const stale = new Date(now - OWN_SOURCE_FRESH_MS - 1000).toISOString()
    const nodes: Record<string, unknown> = {
      'same.bus': { value: 1, $source: 'n2k.c0ffee', timestamp: fresh, meta: { units: 'V' } },
      'own.quiet': { value: 1, $source: 'n2k.c0ffee', timestamp: stale },
      'own.ahead': {
        value: 1,
        $source: 'n2k.c0ffee',
        timestamp: new Date(now + 3_600_000).toISOString()
      },
      'shared.only': {
        value: 2,
        $source: 'multihelm.er-abcdef.n2k.1',
        timestamp: fresh,
        values: { 'multihelm.er-abcdef.n2k.1': { value: 2, timestamp: fresh } }
      },
      'two.sources': {
        value: 3,
        $source: 'multihelm.er-abcdef.n2k.1',
        timestamp: fresh,
        values: {
          'multihelm.er-abcdef.n2k.1': { value: 3, timestamp: fresh },
          'can0.7': { value: 3, timestamp: fresh }
        }
      }
    }
    const readings = new OwnReadings((p) => nodes[p])
    const kept = withoutOwn(
      [
        {
          $source: 'multihelm.er-abcdef.n2k.1',
          timestamp: T,
          values: [
            'same.bus',
            'own.quiet',
            'own.ahead',
            'shared.only',
            'two.sources',
            'new.path'
          ].map((p) => ({
            path: p,
            value: 0
          })),
          meta: [
            { path: 'same.bus', value: { units: 'V' } },
            { path: 'new.path', value: { units: 'K' } }
          ]
        }
      ],
      (p) => nodes[p],
      (p) => readings.fresh(p, now)
    )
    expect(kept).toEqual([
      {
        $source: 'multihelm.er-abcdef.n2k.1',
        timestamp: T,
        values: ['own.quiet', 'own.ahead', 'shared.only', 'new.path'].map((p) => ({
          path: p,
          value: 0
        })),
        meta: [{ path: 'new.path', value: { units: 'K' } }]
      }
    ])
  })

  it('ages an own reading by when it came in, whatever clock stamped it', () => {
    const start = Date.parse(T)
    const at = (ms: number) => new Date(start + ms).toISOString()
    const reading = (stamp: string) => ({
      $source: 'n2k.c0ffee',
      timestamp: stamp,
      values: [{ path: 'p', value: 1 }]
    })

    const ahead = { value: 1, $source: 'n2k.c0ffee', timestamp: at(3_600_000) }
    const early = new OwnReadings(() => ahead)
    expect(early.fresh('p', start)).toBe(false)
    ahead.timestamp = at(3_601_000)
    early.note(reading(ahead.timestamp), start + 1000)
    expect(early.fresh('p', start + 1000 + OWN_SOURCE_FRESH_MS)).toBe(true)
    expect(early.fresh('p', start + 2000 + OWN_SOURCE_FRESH_MS)).toBe(false)
    expect(early.fresh('p', start + 3_601_000)).toBe(false)

    const quiet = { value: 1, $source: 'n2k.c0ffee', timestamp: at(3_600_000) }
    const unseen = new OwnReadings(() => quiet)
    expect(unseen.fresh('p', start)).toBe(false)
    quiet.timestamp = at(3_601_000)
    unseen.note(reading(quiet.timestamp), start + 1000)
    expect(unseen.fresh('p', start + 40_000)).toBe(false)

    const behind = { value: 1, $source: 'n2k.c0ffee', timestamp: at(-20_000) }
    const late = new OwnReadings(() => behind)
    expect(late.fresh('p', start)).toBe(true)
    behind.timestamp = at(0)
    late.note(reading(behind.timestamp), start + 20_000)
    expect(late.fresh('p', start + 20_000 + OWN_SOURCE_FRESH_MS)).toBe(true)
    expect(late.fresh('p', start + 20_001 + OWN_SOURCE_FRESH_MS)).toBe(false)

    late.note({ ...reading(at(0)), $source: 'multihelm.er-1.n2k.1' }, start + 60_000)
    expect(late.fresh('p', start + 60_000)).toBe(false)
  })

  it('gives a peer that begins to read the latest value of every shared path', async () => {
    const s = await station('replay', { paths: ['tanks.*'], connections: [] })
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.5))
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.45))
    s.sharer.flush()
    const { r, got } = receiver(() => [{ id: 'r', name: 'r', url: s.url, token: '' }])
    receivers.push(r)
    r.check()
    await until(() => got.length === 1)
    expect(got[0]?.values).toEqual([{ path: 'tanks.fuel.0.currentLevel', value: 0.45 }])
  })

  it('stands in with a value it held back once its own source went quiet, without a new one coming', async () => {
    const s = await station('stand-in', { paths: ['tanks.*'], connections: [] })
    const own = { value: 0.3, $source: 'tank.local', timestamp: new Date().toISOString() }
    const got: SharedUpdate[] = []
    const r = new SharedDataReceiver({
      peers: () => [{ id: 'h', name: 'h', url: s.url, token: '' }],
      open: (peer) => openStream(peer, SHARED_DATA_ROUTE, peer.token),
      inject: (updates) => {
        got.push(...updates)
      },
      local: () => own,
      debug: () => undefined
    })
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.4))
    s.sharer.flush()
    await new Promise((resolve) => setTimeout(resolve, 100))
    r.check()
    expect(got).toEqual([])
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + OWN_SOURCE_FRESH_MS + 1000)
    r.check()
    expect(got.map((u) => u.values)).toEqual([[{ path: 'tanks.fuel.0.currentLevel', value: 0.4 }]])
    r.check()
    clock.mockRestore()
    expect(got).toHaveLength(1)
  })

  it('takes the metadata fields it lacks, and sends fields that turn up later', async () => {
    const kept = withoutOwn(
      [
        {
          $source: 'multihelm.p-1.a',
          timestamp: T,
          values: [],
          meta: [{ path: 'tank', value: { units: 'ratio', displayName: 'Fuel' } }]
        }
      ],
      () => ({ meta: { displayName: 'Diesel' } }),
      () => false
    )
    expect(kept[0]?.meta).toEqual([{ path: 'tank', value: { units: 'ratio' } }])

    const s = await station('meta-later', { paths: ['tanks.*'], connections: [] })
    s.meta.set('tanks.fuel.0.currentLevel', { displayName: 'Fuel' })
    const { r, got } = receiver(() => [{ id: 'l', name: 'l', url: s.url, token: '' }])
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const [v, meta] of [
      [0.5, undefined],
      [0.49, { displayName: 'Fuel', units: 'ratio' }],
      [0.48, undefined]
    ] as const) {
      if (meta) {
        s.meta.set('tanks.fuel.0.currentLevel', meta)
      }
      s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', v))
      s.sharer.flush()
      const before = got.length
      await until(() => got.length > before)
    }
    expect(got.map((u) => u.meta?.[0]?.value)).toEqual([
      { displayName: 'Fuel' },
      { displayName: 'Fuel', units: 'ratio' },
      undefined
    ])
  })

  it('sends long batches in pieces a receiver takes', () => {
    const big = 'x'.repeat(60_000)
    const updates: SharedUpdate[] = [
      {
        $source: 's',
        timestamp: T,
        values: Array.from({ length: 20 }, (_, i) => ({ path: `p.${String(i)}`, value: big }))
      },
      { $source: 's', timestamp: T, values: [{ path: 'too.long', value: 'y'.repeat(300_000) }] }
    ]
    const out = events(updates)
    expect(out.every((e) => e.length < 210_000)).toBe(true)
    const paths = out.flatMap((e) =>
      (JSON.parse(e.slice(6)) as { updates: SharedUpdate[] }).updates.flatMap((u) =>
        u.values.map((v) => v.path)
      )
    )
    expect(paths).toEqual(Array.from({ length: 20 }, (_, i) => `p.${String(i)}`))
  })

  it('puts in nothing it held for a peer that is gone', async () => {
    const s = await station('gone', { paths: ['tanks.*'], connections: [] })
    const own = { value: 0.3, $source: 'tank.local', timestamp: new Date().toISOString() }
    let peers: SharingPeer[] = [{ id: 'g', name: 'g', url: s.url, token: '' }]
    const got: SharedUpdate[] = []
    const r = new SharedDataReceiver({
      peers: () => peers,
      open: (peer) => openStream(peer, SHARED_DATA_ROUTE, peer.token),
      inject: (updates) => {
        got.push(...updates)
      },
      local: () => own,
      debug: () => undefined
    })
    receivers.push(r)
    r.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    s.sharer.offer(value('tank.1', 'tanks.fuel.0.currentLevel', 0.4))
    s.sharer.flush()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + OWN_SOURCE_FRESH_MS + 1000)
    peers = []
    r.check()
    clock.mockRestore()
    expect(got).toEqual([])
  })

  it('counts metadata as sent only with a value that went out', () => {
    const dropped: string[] = []
    events(
      [
        {
          $source: 's',
          timestamp: T,
          values: [{ path: 'huge', value: 'y'.repeat(300_000) }],
          meta: [{ path: 'huge', value: { units: 'm' } }]
        }
      ],
      (p) => dropped.push(p)
    )
    expect(dropped).toEqual(['huge'])
  })

  it('keeps ordinary source names, and never gives two names the same part', () => {
    expect(sourcePart('n2k-er.23', true)).toBe('n2k-er.23')
    const names = [
      'a/b',
      'a-b',
      'a_b',
      'a__b',
      'a_2f_b',
      'a.b',
      '',
      '_',
      'a b',
      'a€b',
      '@signalk/x'
    ]
    const parts = names.map((n) => sourcePart(n, true))
    expect(new Set(parts).size).toBe(names.length)
    expect(sourcePart('a.b', false)).not.toBe(sourcePart('a_2e_b', false))
  })
})
