import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  MASTER_PLUGINS_KEY,
  MasterOnlyPlugins,
  PluginList,
  parsePluginIds,
  type SwitchHost
} from '../src/master-plugins.js'
import { OwnServerAccess } from '../src/own-access.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-master-plugins-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('parsePluginIds', () => {
  it('takes a list of plugin ids, sorted and once each', () => {
    expect(parsePluginIds(['b', 'a', 'b', '@scope.x'])).toEqual(['@scope.x', 'a', 'b'])
    expect(parsePluginIds(['../x'])).toBeNull()
    expect(parsePluginIds('autopilot')).toBeNull()
    expect(parsePluginIds([1])).toBeNull()
  })
})

describe('the list of plugins that run on the master only', () => {
  it('is kept in a file that the dataset lists, and says when it changes', async () => {
    let changes = 0
    const dir = path.join(root, 'list')
    const list = new PluginList(dir, () => {
      changes++
    })
    expect(list.ids()).toEqual([])
    expect(await list.dataset.list()).toEqual([])

    await list.set(['autopilot', 'rules'])
    await list.set(['rules', 'autopilot'])
    expect(changes).toBe(1)
    const [entry] = await list.dataset.list()
    expect(entry?.key).toBe(MASTER_PLUGINS_KEY)
    expect(JSON.parse(fs.readFileSync(entry?.files[0]?.path ?? '', 'utf8'))).toEqual([
      'autopilot',
      'rules'
    ])
    expect(new PluginList(dir, () => undefined).ids()).toEqual(['autopilot', 'rules'])
  })

  it('writes overlapping changes one after the other, the last one winning', async () => {
    const list = new PluginList(path.join(root, 'overlap'), () => undefined)
    await Promise.all([list.set(['a']), list.set(['b']), list.set(['c'])])
    expect(list.ids()).toEqual(['c'])
    const [entry] = await list.dataset.list()
    expect(JSON.parse(fs.readFileSync(entry?.files[0]?.path ?? '', 'utf8'))).toEqual(['c'])
  })

  it("takes a peer's list, and refuses one that is not a list of plugin ids", async () => {
    const list = new PluginList(path.join(root, 'peer'), () => undefined)
    const incoming = path.join(root, 'incoming.json')
    const entry = (name = 'plugins.json') => ({
      key: MASTER_PLUGINS_KEY,
      meta: null,
      files: [{ name, path: incoming, size: 0, sha256: '', unchanged: false }]
    })

    fs.writeFileSync(incoming, JSON.stringify(['autopilot']))
    await list.dataset.apply(entry())
    expect(list.ids()).toEqual(['autopilot'])

    fs.writeFileSync(incoming, JSON.stringify({ autopilot: true }))
    await expect(list.dataset.apply(entry())).rejects.toThrow('not a list of plugin ids')
    await expect(list.dataset.apply(entry('other.json'))).rejects.toThrow('one file')
    expect(list.ids()).toEqual(['autopilot'])

    expect(await list.dataset.remove(MASTER_PLUGINS_KEY)).toBe(true)
    expect(list.ids()).toEqual([])
    expect(await list.dataset.list()).toEqual([])
  })
})

interface PluginState {
  enabled?: boolean
  configuration?: unknown
}

describe('switching the plugins that run on the master only', () => {
  const plugins = new Map<string, PluginState>()
  const posts: { id: string; body: unknown }[] = []
  let security = false
  let own: { server: http.Server; url: string }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.post('/signalk/v1/access/requests', (_req, res) => {
      if (security) {
        res.status(202).json({ state: 'PENDING', href: '/signalk/v1/requests/1' })
      } else {
        res.sendStatus(404)
      }
    })
    app.get('/plugins/:id', (req, res) => {
      const plugin = plugins.get(req.params.id)
      if (!plugin) {
        res.sendStatus(404)
        return
      }
      res.json({ id: req.params.id, enabled: plugin.enabled === true })
    })
    app.get('/plugins/:id/config', (req, res) => {
      res.json(plugins.get(req.params.id) ?? {})
    })
    app.post('/plugins/:id/config', (req, res) => {
      posts.push({ id: req.params.id, body: req.body as unknown })
      plugins.set(req.params.id, req.body as PluginState)
      res.json('saved')
    })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    own = { server, url: `http://127.0.0.1:${String(port)}` }
  })

  afterAll(() => {
    own.server.close()
  })

  beforeEach(() => {
    plugins.clear()
    posts.length = 0
    security = false
  })

  function switcher(
    name: string,
    wanted: boolean | null | (() => boolean | null),
    ids: string[] | (() => string[])
  ): MasterOnlyPlugins {
    const store = new MultihelmStore(path.join(root, name))
    const host: SwitchHost = {
      ids: typeof ids === 'function' ? ids : () => ids,
      wanted: typeof wanted === 'function' ? wanted : () => wanted,
      access: new OwnServerAccess({
        store,
        serverId: 'own',
        ownUrl: () => own.url,
        debug: () => undefined
      }),
      ownUrl: () => own.url,
      selfId: 'signalk-multihelm',
      debug: () => undefined,
      error: () => undefined
    }
    return new MasterOnlyPlugins(host)
  }

  it('stops them on a server that is not the master, keeping their settings', async () => {
    plugins.set('autopilot', { enabled: true, configuration: { device: 'raymarine' } })
    plugins.set('rules', { enabled: false })
    await switcher('stop', false, ['autopilot', 'rules']).applyOnce()
    expect(posts).toEqual([
      { id: 'autopilot', body: { enabled: false, configuration: { device: 'raymarine' } } }
    ])
  })

  it('starts them on the master', async () => {
    plugins.set('autopilot', { enabled: false, configuration: { device: 'raymarine' } })
    await switcher('start', true, ['autopilot']).applyOnce()
    expect(plugins.get('autopilot')).toEqual({
      enabled: true,
      configuration: { device: 'raymarine' }
    })
  })

  it('leaves them alone while the role does not say, and never switches Multihelm itself', async () => {
    plugins.set('autopilot', { enabled: true })
    plugins.set('signalk-multihelm', { enabled: true })
    await switcher('unknown', null, ['autopilot']).applyOnce()
    await switcher('self', false, ['signalk-multihelm']).applyOnce()
    expect(posts).toEqual([])
  })

  it('skips a plugin not installed here', async () => {
    plugins.set('rules', { enabled: true })
    await switcher('missing', false, ['autopilot', 'rules']).applyOnce()
    expect(posts.map((p) => p.id)).toEqual(['rules'])
  })

  it('switches nothing until its own access request is approved', async () => {
    security = true
    plugins.set('autopilot', { enabled: true })
    await switcher('secure', false, ['autopilot']).applyOnce()
    expect(posts).toEqual([])
  })

  it('writes nothing when the role moved while it asked the server', async () => {
    plugins.set('autopilot', { enabled: true })
    let asked = 0
    // Known when the pass starts, gone by the time it would write.
    await switcher('moved', () => (asked++ === 0 ? false : null), ['autopilot']).applyOnce()
    expect(posts).toEqual([])
  })

  it('leaves alone a plugin taken off the list while it asked the server', async () => {
    plugins.set('autopilot', { enabled: true })
    let listed = 0
    await switcher('dropped', false, () => (listed++ === 0 ? ['autopilot'] : [])).applyOnce()
    expect(posts).toEqual([])
  })
})

describe("this server's own access request", () => {
  it('is sent once for callers that wait at the same time', async () => {
    let requests = 0
    const app = express()
    app.post('/signalk/v1/access/requests', (_req, res) => {
      requests++
      setTimeout(() => res.status(202).json({ state: 'PENDING', href: '/r/1' }), 20)
    })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const access = new OwnServerAccess({
      store: new MultihelmStore(path.join(root, 'shared-request')),
      serverId: 'own',
      ownUrl: () => `http://127.0.0.1:${String(port)}`,
      debug: () => undefined
    })
    expect(await Promise.all([access.token(), access.token()])).toEqual([null, null])
    expect(requests).toBe(1)
    server.close()
  })
})
