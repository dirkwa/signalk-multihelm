import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { AutopilotProvider, Value } from '@signalk/server-api'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  AUTOPILOTS_PATH,
  AutopilotError,
  MasterAutopilot,
  type AutopilotHost
} from '../src/autopilot-from-master.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-autopilot-'))

interface Command {
  method: string
  url: string
  auth: string | undefined
  body: unknown
}

describe("the master's autopilot on another server", () => {
  const commands: Command[] = []
  let security = false
  let approval: 'PENDING' | 'APPROVED' = 'APPROVED'
  let state = 'standby'
  let master: { server: http.Server; url: string }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.post('/signalk/v1/access/requests', (_req, res) => {
      if (!security) {
        res.sendStatus(404)
        return
      }
      res.status(202).json({ state: 'PENDING', href: '/signalk/v1/requests/7' })
    })
    app.get('/signalk/v1/requests/7', (_req, res) => {
      res.json(
        approval === 'APPROVED'
          ? { state: 'COMPLETED', accessRequest: { permission: 'APPROVED', token: 'rw-token' } }
          : { state: 'PENDING', href: '/signalk/v1/requests/7' }
      )
    })
    app.get(AUTOPILOTS_PATH, (_req, res) => {
      res.json({ raymarine: { provider: 'raymarine-autopilot', isDefault: true } })
    })
    app.get(`${AUTOPILOTS_PATH}/:id`, (_req, res) => {
      res.json({
        options: { states: [], modes: ['compass'], actions: [{ id: 'tack', available: true }] },
        target: 0.5,
        mode: 'compass',
        state,
        engaged: state === 'auto'
      })
    })
    app.get(`${AUTOPILOTS_PATH}/:id/state`, (_req, res) => {
      res.json({ value: state })
    })
    app.use(AUTOPILOTS_PATH, (req, res) => {
      commands.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: req.body as unknown
      })
      if (security && req.headers.authorization !== 'Bearer rw-token') {
        res.sendStatus(403)
        return
      }
      if (req.url.endsWith('/engage')) {
        state = 'auto'
      }
      res.json({ state: 'COMPLETED', statusCode: 200 })
    })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    master = { server, url: `http://127.0.0.1:${String(port)}` }
  })

  afterAll(() => {
    master.server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    commands.length = 0
    security = false
    approval = 'APPROVED'
    state = 'standby'
  })

  interface Made {
    autopilot: MasterAutopilot
    provider: () => AutopilotProvider
    registered: string[][]
    updates: { device: string; info: Record<string, Value> }[]
    withdrawn: () => number
    setMaster: (value: boolean) => void
  }

  function make(name: string): Made {
    let provider: AutopilotProvider | null = null
    const registered: string[][] = []
    const updates: { device: string; info: Record<string, Value> }[] = []
    let withdrawn = 0
    let isMaster = false
    const host: AutopilotHost = {
      store: new MultihelmStore(path.join(root, name)),
      serverId: 'port',
      master: () =>
        isMaster ? null : { id: 'salon', access: { url: master.url, token: 'pairing-token' } },
      isMaster: () => isMaster,
      register: (p, devices) => {
        provider = p
        registered.push(devices)
      },
      unregister: () => {
        withdrawn++
      },
      update: (device, info) => {
        updates.push({ device, info })
      },
      debug: () => undefined,
      error: () => undefined
    }
    return {
      autopilot: new MasterAutopilot(host),
      provider: () => {
        if (!provider) {
          throw new Error('not registered')
        }
        return provider
      },
      registered,
      updates,
      withdrawn: () => withdrawn,
      setMaster: (value) => {
        isMaster = value
      }
    }
  }

  it("registers the master's devices and sends commands on to it", async () => {
    const m = make('open')
    await m.autopilot.findDevices()
    expect(m.registered).toEqual([['raymarine']])

    await m.provider().engage('raymarine')
    await m.provider().adjustTarget(0.1, 'raymarine')
    await m.provider().tack('port', 'raymarine')
    await m.provider().dodge(null, 'raymarine')
    expect(commands.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /raymarine/engage',
      'PUT /raymarine/target/adjust',
      'POST /raymarine/tack/port',
      'DELETE /raymarine/dodge'
    ])
    expect(commands[1]?.body).toEqual({ value: 0.1, units: 'rad' })
    expect(await m.provider().getState('raymarine')).toBe('auto')
  })

  it("publishes the master's state here, only when it changes", async () => {
    const m = make('state')
    await m.autopilot.findDevices()
    await m.autopilot.pollState()
    await m.autopilot.pollState()
    expect(m.updates).toEqual([
      {
        device: 'raymarine',
        info: {
          state: 'standby',
          mode: 'compass',
          target: 0.5,
          engaged: false,
          actions: [{ id: 'tack', available: true }]
        }
      }
    ])
    state = 'auto'
    await m.autopilot.pollState()
    expect(m.updates.at(-1)?.info).toMatchObject({ state: 'auto', engaged: true })
  })

  it('sends no command before the request on the master is approved, and says so', async () => {
    security = true
    approval = 'PENDING'
    const m = make('secure')
    await m.autopilot.findDevices()
    expect(m.autopilot.waitingForApproval()).toEqual({
      masterId: 'salon',
      request: 'signalk-multihelm-control-port'
    })
    await expect(m.provider().engage('raymarine')).rejects.toBeInstanceOf(AutopilotError)
    expect(commands).toEqual([])

    approval = 'APPROVED'
    await m.provider().engage('raymarine')
    expect(commands.map((c) => c.auth)).toEqual(['Bearer rw-token'])
    expect(m.autopilot.waitingForApproval()).toBeNull()
  })

  it('steps aside on the master, so its own provider gets the devices', async () => {
    const m = make('role')
    await m.autopilot.findDevices()
    m.setMaster(true)
    m.autopilot.roleChanged()
    expect(m.withdrawn()).toBe(1)
    await expect(m.provider().engage('raymarine')).rejects.toThrow('no other server is the master')
    await m.autopilot.findDevices()
    expect(m.registered).toHaveLength(1)
  })
})
