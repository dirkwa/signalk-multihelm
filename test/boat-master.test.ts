import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ServerAPI } from '@signalk/server-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROPERTY_NAME, type MultihelmProperty } from '../src/api.js'
import { BoatMaster, masterOnStart, type MasterChoice } from '../src/boat-master.js'
import createPlugin from '../src/index.js'

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
  function boatMaster(): { master: BoatMaster; chosen: MasterChoice[]; changed: () => number } {
    const chosen: MasterChoice[] = []
    let changes = 0
    const master = new BoatMaster({
      dir: path.join(dir, 'master'),
      chosen: (choice) => chosen.push(choice),
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
