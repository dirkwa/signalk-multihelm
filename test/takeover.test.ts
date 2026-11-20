import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MASTER_STALE_MS, Multihelm, TAKEOVER_MS } from '../src/multihelm.js'
import { ROUTE_PREFIX } from '../src/peer-client.js'
import { registerRoutes } from '../src/routes.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-takeover-'))

interface Station {
  name: string
  mh: Multihelm
  url: string
  /** While set, the station answers no one, as when its network is gone. */
  down: boolean
  server: http.Server
}

const stations: Station[] = []

async function station(name: string, master: boolean, standby = 0): Promise<Station> {
  const mh = new Multihelm(new MultihelmStore(path.join(root, name)), {
    serverName: () => name,
    isMaster: () => master,
    standby: () => standby,
    debug: () => undefined,
    error: () => undefined
  })
  const app = express()
  const s = { name, mh, url: '', down: false } as Station
  app.use((_req, res, next) => {
    if (s.down) {
      res.sendStatus(503)
      return
    }
    next()
  })
  const router = express.Router()
  registerRoutes(
    router,
    () => mh,
    () => []
  )
  app.use(ROUTE_PREFIX, router)
  s.server = http.createServer(app)
  await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve))
  s.url = `http://127.0.0.1:${String((s.server.address() as AddressInfo).port)}`
  stations.push(s)
  return s
}

/** Pairs every station with every other one. */
async function boat(...all: Station[]): Promise<void> {
  for (const s of all) {
    for (const other of all) {
      if (other !== s) {
        await s.mh.pair(other.url)
      }
    }
  }
  await check(...all)
}

/** Each station asks the others, twice, so every one has the others' latest answer. */
async function check(...all: Station[]): Promise<void> {
  for (let i = 0; i < 2; i++) {
    for (const s of all) {
      if (!s.down) {
        await s.mh.checkMasters()
      }
    }
  }
}

let now = Date.now()

function pass(ms: number): void {
  now += ms
  vi.setSystemTime(now)
}

afterAll(() => {
  for (const s of stations) {
    s.server.close()
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a server that takes over as master', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    now = Date.now()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes over once the master has been gone long enough, while it reaches most servers', async () => {
    const salon = await station('t1-salon', true)
    const port = await station('t1-port', false, 1)
    const stbd = await station('t1-stbd', false, 2)
    await boat(salon, port, stbd)
    expect(salon.mh.role()).toBe('master')
    expect(port.mh.master()?.name).toBe('t1-salon')

    salon.down = true
    pass(MASTER_STALE_MS + 1)
    await check(port, stbd)
    expect(port.mh.role()).toBe('member')
    expect(port.mh.master()).toBeNull()

    pass(TAKEOVER_MS - MASTER_STALE_MS)
    await check(port, stbd)
    expect(port.mh.role()).toBe('master')
    expect(stbd.mh.role()).toBe('member')
    expect(stbd.mh.masterElsewhere()).toBe(true)
    await vi.waitFor(async () => {
      await stbd.mh.checkMasters()
      expect(stbd.mh.master()?.name).toBe('t1-port')
    })
  })

  it('stops acting as master when cut off from most servers', async () => {
    const salon = await station('t2-salon', true)
    const port = await station('t2-port', false, 1)
    const stbd = await station('t2-stbd', false, 2)
    await boat(salon, port, stbd)
    port.down = true
    stbd.down = true
    pass(MASTER_STALE_MS + 1)
    await check(salon)
    expect(salon.mh.hasMajority()).toBe(false)
    expect(salon.mh.role()).toBe('member')
    expect(salon.mh.masterElsewhere()).toBe(false)
  })

  it('hands the role back to the master set by hand, which waits until the other stops', async () => {
    const salon = await station('t3-salon', true)
    const port = await station('t3-port', false, 1)
    const stbd = await station('t3-stbd', false, 2)
    await boat(salon, port, stbd)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    await check(port, stbd)
    expect(port.mh.role()).toBe('master')

    const changes: string[] = []
    salon.mh.onRoleChanged((role) => {
      changes.push(`salon ${role}`)
    })
    port.mh.onRoleChanged((role) => {
      changes.push(`port ${role}`)
    })
    salon.down = false
    await vi.waitFor(async () => {
      await salon.mh.checkMasters()
      expect(salon.mh.role()).toBe('master')
    })
    expect(port.mh.role()).toBe('member')
    // Back, the salon sees the port still acting, and becomes the master only once it has stopped.
    expect(changes).toEqual(['salon member', 'port member', 'salon master'])
    await vi.waitFor(async () => {
      await stbd.mh.checkMasters()
      expect(stbd.mh.master()?.name).toBe('t3-salon')
    })
  })

  it('on a boat of two, keeps the master set by hand alone and never makes the other one master', async () => {
    const salon = await station('t4-salon', true)
    const port = await station('t4-port', false, 1)
    await boat(salon, port)

    port.down = true
    pass(TAKEOVER_MS + 1)
    await check(salon)
    expect(salon.mh.role()).toBe('master')

    port.down = false
    salon.down = true
    pass(TAKEOVER_MS + 1)
    await check(port)
    expect(port.mh.hasMajority()).toBe(false)
    expect(port.mh.role()).toBe('member')
  })

  it('is the one with the lowest place when several may take over', async () => {
    const port = await station('t5-port', false, 2)
    const stbd = await station('t5-stbd', false, 1)
    await boat(port, stbd)
    expect(stbd.mh.role()).toBe('master')
    expect(port.mh.master()?.name).toBe('t5-stbd')
  })
})

describe('a boat where no server may take over', () => {
  it('keeps the master set by hand alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    now = Date.now()
    const salon = await station('t6-salon', true)
    const port = await station('t6-port', false)
    const stbd = await station('t6-stbd', false)
    await boat(salon, port, stbd)
    port.down = true
    stbd.down = true
    pass(TAKEOVER_MS + 1)
    await check(salon)
    expect(salon.mh.hasMajority()).toBe(true)
    expect(salon.mh.role()).toBe('master')
    vi.useRealTimers()
  })
})
