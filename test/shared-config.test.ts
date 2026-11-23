import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { exclusivePluginConfig } from '../src/master-plugins.js'
import { OwnServerAccess } from '../src/own-access.js'
import { SharedPluginConfig } from '../src/shared-config.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-shared-config-'))

interface PluginState {
  enabled?: boolean
  enableDebug?: boolean
  configuration?: unknown
}

describe('plugins with the same settings on every server', () => {
  const plugins = new Map<string, PluginState>()
  const posts: { id: string; body: unknown }[] = []
  let own: { server: http.Server; url: string }
  let n = 0
  let accessRequests = 0

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.post('/signalk/v1/access/requests', (_req, res) => {
      accessRequests++
      res.sendStatus(404)
    })
    app.get('/plugins/:id/config', (req, res) => {
      const plugin = plugins.get(req.params.id)
      if (!plugin) {
        res.sendStatus(404)
        return
      }
      res.json(plugin)
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
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    plugins.clear()
    posts.length = 0
  })

  function shared(ids: string[] | (() => string[])): { config: SharedPluginConfig; dir: string } {
    const name = `s${String(++n)}`
    const dir = path.join(root, name, 'plugin-config')
    const config = new SharedPluginConfig({
      ids: typeof ids === 'function' ? ids : () => ids,
      access: new OwnServerAccess({
        store: new MultihelmStore(path.join(root, name)),
        serverId: 'own',
        ownUrl: () => own.url,
        debug: () => undefined
      }),
      ownUrl: () => own.url,
      selfId: 'signalk-multihelm',
      dir,
      debug: () => undefined,
      error: () => undefined
    })
    return { config, dir }
  }

  function incoming(key: string, value: unknown) {
    const file = path.join(root, `incoming-${String(++n)}.json`)
    fs.writeFileSync(file, JSON.stringify(value))
    return {
      key,
      meta: null,
      files: [{ name: 'configuration.json', path: file, size: 0, sha256: '', unchanged: false }]
    }
  }

  const read = (file: string | undefined): unknown =>
    JSON.parse(fs.readFileSync(file ?? '', 'utf8')) as unknown

  it('offers the settings of a plugin only from the server where it was added to the list', async () => {
    plugins.set('buddies', { enabled: true, configuration: { buddies: [{ urn: 'a' }] } })
    const here = shared(['buddies'])
    const other = shared(['buddies'])

    await here.config.seed(['buddies'])
    const [entry] = await here.config.dataset.list()
    expect(entry?.key).toBe('buddies')
    expect(read(entry?.files[0]?.path)).toEqual({ buddies: [{ urn: 'a' }] })
    expect(await other.config.dataset.list()).toEqual([])
  })

  it('offers a change made here once it holds the settings', async () => {
    plugins.set('buddies', { enabled: true, configuration: { buddies: [] } })
    const here = shared(['buddies'])
    await here.config.seed(['buddies'])
    await here.config.dataset.list()

    plugins.set('buddies', { enabled: true, configuration: { buddies: [{ urn: 'b' }] } })
    const [entry] = await here.config.dataset.list()
    expect(read(entry?.files[0]?.path)).toEqual({ buddies: [{ urn: 'b' }] })
  })

  it("takes a peer's settings, keeping whether the plugin runs here, and does not offer them back as a change", async () => {
    plugins.set('buddies', { enabled: false, enableDebug: true, configuration: { buddies: [] } })
    const here = shared(['buddies'])

    await here.config.dataset.apply(incoming('buddies', { buddies: [{ urn: 'c' }] }))
    expect(posts).toEqual([
      {
        id: 'buddies',
        body: { enabled: false, enableDebug: true, configuration: { buddies: [{ urn: 'c' }] } }
      }
    ])
    const [before] = await here.config.dataset.list()
    const [after] = await here.config.dataset.list()
    expect(read(before?.files[0]?.path)).toEqual({ buddies: [{ urn: 'c' }] })
    expect(after?.files[0]?.mtimeMs).toBe(before?.files[0]?.mtimeMs)
  })

  it('declines the settings of a plugin not installed here', async () => {
    const here = shared(['buddies'])
    await here.config.dataset.apply(incoming('buddies', { buddies: [] }))
    expect(posts).toEqual([])
    expect(await here.config.dataset.list()).toEqual([])
  })

  it('waits for the list before taking settings, and refuses settings that are not an object', async () => {
    plugins.set('buddies', { enabled: true, configuration: {} })
    const here = shared([])
    await expect(here.config.dataset.apply(incoming('buddies', {}))).rejects.toThrow(
      'not on the list'
    )
    const listed = shared(['buddies'])
    await expect(listed.config.dataset.apply(incoming('buddies', [1]))).rejects.toThrow(
      'not an object'
    )
    expect(posts).toEqual([])
  })

  it('stops offering a plugin taken off the list, leaving its settings here alone', async () => {
    plugins.set('buddies', { enabled: true, configuration: { buddies: [{ urn: 'd' }] } })
    let ids = ['buddies']
    const here = shared(() => ids)
    await here.config.seed(['buddies'])
    expect(await here.config.dataset.list()).toHaveLength(1)

    ids = []
    expect(await here.config.dataset.list()).toEqual([])
    expect(fs.existsSync(path.join(here.dir, 'buddies'))).toBe(false)
    expect(await here.config.dataset.remove('buddies')).toBe(true)
    expect(plugins.get('buddies')?.configuration).toEqual({ buddies: [{ urn: 'd' }] })
  })

  it('never shares the settings of Multihelm itself, nor takes keys that are not plugin ids', async () => {
    plugins.set('signalk-multihelm', { enabled: true, configuration: { master: true } })
    const here = shared(['signalk-multihelm'])
    await here.config.seed(['signalk-multihelm'])
    expect(await here.config.dataset.list()).toEqual([])
    expect(here.config.dataset.isValidKey?.('signalk-multihelm')).toBe(false)
    expect(here.config.dataset.isValidKey?.('..')).toBe(false)
    expect(here.config.dataset.isValidKey?.('signalk-buddylist-plugin')).toBe(true)
  })

  it('asks for no admin access while no plugin is on the list', async () => {
    accessRequests = 0
    const here = shared([])
    expect(await here.config.dataset.list()).toEqual([])
    expect(accessRequests).toBe(0)
  })

  it("waits for another writer of the plugin's settings, and keeps what it changed", async () => {
    plugins.set('buddies', { enabled: true, configuration: { buddies: [] } })
    const here = shared(['buddies'])
    let release = (): void => undefined
    const other = exclusivePluginConfig('buddies', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      plugins.set('buddies', { enabled: false, configuration: { buddies: [] } })
    })

    const applying = here.config.dataset.apply(incoming('buddies', { buddies: [{ urn: 'e' }] }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posts).toEqual([])
    release()
    await other
    await applying
    expect(plugins.get('buddies')).toEqual({
      enabled: false,
      configuration: { buddies: [{ urn: 'e' }] }
    })
  })

  it('does not write settings of a plugin taken off the list while it waited for another writer', async () => {
    plugins.set('buddies', { enabled: true, configuration: { buddies: [] } })
    let ids = ['buddies']
    let checked = (): void => undefined
    const firstCheck = new Promise<void>((resolve) => {
      checked = resolve
    })
    const here = shared(() => {
      checked()
      return ids
    })
    let release = (): void => undefined
    const other = exclusivePluginConfig('buddies', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })

    const applying = here.config.dataset.apply(incoming('buddies', { buddies: [{ urn: 'f' }] }))
    await firstCheck
    ids = []
    release()
    await other
    await expect(applying).rejects.toThrow('not on the list')
    expect(posts).toEqual([])
    expect(fs.existsSync(path.join(here.dir, 'buddies'))).toBe(false)
  })
})
