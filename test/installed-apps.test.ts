import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AppsOverview,
  LocalApps,
  compareApps,
  installedApps,
  isPackageName,
  isVersion,
  parseInstalled,
  peerApps,
  type InstalledApp
} from '../src/installed-apps.js'
import { Multihelm } from '../src/multihelm.js'
import { ROUTE_PREFIX } from '../src/peer-client.js'
import { registerRoutes } from '../src/routes.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-apps-'))

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }
}

const plugins = [
  {
    id: 'flags',
    name: 'Flags',
    packageName: 'signalk-flags',
    version: '1.2.0',
    data: { enabled: true }
  },
  {
    id: 'tracks',
    name: 'Tracks',
    packageName: '@signalk/tracks-plugin',
    version: '2.0.0',
    data: { enabled: false }
  },
  {
    id: 'freeboard',
    name: 'Freeboard helper',
    packageName: '@signalk/freeboard-sk',
    version: '3.0.0',
    data: {}
  }
]
const webapps = [
  { name: '@signalk/freeboard-sk', version: '3.0.0' },
  { name: 'buddy-boat-list', version: '0.4.0', signalk: { displayName: 'Buddy Boat List' } }
]

const app = (name: string, version: string, over: Partial<InstalledApp> = {}): InstalledApp => ({
  name,
  version,
  title: name,
  plugin: true,
  webapp: false,
  enabled: true,
  ...over
})

describe('the apps on the servers of the boat', () => {
  it('lists each installed package once, plugin and webapp together', () => {
    expect(installedApps(plugins, webapps)).toEqual([
      {
        name: '@signalk/freeboard-sk',
        version: '3.0.0',
        title: 'Freeboard helper',
        plugin: true,
        webapp: true,
        enabled: false
      },
      {
        name: '@signalk/tracks-plugin',
        version: '2.0.0',
        title: 'Tracks',
        plugin: true,
        webapp: false,
        enabled: false
      },
      {
        name: 'buddy-boat-list',
        version: '0.4.0',
        title: 'Buddy Boat List',
        plugin: false,
        webapp: true,
        enabled: null
      },
      {
        name: 'signalk-flags',
        version: '1.2.0',
        title: 'Flags',
        plugin: true,
        webapp: false,
        enabled: true
      }
    ])
    expect(installedApps('nonsense', [{ version: '1' }])).toEqual([])
  })

  it('shows what is missing here, in another version, or off here, leaving out what is not wanted', () => {
    const here = [
      app('flags', '1.2.0', { enabled: false }),
      app('tracks', '2.0.0'),
      app('same', '1.0.0')
    ]
    const report = compareApps(
      here,
      [
        {
          name: 'USVMAIN',
          apps: [
            app('flags', '1.2.0'),
            app('tracks', '2.1.0'),
            app('buddy', '0.4.0'),
            app('mayara', '3.0.0'),
            app('same', '1.0.0')
          ]
        },
        { name: 'Salon', apps: [app('buddy', '0.3.0'), app('tracks', '2.0.0')] },
        { name: 'Old', apps: null, error: 'it runs an older Multihelm' }
      ],
      ['mayara']
    )
    expect(report).toEqual({
      here: null,
      missing: [
        {
          name: 'buddy',
          title: 'buddy',
          plugin: true,
          webapp: false,
          servers: [
            { name: 'USVMAIN', version: '0.4.0' },
            { name: 'Salon', version: '0.3.0' }
          ]
        }
      ],
      versions: [
        {
          name: 'tracks',
          title: 'tracks',
          plugin: true,
          webapp: false,
          servers: [{ name: 'USVMAIN', version: '2.1.0' }],
          version: '2.0.0'
        }
      ],
      disabled: [
        {
          name: 'flags',
          title: 'flags',
          plugin: true,
          webapp: false,
          servers: [{ name: 'USVMAIN', version: '1.2.0' }]
        }
      ],
      hidden: ['mayara'],
      unreadable: [{ name: 'Old', error: 'it runs an older Multihelm' }]
    })
  })

  it('takes from a peer only plain package names and versions', () => {
    const entry = (name: string, version: string) => ({
      name,
      version,
      title: name,
      plugin: true,
      webapp: false,
      enabled: true
    })
    const parsed = parseInstalled({
      apps: [
        entry('signalk-flags', '1.2.0'),
        entry('@signalk/tracks-plugin', '2.0.0-beta.3'),
        entry('../../restore', '1.0.0'),
        entry('@signalk/..', '1.0.0'),
        entry('.hidden', '1.0.0'),
        entry('signalk-flags-alias', 'npm:other-pkg@1.0.0'),
        entry('signalk-range', '^1.0.0'),
        entry('signalk-url', 'https://example.com/x.tgz'),
        entry('', '1.0.0')
      ]
    })
    expect(parsed.map((a) => a.name)).toEqual(['signalk-flags', '@signalk/tracks-plugin'])
    expect(isPackageName('@scope/x')).toBe(true)
    expect(isVersion('1.2.3+build.5')).toBe(true)
    expect(isVersion('01.2.3')).toBe(false)
  })

  it('compares nothing while this server cannot read its own apps', () => {
    const report = compareApps(null, [{ name: 'USVMAIN', apps: [app('buddy', '0.4.0')] }], [])
    expect(report.here).toMatch(/cannot read its own apps/)
    expect(report.missing).toEqual([])
  })

  describe('read over the network', () => {
    let own: { server: http.Server; url: string }
    let member: { server: http.Server; url: string }
    let waiting: { server: http.Server; url: string }
    let old: { server: http.Server; url: string }
    let reads = 0
    const multihelms: Multihelm[] = []
    let overview: AppsOverview

    function station(name: string, local: LocalApps, store: MultihelmStore): express.Express {
      const mh = new Multihelm(store, {
        serverName: () => name,
        isMaster: () => false,
        debug: () => undefined,
        error: () => undefined
      })
      multihelms.push(mh)
      overview = new AppsOverview({
        local,
        peers: () => [],
        hidden: () => store.loadHiddenApps(),
        saveHidden: (names) => {
          store.saveHiddenApps(names)
        }
      })
      const ov = overview
      const e = express()
      e.use(express.json())
      // A secured peer, as signalk-server lets only a device token through to the peer routes.
      e.use(`${ROUTE_PREFIX}/installed`, (req, res, next) => {
        if (req.headers.authorization === 'Bearer pairing') {
          next()
        } else {
          res.sendStatus(401)
        }
      })
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
        () => ({ local, overview: ov })
      )
      e.use(ROUTE_PREFIX, router)
      return e
    }

    beforeAll(async () => {
      const sk = express()
      sk.get('/skServer/plugins', (req, res) => {
        reads++
        if (req.headers.authorization !== 'Bearer admin') {
          res.sendStatus(401)
          return
        }
        res.json(plugins)
      })
      sk.get('/skServer/webapps', (_req, res) => {
        res.json(webapps)
      })
      own = await listen(sk)
      const local = new LocalApps({ token: () => Promise.resolve('admin'), ownUrl: () => own.url })
      member = await listen(station('member', local, new MultihelmStore(path.join(root, 'member'))))
      const none = new LocalApps({ token: () => Promise.resolve(null), ownUrl: () => own.url })
      waiting = await listen(
        station('waiting', none, new MultihelmStore(path.join(root, 'waiting')))
      )
      old = await listen(express())
    })

    afterAll(() => {
      for (const mh of multihelms) {
        mh.stop()
      }
      for (const s of [own, member, waiting, old]) {
        s.server.close()
      }
      fs.rmSync(root, { recursive: true, force: true })
    })

    it('reads a peer’s apps with the pairing token, and says why it cannot', async () => {
      const answer = await peerApps({ url: member.url, name: 'member', token: 'pairing' })
      expect(answer.apps?.map((a) => a.name)).toEqual([
        '@signalk/freeboard-sk',
        '@signalk/tracks-plugin',
        'buddy-boat-list',
        'signalk-flags'
      ])
      expect(await peerApps({ url: old.url, name: 'old', token: '' })).toMatchObject({
        apps: null,
        error: 'it runs an older Multihelm'
      })
      expect(await peerApps({ url: member.url, name: 'member', token: 'wrong' })).toMatchObject({
        apps: null,
        error: expect.stringMatching(/^HTTP 401 /) as unknown
      })
      expect(await peerApps({ url: waiting.url, name: 'waiting', token: 'pairing' })).toMatchObject(
        {
          apps: null,
          error: 'its own access request waits for approval there'
        }
      )
    })

    it('reads its own list at most once a minute', async () => {
      const local = new LocalApps({ token: () => Promise.resolve('admin'), ownUrl: () => own.url })
      const before = reads
      await local.list(1_000_000)
      await local.list(1_030_000)
      expect(reads - before).toBe(1)
      await local.list(1_061_000)
      expect(reads - before).toBe(2)
    })

    it('keeps the apps not wanted here, and takes them back', async () => {
      const put = (body: unknown) =>
        fetch(`${waiting.url}${ROUTE_PREFIX}/apps/hidden`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      expect((await put({ name: '@marineyachtradar/signalk-plugin', hidden: true })).status).toBe(
        200
      )
      expect((await put({ name: 'buddy-boat-list', hidden: true })).status).toBe(200)
      expect((await put({ name: 'buddy-boat-list', hidden: false })).status).toBe(200)
      expect((await put({ name: '../etc', hidden: true })).status).toBe(400)
      const report = (await (await fetch(`${waiting.url}${ROUTE_PREFIX}/apps`)).json()) as {
        hidden: string[]
      }
      expect(report.hidden).toEqual(['@marineyachtradar/signalk-plugin'])
    })
  })
})
