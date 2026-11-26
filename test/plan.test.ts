import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ServerAPI } from '@signalk/server-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROPERTY_NAME, type MultihelmProperty } from '../src/api.js'
import createPlugin from '../src/index.js'
import {
  BoatPlan,
  isServerPlan,
  onStart,
  planKey,
  planSettings,
  type PlanSettings,
  type ServerPlan
} from '../src/plan.js'

const defaults = planSettings({})

function settings(over: Partial<PlanSettings> = {}): PlanSettings {
  return { ...defaults, ...over }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-plan-'))
})
// A round still running when a test stopped the plugin saves its state when it ends; on a slow
// disk (Windows) that is after the test, so the data dir is removed only once it is done.
const ROUND_SETTLE_MS = 300

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, ROUND_SETTLE_MS))
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('the boat plan', () => {
  it('fills in the defaults of settings never saved', () => {
    expect(defaults).toEqual({
      takeOver: 0,
      syncResources: true,
      followVessel: true,
      followMetadata: true,
      followSourcePriorities: true,
      historyFromMaster: true,
      autopilotFromMaster: true,
      courseFromMaster: true,
      alarmsFromMaster: true,
      sharePaths: [],
      shareConnections: [],
      takeSharedData: true
    })
    expect(planSettings({ takeOver: 3, courseFromMaster: false, master: true })).toEqual(
      settings({ takeOver: 3, courseFromMaster: false })
    )
    expect(planSettings({ takeOver: -1 }).takeOver).toBe(0)
  })

  it('publishes settings changed in the plugin settings, and applies those changed elsewhere', () => {
    const changed = settings({ followVessel: false })
    expect(onStart(defaults, null, null)).toBe('publish')
    expect(onStart(defaults, null, changed)).toBe('publish')
    expect(onStart(changed, defaults, defaults)).toBe('publish')
    expect(onStart(defaults, defaults, changed)).toBe('apply')
    expect(onStart(defaults, defaults, defaults)).toBe('none')
  })

  it('takes only well-formed server plans', () => {
    expect(isServerPlan({ location: 'Salon', settings: defaults })).toBe(true)
    expect(isServerPlan({ location: 'Salon', settings: { ...defaults, takeOver: 12 } })).toBe(false)
    expect(isServerPlan({ location: 'x'.repeat(61), settings: defaults })).toBe(false)
    expect(isServerPlan({ settings: defaults })).toBe(false)
  })

  it("takes a peer's entries, tells about its own only when its settings change, and keeps its own", async () => {
    const ownChanged = vi.fn()
    const plan = new BoatPlan({ serverId: 'own', dir, ownChanged, changed: () => undefined })
    const other: ServerPlan = { location: 'Salon', settings: defaults }
    await plan.dataset.apply({ key: planKey('other'), meta: other, files: [] })
    expect(plan.get('other')).toEqual(other)
    expect(ownChanged).not.toHaveBeenCalled()

    const mine: ServerPlan = { location: '', settings: settings({ takeOver: 2 }) }
    await plan.dataset.apply({ key: planKey('own'), meta: mine, files: [] })
    await plan.dataset.apply({
      key: planKey('own'),
      meta: { ...mine, location: 'Port' },
      files: []
    })
    expect(ownChanged).toHaveBeenCalledTimes(1)
    expect(ownChanged).toHaveBeenCalledWith(mine.settings)

    await expect(
      plan.dataset.apply({ key: planKey('bad'), meta: { location: 1 }, files: [] })
    ).rejects.toThrow(/not a server's plan/)
    expect(await plan.dataset.remove(planKey('own'))).toBe(false)
    expect(await plan.dataset.remove(planKey('other'))).toBe(true)
    expect(
      Object.keys(
        new BoatPlan({ serverId: 'own', dir, ownChanged, changed: () => undefined }).servers()
      )
    ).toEqual(['own'])
    expect((await plan.dataset.list()).map((e) => e.key)).toEqual([planKey('own')])
  })
})

describe('the plugin with the plan', () => {
  function app(
    saved: object[],
    save: (cb: (err: Error | null) => void) => void = (cb) => {
      cb(null)
    }
  ): { app: ServerAPI; api: () => MultihelmProperty | undefined } {
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
          save(cb)
        },
        setPluginStatus: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        subscriptionmanager: { subscribe: () => undefined }
      } as unknown as ServerAPI
    }
  }

  it('puts its settings in the plan, then applies a change another server made to its entry', async () => {
    const saved: object[] = []
    const { app: host, api } = app(saved)
    const plugin = createPlugin(host)
    plugin.start({ master: true, takeOver: 1 }, () => undefined)
    const id = api()?.serverId?.() ?? ''
    await vi.waitFor(() => {
      const plan = JSON.parse(
        fs.readFileSync(path.join(dir, 'plan', 'plan.json'), 'utf8')
      ) as Record<string, ServerPlan>
      expect(plan[id]?.settings).toEqual(settings({ takeOver: 1 }))
    })
    void plugin.stop()
    expect(saved).toEqual([])

    const planned: ServerPlan = {
      location: 'Salon',
      settings: settings({ takeOver: 1, alarmsFromMaster: false })
    }
    fs.writeFileSync(path.join(dir, 'plan', 'plan.json'), JSON.stringify({ [id]: planned }))
    plugin.start({ master: true, takeOver: 1 }, () => undefined)
    await vi.waitFor(() => {
      expect(saved).toEqual([{ ...planned.settings, master: true }])
    })
    await vi.waitFor(() => {
      expect(api()?.serverId?.()).toBe(id)
    })
    void plugin.stop()
  })

  async function planChangedElsewhere(
    host: ServerAPI,
    api: () => MultihelmProperty | undefined
  ): Promise<{ plugin: ReturnType<typeof createPlugin>; planned: ServerPlan }> {
    const plugin = createPlugin(host)
    plugin.start({ takeOver: 1 }, () => undefined)
    const id = api()?.serverId?.() ?? ''
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(dir, 'plan', 'applied.json'))).toBe(true)
    })
    void plugin.stop()
    const planned: ServerPlan = {
      location: '',
      settings: settings({ takeOver: 1, alarmsFromMaster: false })
    }
    fs.writeFileSync(path.join(dir, 'plan', 'plan.json'), JSON.stringify({ [id]: planned }))
    return { plugin, planned }
  }

  function applied(): unknown {
    return JSON.parse(fs.readFileSync(path.join(dir, 'plan', 'applied.json'), 'utf8'))
  }

  it('keeps the settings it last applied when saving the planned ones fails', async () => {
    const saved: object[] = []
    let fail = false
    const { app: host, api } = app(saved, (cb) => {
      cb(fail ? new Error('disk full') : null)
    })
    const { plugin } = await planChangedElsewhere(host, api)
    fail = true
    plugin.start({ takeOver: 1 }, () => undefined)
    await vi.waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(applied()).toEqual(settings({ takeOver: 1 }))
    void plugin.stop()
  })

  it('does not restart once it was stopped while the planned settings were being saved', async () => {
    const saved: object[] = []
    const pending: ((err: Error | null) => void)[] = []
    let hold = false
    const { app: host, api } = app(saved, (cb) => {
      if (hold) {
        pending.push(cb)
      } else {
        cb(null)
      }
    })
    const { plugin, planned } = await planChangedElsewhere(host, api)
    hold = true
    plugin.start({ takeOver: 1 }, () => undefined)
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    void plugin.stop()
    pending[0]?.(null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api()?.serverId).toBeUndefined()
    expect(applied()).toEqual(planned.settings)
  })
})
