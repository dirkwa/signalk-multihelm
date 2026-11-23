import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MASTER_STALE_MS,
  Multihelm,
  TAKEOVER_MS,
  VOTE_COUNT_MS,
  VOTE_HOLD_MS
} from '../src/multihelm.js'
import { ROUTE_PREFIX, type Hello } from '../src/peer-client.js'
import { masterPluginsWanted } from '../src/master-plugins.js'
import { registerRoutes } from '../src/routes.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-takeover-'))

interface Station {
  name: string
  mh: Multihelm
  url: string
  /** While set, the station answers no one, as when its network is gone. */
  down: boolean
  /** Server ids it does not answer, as when one link is gone. */
  refuses: Set<string>
  /** Answers as a Multihelm that does not say whether it acts. */
  legacy: boolean
  /** Plugins that run on the master only still run here. */
  pluginsRunning: boolean
  /** Its place to take over as master; the user may change it. */
  standby: number
  /** Its answers to these server ids take this long, as on a slow link. */
  stalls: Map<string, number>
  server: http.Server
}

const stations: Station[] = []

function multihelmOf(s: Station, master: boolean, standby: number): Multihelm {
  s.standby = standby
  return new Multihelm(new MultihelmStore(path.join(root, s.name)), {
    serverName: () => s.name,
    isMaster: () => master,
    standby: () => s.standby,
    stillRunning: () => s.pluginsRunning,
    debug: () => undefined,
    error: () => undefined
  })
}

async function station(name: string, master: boolean, standby = 0): Promise<Station> {
  const app = express()
  const s = {
    name,
    url: '',
    down: false,
    refuses: new Set(),
    legacy: false,
    pluginsRunning: false,
    stalls: new Map()
  } as unknown as Station
  s.mh = multihelmOf(s, master, standby)
  app.use((req, res, next) => {
    const from = typeof req.query.from === 'string' ? req.query.from : ''
    if (s.down || s.refuses.has(from)) {
      res.sendStatus(503)
      return
    }
    const stall = s.stalls.get(from)
    if (stall !== undefined && req.path.endsWith('/hello')) {
      pass(stall)
    }
    if (s.legacy && req.path.endsWith('/hello')) {
      const old: Partial<Hello> = { ...s.mh.hello() }
      delete old.acting
      delete old.elects
      delete old.standby
      res.json(old)
      return
    }
    next()
  })
  const router = express.Router()
  registerRoutes(
    router,
    () => s.mh,
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
    // Back, the salon waits for the votes the others still hold for the port.
    for (let t = 0; t < 20 && salon.mh.role() !== 'master'; t++) {
      pass(10_000)
      await check(salon, port, stbd)
      expect(salon.mh.role() === 'master' && port.mh.role() === 'master').toBe(false)
    }
    expect(salon.mh.role()).toBe('master')
    expect(port.mh.role()).toBe('member')
    // The salon sees the port still acting, and becomes the master only once it has stopped.
    // The port hears of its new master too, as a member still.
    expect(changes).toEqual(['salon member', 'port member', 'salon master', 'port member'])
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
    expect(stbd.mh.role()).toBe('member')

    pass(TAKEOVER_MS + 1)
    await check(port, stbd)
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

describe('a takeover that must not happen twice', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    now = Date.now()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the master set by hand from acting alone after a restart, as it knows a server may take over', async () => {
    const salon = await station('t7-salon', true)
    const port = await station('t7-port', false, 1)
    const stbd = await station('t7-stbd', false)
    await boat(salon, port, stbd)
    port.down = true
    stbd.down = true

    salon.mh = multihelmOf(salon, true, 0)
    await check(salon)
    expect(salon.mh.hasMajority()).toBe(false)
    expect(salon.mh.role()).toBe('member')
  })

  it('never takes over beside a server that does not say whether it acts', async () => {
    const salon = await station('t8-salon', true)
    const port = await station('t8-port', false, 1)
    const stbd = await station('t8-stbd', false)
    salon.legacy = true
    await boat(salon, port, stbd)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    await check(port, stbd)
    expect(port.mh.role()).toBe('member')
  })

  it('makes only one master when two that may take over share the servers between them', async () => {
    const salon = await station('t9-salon', true)
    const b = await station('t9-b', false, 1)
    const c = await station('t9-c', false, 2)
    const d = await station('t9-d', false)
    const e = await station('t9-e', false)
    await boat(salon, b, c, d, e)
    salon.down = true
    b.refuses.add(c.mh.serverId)
    c.refuses.add(b.mh.serverId)
    pass(TAKEOVER_MS + 1)
    for (let i = 0; i < 3; i++) {
      await check(b, c, d, e)
    }
    expect(b.mh.role()).toBe('master')
    expect(c.mh.role()).toBe('member')
  })

  it('never makes two masters while the servers between them change their vote', async () => {
    const salon = await station('t11-salon', true)
    const b = await station('t11-b', false, 1)
    const c = await station('t11-c', false, 2)
    const d = await station('t11-d', false)
    const e = await station('t11-e', false)
    await boat(salon, b, c, d, e)
    salon.down = true
    b.refuses.add(c.mh.serverId)
    c.refuses.add(b.mh.serverId)
    pass(TAKEOVER_MS + 1)
    for (let i = 0; i < 3; i++) {
      await check(b, c, d, e)
    }
    expect(b.mh.role()).toBe('master')

    // D and E stop reaching B first, while B still gets their votes; then B loses them too.
    for (const s of [d, e]) {
      b.refuses.add(s.mh.serverId)
    }
    let cBecameMaster = false
    for (let t = 0; t < 24; t++) {
      if (t === 7) {
        for (const s of [d, e]) {
          s.refuses.add(b.mh.serverId)
        }
      }
      pass(15_000)
      await check(b, c, d, e)
      expect(b.mh.role() === 'master' && c.mh.role() === 'master').toBe(false)
      cBecameMaster ||= c.mh.role() === 'master'
    }
    expect(cBecameMaster).toBe(true)
    expect(b.mh.role()).toBe('member')
  })

  it('counts a vote from when it asked for it, however long the answer took', async () => {
    const b = await station('t12-b', false, 1)
    const d = await station('t12-d', false)
    const e = await station('t12-e', false)
    await boat(b, d, e)
    pass(TAKEOVER_MS + 1)
    await check(b, d, e)
    expect(b.mh.role()).toBe('master')

    e.refuses.add(b.mh.serverId)
    d.stalls.set(b.mh.serverId, VOTE_COUNT_MS - 10_000)
    await b.mh.checkMasters()
    expect(b.mh.role()).toBe('master')

    d.refuses.add(b.mh.serverId)
    pass(10_001)
    expect(b.mh.role()).toBe('member')
  })

  it('counts its own vote only once it no longer holds it for another server', async () => {
    const b = await station('t13-b', false, 1)
    const c = await station('t13-c', false, 2)
    const d = await station('t13-d', false)
    await boat(b, c, d)
    pass(TAKEOVER_MS + 1)
    await check(b, c, d)
    expect(b.mh.role()).toBe('master')

    // C and D stop hearing B, and D answers no one; B still hears C, which voted for it, until C is cut off as well.
    b.refuses.add(c.mh.serverId)
    b.refuses.add(d.mh.serverId)
    d.refuses.add(b.mh.serverId)
    d.refuses.add(c.mh.serverId)
    let cBecameMaster = false
    for (let t = 0; t < 40; t++) {
      if (t === 14) {
        c.refuses.add(b.mh.serverId)
      }
      if (t === 15) {
        d.refuses.delete(c.mh.serverId)
      }
      pass(10_000)
      for (const s of [b, c, d]) {
        await s.mh.checkMasters()
      }
      expect(b.mh.role() === 'master' && c.mh.role() === 'master').toBe(false)
      cBecameMaster ||= c.mh.role() === 'master'
    }
    expect(cBecameMaster).toBe(true)
  })

  it('takes over only once every server knows it may', async () => {
    const salon = await station('t14-salon', true)
    const b = await station('t14-b', false)
    const c = await station('t14-c', false)
    await boat(salon, b, c)
    salon.down = true
    // Set to take over while the master set by hand cannot hear of it.
    b.standby = 1
    pass(TAKEOVER_MS + 1)
    for (let i = 0; i < 3; i++) {
      await check(b, c)
    }
    expect(c.mh.master()).toBeNull()
    expect(b.mh.role()).toBe('member')
    expect(b.mh.electedWithout()).toBe(true)
    expect(masterPluginsWanted(b.mh)).toBe(false)

    salon.down = false
    salon.refuses.add(b.mh.serverId)
    salon.refuses.add(c.mh.serverId)
    await check(salon, b, c)
    expect(b.mh.role()).toBe('member')
  })

  it('stands down a takeover that lost its votes while it still reaches most servers', async () => {
    const b = await station('t15-b', false, 1)
    const c = await station('t15-c', false, 2)
    const d = await station('t15-d', false)
    await boat(b, c, d)
    pass(TAKEOVER_MS + 1)
    await check(b, c, d)
    expect(b.mh.role()).toBe('master')

    // C and D stop hearing B; B still hears C, so it reaches most servers but loses their votes.
    b.refuses.add(c.mh.serverId)
    b.refuses.add(d.mh.serverId)
    d.refuses.add(b.mh.serverId)
    for (let t = 0; t < 30 && b.mh.role() === 'master'; t++) {
      pass(10_000)
      await check(b, c, d)
    }
    expect(b.mh.role()).toBe('member')
    expect(b.mh.hasMajority()).toBe(true)
    expect(b.mh.electedWithout()).toBe(true)
    expect(masterPluginsWanted(b.mh)).toBe(false)
  })

  it('hands back to a master set by hand that cannot reach the acting one only once its votes are gone', async () => {
    const salon = await station('t16-salon', true)
    const b = await station('t16-b', false, 1)
    const c = await station('t16-c', false)
    const d = await station('t16-d', false)
    await boat(salon, b, c, d)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    for (let i = 0; i < 2; i++) {
      await check(b, c, d)
    }
    expect(b.mh.role()).toBe('master')

    // The salon comes back, but it and B cannot reach each other.
    salon.down = false
    salon.refuses.add(b.mh.serverId)
    b.refuses.add(salon.mh.serverId)
    let salonBecameMaster = false
    for (let t = 0; t < 20; t++) {
      pass(10_000)
      for (const s of [b, salon, c, d]) {
        await s.mh.checkMasters()
      }
      expect(salon.mh.role() === 'master' && b.mh.role() === 'master').toBe(false)
      salonBecameMaster ||= salon.mh.role() === 'master'
    }
    expect(salonBecameMaster).toBe(true)
  })

  it('hands back to a master set by hand that cannot reach the acting one only once its plugins have stopped', async () => {
    const salon = await station('t17-salon', true)
    const b = await station('t17-b', false, 1)
    const c = await station('t17-c', false)
    const d = await station('t17-d', false)
    await boat(salon, b, c, d)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    for (let i = 0; i < 2; i++) {
      await check(b, c, d)
    }
    expect(b.mh.role()).toBe('master')

    // B cannot stop its plugins, and it and the salon cannot reach each other.
    b.pluginsRunning = true
    salon.down = false
    salon.refuses.add(b.mh.serverId)
    b.refuses.add(salon.mh.serverId)
    const round = async (): Promise<void> => {
      pass(10_000)
      for (const s of [b, salon, c, d]) {
        await s.mh.checkMasters()
      }
    }
    for (let t = 0; t < 20; t++) {
      await round()
      expect(salon.mh.role()).toBe('member')
    }
    expect(b.mh.role()).toBe('member')
    expect(masterPluginsWanted(b.mh)).toBe(false)

    b.pluginsRunning = false
    for (let t = 0; t < 20 && salon.mh.role() !== 'master'; t++) {
      await round()
    }
    expect(salon.mh.role()).toBe('master')
  })

  it('stops the plugins on a master set by hand that reaches most servers but lost their votes', async () => {
    const salon = await station('t18-salon', true)
    const b = await station('t18-b', false, 1)
    const c = await station('t18-c', false)
    const d = await station('t18-d', false)
    await boat(salon, b, c, d)
    expect(salon.mh.role()).toBe('master')

    // The salon still hears the others, but they no longer hear it.
    for (const s of [b, c, d]) {
      salon.refuses.add(s.mh.serverId)
    }
    for (let t = 0; t < 30 && salon.mh.role() === 'master'; t++) {
      pass(10_000)
      await check(salon, b, c, d)
    }
    expect(salon.mh.role()).toBe('member')
    expect(salon.mh.hasMajority()).toBe(true)
    expect(masterPluginsWanted(salon.mh)).toBe(false)
  })

  it('stops the plugins on a server that knows no master yet but sees another one acting', async () => {
    const salon = await station('t19-salon', true)
    const port = await station('t19-port', false, 1)
    const stbd = await station('t19-stbd', false)
    await boat(salon, port, stbd)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    await check(port, stbd)
    expect(port.mh.role()).toBe('master')
    port.pluginsRunning = true

    stbd.mh = multihelmOf(stbd, false, 0)
    await check(port, stbd)
    expect(stbd.mh.masterElsewhere()).toBe(false)
    expect(stbd.mh.hasMajority()).toBe(true)
    expect(masterPluginsWanted(stbd.mh)).toBe(false)
  })

  // Known limits: an old master that cannot stop its plugins and is seen by too few servers to deny the votes.
  it('hands back while the acting standby cannot stop its plugins, once only a minority still sees it', async () => {
    const salon = await station('t20-salon', true)
    const b = await station('t20-b', false, 1)
    const c = await station('t20-c', false)
    const d = await station('t20-d', false)
    await boat(salon, b, c, d)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    for (let i = 0; i < 2; i++) {
      await check(b, c, d)
    }
    expect(b.mh.role()).toBe('master')

    // Only C still reaches B, whose plugins will not stop.
    b.pluginsRunning = true
    salon.down = false
    for (const [x, y] of [
      [b, salon],
      [b, d]
    ] as const) {
      x.refuses.add(y.mh.serverId)
      y.refuses.add(x.mh.serverId)
    }
    for (let t = 0; t < 30 && salon.mh.role() !== 'master'; t++) {
      pass(10_000)
      for (const s of [b, salon, c, d]) {
        await s.mh.checkMasters()
      }
    }
    expect(salon.mh.role()).toBe('master')
    expect(masterPluginsWanted(b.mh)).toBe(false)
  })

  it('takes over beside a master that cannot stop its plugins and is seen by a minority only', async () => {
    const a = await station('t21-a', true)
    const b = await station('t21-b', false, 1)
    const c = await station('t21-c', false)
    const d = await station('t21-d', false)
    const e = await station('t21-e', false)
    await boat(a, b, c, d, e)
    expect(a.mh.role()).toBe('master')

    // Only C still reaches A, whose plugins will not stop.
    a.pluginsRunning = true
    for (const other of [b, d, e]) {
      a.refuses.add(other.mh.serverId)
      other.refuses.add(a.mh.serverId)
    }
    for (let t = 0; t < 40 && b.mh.role() !== 'master'; t++) {
      pass(10_000)
      await check(a, b, c, d, e)
    }
    expect(b.mh.role()).toBe('master')
    expect(a.mh.hasMajority()).toBe(false)
    expect(masterPluginsWanted(a.mh)).toBe(false)
  })

  it('still acts until the plugins that run on the master only have stopped', async () => {
    const salon = await station('t10-salon', true)
    const port = await station('t10-port', false, 1)
    const stbd = await station('t10-stbd', false)
    await boat(salon, port, stbd)
    salon.down = true
    pass(TAKEOVER_MS + 1)
    await check(port, stbd)
    expect(port.mh.role()).toBe('master')
    port.pluginsRunning = true

    salon.down = false
    await check(salon, port, stbd)
    expect(port.mh.role()).toBe('member')
    expect(salon.mh.role()).toBe('member')

    pass(VOTE_HOLD_MS)
    await check(salon, port, stbd)
    expect(salon.mh.role()).toBe('member')

    port.pluginsRunning = false
    port.mh.actingChanged()
    await vi.waitFor(async () => {
      await salon.mh.checkMasters()
      expect(salon.mh.role()).toBe('master')
    })
  })
})
