import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { Multihelm } from '../src/multihelm.js'
import { ROUTE_PREFIX, openStream } from '../src/peer-client.js'
import { registerRoutes } from '../src/routes.js'
import {
  DataSharer,
  SHARED_DATA_ROUTE,
  SharedDataReceiver,
  pathMatcher,
  relabel,
  sharedSource,
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
      'multihelm.engine-room-3f2a1c.n2k-er.23'
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
        $source: `multihelm.backup-${backupId.slice(0, 6)}.j1939.0`,
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
    const p = { id: 'abcdef12', name: 'p' }
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
      { $source: 'multihelm.p-abcdef.a-b', timestamp: T, values: [{ path: 'c', value: 2 }] }
    ])
    const delta = { updates: [value('n2k.0', 'a', 1)] }
    expect(relabel({ id: '111111aa', name: 'raspberrypi' }, delta)[0]?.$source).not.toBe(
      relabel({ id: '222222bb', name: 'raspberrypi' }, delta)[0]?.$source
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
      debug: () => undefined
    })
    receivers.push(r)
    r.check()
    r.check()
    peer = { ...peer, ca: 'new' }
    r.check()
    expect(opened).toEqual(['old', 'new'])
  })

  it('drops a peer that leaves too much unread, and keeps serving the others', () => {
    const sharer = new DataSharer({
      settings: { paths: ['a'], connections: [] },
      selfId: 'signalk-multihelm',
      meta: () => undefined
    })
    const client = (queued: number) => {
      const written: string[] = []
      let destroyed = false
      const res = {
        writableLength: queued,
        status: () => res,
        set: () => res,
        flushHeaders: () => undefined,
        write: (text: string) => written.push(text),
        destroy: () => {
          destroyed = true
        },
        end: () => undefined
      }
      const req = { on: () => undefined }
      sharer.serve(req as never, res as never)
      return { res, written, destroyed: () => destroyed }
    }
    const slow = client(0)
    const fast = client(0)
    slow.res.writableLength = 2_000_000
    sharer.offer(value('s', 'a', 1))
    sharer.flush()
    sharer.offer(value('s', 'a', 2))
    sharer.flush()
    expect(slow.destroyed()).toBe(true)
    expect(slow.written).toHaveLength(1)
    expect(fast.written.filter((w) => w.startsWith('data:'))).toHaveLength(2)
    sharer.stop()
  })
})
