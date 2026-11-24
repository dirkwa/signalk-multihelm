import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MasterControlAccess } from '../src/master-control.js'
import { OwnServerAccess } from '../src/own-access.js'
import { MultihelmStore } from '../src/store.js'

/** A server with security that, like Signal K after a restart, knows only the requests made since. */
describe('an access request the server has forgotten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-access-'))
  let server: http.Server
  let url = ''
  let next = 1
  const known = new Set<string>()

  beforeAll(async () => {
    const app = express()
    app.post('/signalk/v1/access/requests', (_req, res) => {
      const href = `/signalk/v1/requests/${String(next++)}`
      known.add(href)
      res.status(202).json({ state: 'PENDING', href })
    })
    app.get('/signalk/v1/requests/:id', (req, res) => {
      if (known.has(req.path)) {
        res.json({ state: 'PENDING', href: req.path })
      } else {
        res.sendStatus(404)
      }
    })
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is asked for again on this server, so there is always one to approve', async () => {
    const store = new MultihelmStore(path.join(dir, 'own'))
    store.saveOwnAccess({
      token: '',
      requestHref: '/signalk/v1/requests/lost',
      state: 'waiting-approval'
    })
    const access = new OwnServerAccess({
      store,
      serverId: 'backup',
      ownUrl: () => url,
      debug: () => undefined
    })
    expect(await access.token()).toBeNull()
    expect(access.waitingForApproval()).toBe(true)
    expect(access.denied()).toBe(false)
    const href = store.loadOwnAccess().requestHref ?? ''
    expect(known.has(href)).toBe(true)
  })

  it('is looked at again when the settings show it', async () => {
    const store = new MultihelmStore(path.join(dir, 'recheck'))
    store.saveOwnAccess({
      token: '',
      requestHref: '/signalk/v1/requests/lost',
      state: 'waiting-approval'
    })
    const access = new OwnServerAccess({
      store,
      serverId: 'backup',
      ownUrl: () => url,
      debug: () => undefined
    })
    access.recheck()
    await expect.poll(() => known.has(store.loadOwnAccess().requestHref ?? '')).toBe(true)
  })

  it('is asked for again on the master', async () => {
    const store = new MultihelmStore(path.join(dir, 'control'))
    store.saveControlAccess({
      masterId: 'main',
      token: '',
      requestHref: '/signalk/v1/requests/lost',
      state: 'waiting-approval'
    })
    const control = new MasterControlAccess({
      store,
      serverId: 'backup',
      currentMaster: () => 'main',
      debug: () => undefined
    })
    expect(await control.token({ id: 'main', access: { url, token: 'pairing' } })).toBeNull()
    expect(control.waitingForApproval(false)).toMatchObject({ masterId: 'main' })
    expect(control.denied()).toBe(false)
    expect(known.has(store.loadControlAccess()?.requestHref ?? '')).toBe(true)
  })
})
