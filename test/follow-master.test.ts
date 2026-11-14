/**
 * Taking the vessel settings over from the master, against a fake master and
 * a fake own server over HTTP.
 */

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MasterFollower, type FollowHost } from '../src/follow-master.js'
import { ROUTE_PREFIX } from '../src/peer-client.js'
import { MultihelmStore } from '../src/store.js'
import type { SourcePriorities } from '../src/source-priorities.js'
import type { VesselSettings } from '../src/vessel-settings.js'

interface Call {
  method: string
  url: string
  auth: string | undefined
  body: unknown
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${String(port)}` }
}

const masterSettings: VesselSettings = {
  vessel: { name: 'Pelican', mmsi: '503123456', beam: 4.4 },
  meta: { 'environment.depth.belowTransducer': { displayName: 'Depth' } }
}

const masterPriorities: SourcePriorities = {
  groups: [{ id: 'gps', sources: ['can0.gps-flybridge', 'can0.gps-salon'] }],
  overrides: {},
  defaults: { fallbackMs: 15000 }
}

describe('MasterFollower', () => {
  let masterAnswer: VesselSettings = masterSettings
  const calls: Call[] = []
  let security = false
  let approval: 'PENDING' | 'APPROVED' = 'PENDING'
  let master: { server: http.Server; url: string }
  let own: { server: http.Server; url: string }
  let local: VesselSettings
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-follow-'))

  beforeAll(async () => {
    const m = express()
    m.get(`${ROUTE_PREFIX}/vessel-settings`, (_req, res) => {
      res.json(masterAnswer)
    })
    master = await listen(m)

    const o = express()
    o.use(express.json())
    o.use((req, _res, next) => {
      calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: req.body as unknown
      })
      next()
    })
    o.post('/signalk/v1/access/requests', (_req, res) => {
      if (!security) {
        res.sendStatus(404)
        return
      }
      res.status(202).json({ state: 'PENDING', href: '/signalk/v1/requests/1' })
    })
    o.get('/signalk/v1/requests/1', (_req, res) => {
      res.json(
        approval === 'APPROVED'
          ? {
              state: 'COMPLETED',
              accessRequest: { permission: 'APPROVED', token: 'admin-token' }
            }
          : { state: 'PENDING', href: '/signalk/v1/requests/1' }
      )
    })
    o.get('/skServer/vessel', (_req, res) => {
      res.json({ name: 'Old', gpsFromBow: 6 })
    })
    o.put('/skServer/vessel', (_req, res) => {
      res.send('Vessel changed')
    })
    o.put('/signalk/v1/api/vessels/self/*rest', (_req, res) => {
      res.status(202).json({ state: 'PENDING' })
    })
    o.put('/skServer/priorities', (_req, res) => {
      res.json({ result: 'ok' })
    })
    o.delete('/signalk/v1/api/vessels/self/*rest', (_req, res) => {
      res.json({ state: 'COMPLETED' })
    })
    own = await listen(o)
  })

  afterAll(() => {
    master.server.close()
    own.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function follower(name: string, options: Partial<FollowHost> = {}): MasterFollower {
    return new MasterFollower({
      store: new MultihelmStore(path.join(dir, name)),
      serverId: 'member-1',
      ownUrl: () => own.url,
      localSettings: () => local,
      master: () => ({ url: master.url, token: 'pairing-token' }),
      followVessel: true,
      followMeta: true,
      followPriorities: true,
      debug: () => undefined,
      error: () => undefined,
      ...options
    })
  }

  it('writes what differs from the master, keeping the fields that stay here', async () => {
    calls.length = 0
    local = {
      vessel: { name: 'Old' },
      meta: { 'navigation.speedOverGround': { displayName: 'SOG here' } }
    }
    await follower('open').run()
    const writes = calls.filter((c) => c.method !== 'POST' && c.method !== 'GET')
    expect(writes).toEqual([
      {
        method: 'PUT',
        url: '/skServer/vessel',
        auth: undefined,
        body: { name: 'Pelican', mmsi: '503123456', beam: 4.4, gpsFromBow: 6 }
      },
      {
        method: 'PUT',
        url: '/signalk/v1/api/vessels/self/environment/depth/belowTransducer/meta',
        auth: undefined,
        body: { value: { displayName: 'Depth' } }
      },
      {
        method: 'DELETE',
        url: '/signalk/v1/api/vessels/self/navigation/speedOverGround/meta',
        auth: undefined,
        body: undefined
      }
    ])
  })

  it('writes nothing when this server already matches the master', async () => {
    calls.length = 0
    local = structuredClone(masterSettings)
    await follower('same').run()
    expect(calls).toEqual([])
  })

  it('follows only what is turned on', async () => {
    calls.length = 0
    local = { vessel: { name: 'Old' }, meta: {} }
    await follower('vessel-only', { followMeta: false }).run()
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['/skServer/vessel'])
  })

  it('waits for the admin token on a server with security, then uses it', async () => {
    security = true
    approval = 'PENDING'
    calls.length = 0
    local = { vessel: { name: 'Old' }, meta: {} }
    const f = follower('secure')
    await f.run()
    expect(f.waitingForApproval()).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['POST'])

    approval = 'APPROVED'
    calls.length = 0
    await f.run()
    expect(f.waitingForApproval()).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.auth).toBe('Bearer admin-token')
    security = false
  })

  it('encodes the path segments of a metadata write', async () => {
    calls.length = 0
    local = {
      vessel: structuredClone(masterSettings.vessel),
      meta: {
        ...structuredClone(masterSettings.meta),
        'electrical.batteries.house:bank.voltage': { units: 'V' }
      }
    }
    await follower('encoded').run()
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/signalk/v1/api/vessels/self/electrical/batteries/house%3Abank/voltage/meta'
    ])
  })

  it('does nothing without a master', async () => {
    calls.length = 0
    await follower('alone', { master: () => null }).run()
    expect(calls).toEqual([])
  })

  it('takes the source priorities over once the master has any and this server can tell its own', async () => {
    masterAnswer = { ...masterSettings, priorities: masterPriorities }
    const same = { vessel: masterSettings.vessel, meta: masterSettings.meta }
    const priorityWrites = (): Call[] =>
      calls.filter((c) => c.method === 'PUT' && c.url === '/skServer/priorities')

    calls.length = 0
    local = { ...structuredClone(same), priorities: { groups: [], overrides: {}, defaults: {} } }
    await follower('priorities').run()
    expect(priorityWrites().map((c) => c.body)).toEqual([masterPriorities])

    calls.length = 0
    local = { ...structuredClone(same), priorities: structuredClone(masterPriorities) }
    await follower('priorities-same').run()
    local = structuredClone(same)
    await follower('priorities-unknown').run()
    local = { ...structuredClone(same), priorities: { groups: [], overrides: {}, defaults: {} } }
    await follower('priorities-off', { followPriorities: false }).run()
    masterAnswer = { ...masterSettings, priorities: { groups: [], overrides: {}, defaults: {} } }
    local = { ...structuredClone(same), priorities: structuredClone(masterPriorities) }
    await follower('priorities-none-on-master').run()
    expect(calls).toEqual([])
    masterAnswer = masterSettings
  })
})
