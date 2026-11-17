import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type {
  AlarmProperties,
  AlarmRaiseOptions,
  AlarmUpdateOptions,
  NotificationId
} from '@signalk/server-api'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  FROM_MASTER,
  MASTER_ALARM,
  MasterAlarms,
  NOTIFICATIONS_PATH,
  managedNotifications,
  type LocalNotifications
} from '../src/alarms-from-master.js'
import { MasterControlAccess } from '../src/master-control.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-alarms-'))

interface Stored {
  path: string
  state: string
  message: string
  data?: Record<string, unknown>
  silenced: boolean
  acknowledged: boolean
}

function listing(alarms: Map<string, Stored>): Record<string, unknown> {
  return Object.fromEntries(
    [...alarms].map(([id, alarm]) => [
      id,
      {
        context: 'vessels.self',
        path: alarm.path,
        value: {
          id,
          state: alarm.state,
          message: alarm.message,
          method: [],
          data: alarm.data,
          status: { silenced: alarm.silenced, acknowledged: alarm.acknowledged }
        }
      }
    ])
  )
}

/** This server's notifications, kept as the server's Notifications API keeps them. */
class Notifications implements LocalNotifications {
  alarms = new Map<string, Stored>()
  private next = 0

  list = (): Record<string, AlarmProperties> =>
    listing(this.alarms) as Record<string, AlarmProperties>

  raise = (options: AlarmRaiseOptions): NotificationId => {
    const id = `here-${String(++this.next)}` as NotificationId
    this.alarms.set(id, {
      path: options.path ?? '',
      state: options.state,
      message: options.message,
      data: options.data,
      silenced: false,
      acknowledged: false
    })
    return id
  }

  update = (id: NotificationId, options: AlarmUpdateOptions): void => {
    const alarm = this.get(id)
    const reset = options.state !== undefined && (options.state as string) !== alarm.state
    this.alarms.set(id, {
      ...alarm,
      ...options,
      silenced: reset ? false : alarm.silenced,
      acknowledged: reset ? false : alarm.acknowledged
    })
  }

  clear = (id: NotificationId): void => {
    this.alarms.delete(id)
  }

  silence = (id: NotificationId): void => {
    this.get(id).silenced = true
  }

  acknowledge = (id: NotificationId): void => {
    this.get(id).acknowledged = true
  }

  private get(id: string): Stored {
    const alarm = this.alarms.get(id)
    if (!alarm) {
      throw new Error(`no alarm ${id}`)
    }
    return alarm
  }
}

const DEPTH = 'notifications.environment.depth.belowKeel'
const ENGINE = 'notifications.propulsion.port.temperature'

describe("the master's alarms on another server", () => {
  const master = new Map<string, Stored>()
  const posted: string[] = []
  let isMaster = false
  let masterId = 'salon'
  let masterUrl = ''
  let failPosts = 0
  /** While set, access requests wait for it. */
  let accessGate: Promise<void> | null = null
  let accessAsked: () => void = () => undefined
  let server: http.Server
  let url = ''

  beforeAll(async () => {
    const app = express()
    app.post('/signalk/v1/access/requests', (_req, res) => {
      accessAsked()
      void (accessGate ?? Promise.resolve()).then(() => res.sendStatus(404))
    })
    app.get(NOTIFICATIONS_PATH, (_req, res) => {
      res.json(listing(master))
    })
    app.post(`${NOTIFICATIONS_PATH}/:id/:action`, (req, res) => {
      const alarm = master.get(req.params.id)
      if (!alarm) {
        res.sendStatus(404)
        return
      }
      if (failPosts > 0) {
        failPosts--
        res.sendStatus(500)
        return
      }
      posted.push(`${req.params.id} ${req.params.action}`)
      if (req.params.action === 'silence') {
        alarm.silenced = true
      } else {
        alarm.acknowledged = true
      }
      res.json({ state: 'COMPLETED', statusCode: 200 })
    })
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    master.clear()
    posted.length = 0
    isMaster = false
    masterId = 'salon'
    masterUrl = url
    failPosts = 0
    accessGate = null
  })

  function make(name: string, notifications: Notifications): MasterAlarms {
    return new MasterAlarms({
      master: () =>
        isMaster ? null : { id: masterId, access: { url: masterUrl, token: 'pairing-token' } },
      control: new MasterControlAccess({
        store: new MultihelmStore(path.join(root, name)),
        serverId: 'port',
        currentMaster: () => (isMaster ? null : masterId),
        debug: () => undefined
      }),
      notifications,
      debug: () => undefined
    })
  }

  function alarm(fields: Partial<Stored> & { path: string }): Stored {
    return {
      state: 'alarm',
      message: 'Shallow water',
      silenced: false,
      acknowledged: false,
      ...fields
    }
  }

  it('shows an alarm of the master here, marked as the master’s, until the master clears it', async () => {
    const here = new Notifications()
    const alarms = make('show', here)
    master.set('m1', alarm({ path: DEPTH, data: { depth: 1.2 } }))
    await alarms.sync()
    expect([...here.alarms.values()]).toEqual([
      alarm({ path: DEPTH, data: { depth: 1.2, [FROM_MASTER]: 'salon', [MASTER_ALARM]: 'm1' } })
    ])

    master.set('m1', alarm({ path: DEPTH, state: 'emergency', message: 'Aground' }))
    await alarms.sync()
    expect([...here.alarms.values()].map((a) => [a.state, a.message])).toEqual([
      ['emergency', 'Aground']
    ])

    master.delete('m1')
    await alarms.sync()
    expect(here.alarms.size).toBe(0)
  })

  it('does not show an alarm twice that this server raises itself', async () => {
    const here = new Notifications()
    const own = here.raise({ path: DEPTH as never, state: 'alarm' as never, message: 'Shallow' })
    master.set('m1', alarm({ path: DEPTH }))
    await make('own', here).sync()
    expect([...here.alarms.keys()]).toEqual([own])
  })

  it("takes its own alarm's place when this server raises one after the master's", async () => {
    const here = new Notifications()
    const alarms = make('own-later', here)
    master.set('m1', alarm({ path: DEPTH }))
    await alarms.sync()
    const own = here.raise({ path: DEPTH as never, state: 'alarm' as never, message: 'Shallow' })
    await alarms.sync()
    expect([...here.alarms.keys()]).toEqual([own])
  })

  it('sends an acknowledgement given here to the master', async () => {
    const here = new Notifications()
    const alarms = make('ack-here', here)
    master.set('m1', alarm({ path: DEPTH }))
    master.set('m2', alarm({ path: ENGINE }))
    await alarms.sync()
    const [depth] = [...here.alarms].find(([, a]) => a.path === DEPTH) ?? []
    here.acknowledge(depth as NotificationId)
    await alarms.sync()
    expect(posted).toEqual(['m1 acknowledge'])
    expect(master.get('m1')?.acknowledged).toBe(true)
    expect(master.get('m2')?.acknowledged).toBe(false)
  })

  it('sends a silence given here to an alarm of its own to the master', async () => {
    const here = new Notifications()
    const alarms = make('silence-own', here)
    const own = here.raise({ path: ENGINE as never, state: 'alarm' as never, message: 'Hot' })
    master.set('m2', alarm({ path: ENGINE }))
    await alarms.sync()
    here.silence(own)
    await alarms.sync()
    expect(posted).toEqual(['m2 silence'])
  })

  it('does what the master has done to an alarm, also to an alarm of its own', async () => {
    const here = new Notifications()
    const alarms = make('from-master', here)
    const own = here.raise({ path: ENGINE as never, state: 'alarm' as never, message: 'Hot' })
    master.set('m1', alarm({ path: DEPTH, silenced: true }))
    master.set('m2', alarm({ path: ENGINE, acknowledged: true }))
    await alarms.sync()
    await alarms.sync()
    const depth = [...here.alarms.values()].find((a) => a.path === DEPTH)
    expect(depth?.silenced).toBe(true)
    expect(here.alarms.get(own)?.acknowledged).toBe(true)
    expect(posted).toEqual([])
  })

  it('does not send an acknowledgement given before the alarm was the master’s', async () => {
    const here = new Notifications()
    const own = here.raise({ path: ENGINE as never, state: 'alarm' as never, message: 'Hot' })
    here.acknowledge(own)
    master.set('m2', alarm({ path: ENGINE }))
    await make('stale-ack', here).sync()
    expect(posted).toEqual([])
  })

  it("takes the master's alarms off when stopped, or when this server becomes the master", async () => {
    const here = new Notifications()
    const alarms = make('stop', here)
    master.set('m1', alarm({ path: DEPTH }))
    await alarms.sync()
    expect(here.alarms.size).toBe(1)
    isMaster = true
    await alarms.sync()
    expect(here.alarms.size).toBe(0)

    isMaster = false
    await alarms.sync()
    expect(here.alarms.size).toBe(1)
    alarms.stop()
    expect(here.alarms.size).toBe(0)
  })

  it('leaves out alarms the master still shows for another master', async () => {
    const here = new Notifications()
    master.set('m1', alarm({ path: DEPTH, data: { [FROM_MASTER]: 'flybridge' } }))
    await make('stale-master', here).sync()
    expect(here.alarms.size).toBe(0)
  })

  it('sends an acknowledgement again that the master did not take', async () => {
    const here = new Notifications()
    const alarms = make('retry', here)
    master.set('m1', alarm({ path: DEPTH }))
    await alarms.sync()
    const [id] = [...here.alarms.keys()]
    here.acknowledge(id as NotificationId)
    failPosts = 1
    await alarms.sync()
    expect(posted).toEqual([])
    await alarms.sync()
    expect(posted).toEqual(['m1 acknowledge'])
    await alarms.sync()
    expect(posted).toEqual(['m1 acknowledge'])
  })

  it('does not give an acknowledgement to the alarm the master raised in place of the one acknowledged', async () => {
    const here = new Notifications()
    const alarms = make('replaced', here)
    master.set('m1', alarm({ path: DEPTH }))
    await alarms.sync()
    const [id] = [...here.alarms.keys()]
    here.acknowledge(id as NotificationId)
    master.delete('m1')
    master.set('m3', alarm({ path: DEPTH }))
    await alarms.sync()
    await alarms.sync()
    expect(posted).toEqual([])
    expect([...here.alarms.values()]).toEqual([
      alarm({ path: DEPTH, data: { [FROM_MASTER]: 'salon', [MASTER_ALARM]: 'm3' } })
    ])
  })

  it('takes the old master’s alarms off while a new master does not answer', async () => {
    const here = new Notifications()
    const alarms = make('new-master', here)
    master.set('m1', alarm({ path: DEPTH }))
    await alarms.sync()
    masterId = 'flybridge'
    masterUrl = 'http://127.0.0.1:1'
    await alarms.sync()
    expect(here.alarms.size).toBe(0)
  })

  it('raises no alarm of the master once stopped during a pass', async () => {
    const here = new Notifications()
    const alarms = make('stop-mid-pass', here)
    const own = here.raise({ path: ENGINE as never, state: 'alarm' as never, message: 'Hot' })
    master.set('m2', alarm({ path: ENGINE }))
    await alarms.sync()
    here.acknowledge(own)
    master.set('m1', alarm({ path: DEPTH }))
    let open: () => void = () => undefined
    accessGate = new Promise((resolve) => (open = resolve))
    const asked = new Promise<void>((resolve) => (accessAsked = resolve))
    const pass = alarms.sync()
    await asked
    alarms.stop()
    open()
    await pass
    expect([...here.alarms.keys()]).toEqual([own])
  })

  it('shows what the master adds to an alarm, keeping an acknowledgement here the master has yet to take', async () => {
    const here = new Notifications()
    const alarms = make('data', here)
    master.set('m1', alarm({ path: DEPTH, data: { depth: 1.2 } }))
    await alarms.sync()
    const [id] = [...here.alarms.keys()]
    here.acknowledge(id as NotificationId)
    failPosts = 1
    await alarms.sync()
    master.set('m1', alarm({ path: DEPTH, data: { depth: 0.6 } }))
    await alarms.sync()
    expect(here.alarms.get(id ?? '')).toMatchObject({ data: { depth: 0.6 }, acknowledged: true })
    expect(posted).toEqual(['m1 acknowledge'])
  })

  it('shows no alarm of the master that this server raised itself while a send waited', async () => {
    const here = new Notifications()
    const alarms = make('own-mid-pass', here)
    const engine = here.raise({ path: ENGINE as never, state: 'alarm' as never, message: 'Hot' })
    master.set('m2', alarm({ path: ENGINE }))
    await alarms.sync()
    here.acknowledge(engine)
    master.set('m1', alarm({ path: DEPTH }))
    let open: () => void = () => undefined
    accessGate = new Promise((resolve) => (open = resolve))
    const asked = new Promise<void>((resolve) => (accessAsked = resolve))
    const pass = alarms.sync()
    await asked
    const depth = here.raise({ path: DEPTH as never, state: 'alarm' as never, message: 'Shallow' })
    open()
    await pass
    expect([...here.alarms.keys()]).toEqual([engine, depth])
  })
})

describe("the server's Notifications API", () => {
  it('is used only while the server manages notifications', () => {
    const managed = { list: () => ({}), getId: () => undefined }
    expect(managedNotifications(managed)).toBe(managed)
    expect(
      managedNotifications({
        list: () => ({}),
        getId: () => {
          throw new Error('Notification management is disabled')
        }
      })
    ).toBeNull()
    expect(managedNotifications(undefined)).toBeNull()
  })
})
