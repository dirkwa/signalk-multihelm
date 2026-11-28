import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { ServerAPI } from '@signalk/server-api'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROPERTY_NAME, type MultihelmProperty } from '../src/api.js'
import { BoatMaster, masterOnStart, type MasterChoice } from '../src/boat-master.js'
import createPlugin from '../src/index.js'
import { Multihelm } from '../src/multihelm.js'
import type { PlanControl } from '../src/plan.js'
import { registerRoutes } from '../src/routes.js'
import { MultihelmStore } from '../src/store.js'

const ME = 'me'
const OTHER = 'other'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-master-'))
})
// A round still running when a test stopped the plugin saves its state when it ends.
const ROUND_SETTLE_MS = 300

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, ROUND_SETTLE_MS))
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('the master setting when a server starts', () => {
  it('stays as the user set it while the boat has no choice', () => {
    expect(masterOnStart(ME, true, null, null)).toEqual({
      action: 'record',
      applied: { master: true, term: 0 }
    })
    expect(masterOnStart(ME, false, { master: false, term: 0 }, null)).toEqual({
      action: 'record',
      applied: { master: false, term: 0 }
    })
  })

  it("follows the boat's choice, also on the first start with it", () => {
    expect(masterOnStart(ME, true, null, { serverId: OTHER, term: 4 })).toEqual({
      action: 'apply',
      applied: { master: false, term: 4 }
    })
    expect(masterOnStart(ME, false, { master: false, term: 3 }, { serverId: ME, term: 4 })).toEqual(
      { action: 'apply', applied: { master: true, term: 4 } }
    )
    expect(masterOnStart(ME, true, { master: true, term: 3 }, { serverId: '', term: 4 })).toEqual({
      action: 'apply',
      applied: { master: false, term: 4 }
    })
    expect(masterOnStart(ME, true, { master: true, term: 4 }, { serverId: ME, term: 4 })).toEqual({
      action: 'record',
      applied: { master: true, term: 4 }
    })
  })

  it('makes a change in the plugin settings the boat’s choice', () => {
    expect(masterOnStart(ME, true, { master: false, term: 0 }, null)).toEqual({
      action: 'publish',
      choice: { serverId: ME, term: 1 }
    })
    expect(
      masterOnStart(ME, true, { master: false, term: 4 }, { serverId: OTHER, term: 4 })
    ).toEqual({ action: 'publish', choice: { serverId: ME, term: 5 } })
    expect(masterOnStart(ME, false, { master: true, term: 4 }, { serverId: ME, term: 4 })).toEqual({
      action: 'publish',
      choice: { serverId: '', term: 5 }
    })
  })

  it('publishes nothing for a change the choice already says', () => {
    expect(masterOnStart(ME, false, { master: true, term: 0 }, null)).toEqual({
      action: 'record',
      applied: { master: false, term: 0 }
    })
    expect(
      masterOnStart(ME, false, { master: true, term: 4 }, { serverId: OTHER, term: 5 })
    ).toEqual({ action: 'record', applied: { master: false, term: 5 } })
  })
})

describe("the boat's choice of master", () => {
  function boatMaster(fail: () => boolean = () => false): {
    master: BoatMaster
    chosen: MasterChoice[]
    changed: () => number
  } {
    const chosen: MasterChoice[] = []
    let changes = 0
    const master = new BoatMaster({
      dir: path.join(dir, 'master'),
      chosen: (choice) => {
        chosen.push(choice)
        return fail() ? Promise.reject(new Error('cannot save')) : Promise.resolve()
      },
      changed: () => {
        changes++
      }
    })
    return { master, chosen, changed: () => changes }
  }

  it('takes each choice one term past the last, and keeps it', async () => {
    const { master, chosen, changed } = boatMaster()
    expect(master.choice()).toBeNull()
    expect(await master.choose(ME)).toEqual({ serverId: ME, term: 1 })
    expect(await master.choose(OTHER)).toEqual({ serverId: OTHER, term: 2 })
    expect(chosen).toEqual([
      { serverId: ME, term: 1 },
      { serverId: OTHER, term: 2 }
    ])
    expect(changed()).toBe(2)
    expect(boatMaster().master.choice()).toEqual({ serverId: OTHER, term: 2 })
    expect(await master.dataset.list()).toEqual([
      { key: 'master', meta: { serverId: OTHER, term: 2 }, files: [] }
    ])
  })

  it("takes a peer's choice over, and only a well-formed one", async () => {
    const { master, chosen, changed } = boatMaster()
    await master.dataset.apply({ key: 'master', meta: { serverId: OTHER, term: 7 }, files: [] })
    expect(master.choice()).toEqual({ serverId: OTHER, term: 7 })
    expect(chosen).toEqual([{ serverId: OTHER, term: 7 }])
    expect(changed()).toBe(0)
    for (const meta of [
      { serverId: OTHER },
      { serverId: '../x', term: 8 },
      { serverId: ME, term: 0 }
    ]) {
      await expect(master.dataset.apply({ key: 'master', meta, files: [] })).rejects.toThrow()
    }
    expect(master.dataset.isValidKey?.('master')).toBe(true)
    expect(master.dataset.isValidKey?.('server-x')).toBe(false)
    expect(await master.dataset.remove('master')).toBe(false)
  })

  it('keeps a later choice of its own over a peer’s, of two at once the larger server id', async () => {
    const { master, chosen } = boatMaster()
    await master.choose(ME)
    await master.choose(ME)
    const entry = (serverId: string, term: number) => ({
      key: 'master',
      meta: { serverId, term },
      files: []
    })
    expect(await master.dataset.apply(entry(OTHER, 1))).toBe(false)
    expect(master.choice()).toEqual({ serverId: ME, term: 2 })
    expect(await master.dataset.apply(entry('aa', 2))).toBe(false)
    expect(await master.dataset.apply(entry(OTHER, 2))).toBe(true)
    expect(master.choice()).toEqual({ serverId: OTHER, term: 2 })
    expect(await master.dataset.apply(entry(ME, 3))).toBe(true)
    expect(master.choice()).toEqual({ serverId: ME, term: 3 })
    expect(chosen.map((c) => c.term)).toEqual([1, 2, 2, 3])
  })

  it('fails a choice it cannot apply, and applies it again when it comes again', async () => {
    let failing = true
    const { master, chosen } = boatMaster(() => failing)
    const entry = { key: 'master', meta: { serverId: ME, term: 4 }, files: [] }
    await expect(master.dataset.apply(entry)).rejects.toThrow('cannot save')
    failing = false
    expect(await master.dataset.apply(entry)).toBe(true)
    expect(chosen).toEqual([
      { serverId: ME, term: 4 },
      { serverId: ME, term: 4 }
    ])
  })

  it('offers a choice made here only once applied, and keeps the one before when it fails', async () => {
    let failing = false
    const { master, changed } = boatMaster(() => failing)
    await master.choose(ME)
    failing = true
    await expect(master.choose(OTHER)).rejects.toThrow('cannot save')
    expect(master.choice()).toEqual({ serverId: ME, term: 1 })
    expect(await master.dataset.list()).toEqual([
      { key: 'master', meta: { serverId: ME, term: 1 }, files: [] }
    ])
    expect(changed()).toBe(1)
    expect(boatMaster().master.choice()).toEqual({ serverId: ME, term: 1 })

    fs.rmSync(path.join(dir, 'master'), { recursive: true })
    const { master: first } = boatMaster(() => true)
    await expect(first.choose(ME)).rejects.toThrow('cannot save')
    expect(boatMaster().master.choice()).toBeNull()
  })
})

describe('the route that chooses the master', () => {
  async function put(serverId: unknown): Promise<number> {
    const mh = new Multihelm(new MultihelmStore(path.join(dir, 'data')), {
      serverName: () => 'salon',
      isMaster: () => false,
      debug: () => undefined,
      error: () => undefined
    })
    mh.sawPairedServer({ serverId: 'odd.id', name: 'odd' })
    mh.sawPairedServer({ serverId: 'nav-1', name: 'nav' })
    const master = new BoatMaster({
      dir: path.join(dir, 'master'),
      chosen: () => Promise.resolve(),
      changed: () => undefined
    })
    const e = express()
    e.use(express.json())
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
      undefined,
      undefined,
      () => ({ master }) as unknown as PlanControl
    )
    e.use(router)
    const server = e.listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${String(port)}/master`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId })
      })
      return res.status
    } finally {
      server.close()
      mh.stop()
    }
  }

  it('takes a server of the boat or none, and no id a stored choice could not hold', async () => {
    expect(await put('nav-1')).toBe(200)
    expect(await put('')).toBe(200)
    expect(await put('odd.id')).toBe(400)
    expect(await put('elsewhere')).toBe(400)
    expect(await put(7)).toBe(400)
  })
})

describe('the plugin with a choice of master', () => {
  function app(saved: object[]): { app: ServerAPI; api: () => MultihelmProperty | undefined } {
    let api: MultihelmProperty | undefined
    return {
      api: () => api,
      app: {
        getDataDirPath: () => dir,
        emitPropertyValue: (name: string, value: unknown) => {
          if (name === PROPERTY_NAME) {
            api = value as MultihelmProperty
          }
        },
        savePluginOptions: (configuration: object, cb: (err: Error | null) => void) => {
          saved.push(configuration)
          cb(null)
        },
        setPluginStatus: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        subscriptionmanager: { subscribe: () => undefined }
      } as unknown as ServerAPI
    }
  }

  function file(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(dir, 'master', name), 'utf8'))
  }

  it('makes the master setting changed in the plugin settings the boat’s choice', async () => {
    const saved: object[] = []
    const { app: host, api } = app(saved)
    const plugin = createPlugin(host)
    plugin.start({}, () => undefined)
    const id = api()?.serverId?.() ?? ''
    expect(file('applied.json')).toEqual({ master: false, term: 0 })
    void plugin.stop()

    plugin.start({ master: true }, () => undefined)
    await vi.waitFor(() => {
      expect(file('master.json')).toEqual({ serverId: id, term: 1 })
      expect(file('applied.json')).toEqual({ master: true, term: 1 })
    })
    expect(saved).toEqual([])
    void plugin.stop()
  })

  it('applies a choice it could not save on the next start', async () => {
    const saved: object[] = []
    const { app: host } = app(saved)
    const plugin = createPlugin(host)
    plugin.start({ master: true }, () => undefined)
    void plugin.stop()
    fs.writeFileSync(
      path.join(dir, 'master', 'master.json'),
      JSON.stringify({ serverId: OTHER, term: 3 })
    )
    const errors: string[] = []
    const failing = {
      ...host,
      savePluginOptions: (_configuration: object, cb: (err: Error | null) => void) => {
        cb(new Error('disk full'))
      },
      error: (msg: string) => errors.push(msg)
    } as unknown as ServerAPI
    const broken = createPlugin(failing)
    broken.start({ master: true }, () => undefined)
    await vi.waitFor(() => {
      expect(errors.some((e) => e.includes('disk full'))).toBe(true)
    })
    expect(file('applied.json')).toEqual({ master: true, term: 0 })
    void broken.stop()

    plugin.start({ master: true }, () => undefined)
    await vi.waitFor(() => {
      expect(saved).toEqual([{ master: false }])
      expect(file('applied.json')).toEqual({ master: false, term: 3 })
    })
    void plugin.stop()
  })

  it('switches its master setting to the choice made on another server, and restarts', async () => {
    const saved: object[] = []
    const { app: host, api } = app(saved)
    const plugin = createPlugin(host)
    plugin.start({ master: true, takeOver: 2 }, () => undefined)
    expect(api()?.role?.()).toBeDefined()
    void plugin.stop()
    fs.writeFileSync(
      path.join(dir, 'master', 'master.json'),
      JSON.stringify({ serverId: OTHER, term: 3 })
    )

    plugin.start({ master: true, takeOver: 2 }, () => undefined)
    await vi.waitFor(() => {
      expect(saved).toEqual([{ master: false, takeOver: 2 }])
      expect(file('applied.json')).toEqual({ master: false, term: 3 })
    })
    void plugin.stop()
  })
})
