import http from 'node:http'
import type { AddressInfo } from 'node:net'

import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ROUTE_PREFIX } from '../src/peer-client.js'
import { registerRoutes } from '../src/routes.js'
import { MasterProxy, isSafePath, isValidPrefix, type MasterAccess } from '../src/master-proxy.js'

interface Seen {
  url: string
  headers: http.IncomingHttpHeaders
}

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
  })
}

function base(server: http.Server): string {
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
}

describe('path checks', () => {
  it('accepts plain paths and refuses traversal, encoded separators and doubled slashes', () => {
    expect(isSafePath('/signalk/v1/api/resources/charts/a/1/2/3')).toBe(true)
    expect(isSafePath('/signalk/v1/api/resources/charts/../../skServer')).toBe(false)
    expect(isSafePath('/signalk/v1/api/resources/charts/./x')).toBe(false)
    expect(isSafePath('/signalk/v1/api/resources/charts/%2e%2e/x')).toBe(false)
    expect(isSafePath('/signalk/v1/api/resources/charts/a%2Fb')).toBe(false)
    expect(isSafePath('/signalk/v1/api/resources/charts//x')).toBe(false)
    expect(isSafePath('/signalk/v1/api/resources/charts/a\\b')).toBe(false)
  })

  it('refuses prefixes of admin, access and Multihelm routes, and ones without a trailing slash', () => {
    expect(isValidPrefix('/signalk/v1/api/resources/charts/')).toBe(true)
    expect(isValidPrefix('/signalk/v1/api/resources/charts')).toBe(false)
    expect(isValidPrefix('/skServer/')).toBe(false)
    expect(isValidPrefix('/admin/')).toBe(false)
    expect(isValidPrefix('/signalk/v1/access/')).toBe(false)
    expect(isValidPrefix('/plugins/signalk-multihelm/')).toBe(false)
    expect(isValidPrefix('/')).toBe(false)
  })
})

describe('MasterProxy', () => {
  let master: http.Server
  let front: http.Server
  let proxy: MasterProxy
  let access: MasterAccess | null
  const seen: Seen[] = []

  beforeEach(async () => {
    seen.length = 0
    master = await listen((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=7776000',
        'Set-Cookie': 'JAUTHENTICATION=master-session'
      })
      res.end(Buffer.from('tile'))
    })
    access = { url: base(master), token: 'pairing-token' }
    proxy = new MasterProxy(() => access)
    front = await listen((req, res) => {
      proxy.forward((req.url ?? '').slice('/master'.length), req, res)
    })
  })

  afterEach(async () => {
    proxy.stop()
    await close(front)
    await close(master)
  })

  it('forwards a registered path with the pairing token and none of the caller credentials', async () => {
    proxy.register('/signalk/v1/api/resources/charts/')
    const res = await fetch(`${base(front)}/master/signalk/v1/api/resources/charts/c1/4/8/5?x=1`, {
      headers: { Authorization: 'Bearer caller-token', Cookie: 'JAUTHENTICATION=caller' }
    })

    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('tile')
    expect(res.headers.get('cache-control')).toBe('public, max-age=7776000')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('/signalk/v1/api/resources/charts/c1/4/8/5?x=1')
    expect(seen[0]?.headers.authorization).toBe('Bearer pairing-token')
    expect(seen[0]?.headers.cookie).toBeUndefined()
  })

  it('refuses paths no plugin registered, and traversal out of a registered one', async () => {
    const handle = proxy.register('/signalk/v1/api/resources/charts/')
    const outside = await fetch(`${base(front)}/master/signalk/v1/api/vessels/self`)
    const traversal = await fetch(
      `${base(front)}/master/signalk/v1/api/resources/charts/%2e%2e/%2e%2e/vessels/self`
    )
    handle.unregister()
    const unregistered = await fetch(
      `${base(front)}/master/signalk/v1/api/resources/charts/c1/1/1/1`
    )

    expect([outside.status, traversal.status, unregistered.status]).toEqual([404, 404, 404])
    expect(seen).toHaveLength(0)
  })

  it('answers 503 while no other server is the master', async () => {
    proxy.register('/signalk/v1/api/resources/charts/')
    access = null
    const res = await fetch(`${base(front)}/master/signalk/v1/api/resources/charts/c1/1/1/1`)

    expect(res.status).toBe(503)
  })

  it('answers 502 when the master cannot be reached', async () => {
    proxy.register('/signalk/v1/api/resources/charts/')
    access = { url: 'http://127.0.0.1:1', token: '' }
    const res = await fetch(`${base(front)}/master/signalk/v1/api/resources/charts/c1/1/1/1`)

    expect(res.status).toBe(502)
  })

  it('reads a registered path for plugins on this server', async () => {
    proxy.register('/signalk/v1/api/resources/charts/')
    const answer = await proxy.fetch('/signalk/v1/api/resources/charts/c1/1/1/1')

    expect(answer.status).toBe(200)
    expect(answer.body.toString()).toBe('tile')
    expect(answer.headers['content-type']).toBe('image/png')
    await expect(proxy.fetch('/skServer/settings')).rejects.toThrow(/no plugin forwards/)
  })

  it('refuses to register a prefix it would never forward', () => {
    expect(() => proxy.register('/skServer/')).toThrow(/not a path prefix/)
  })

  it('is served at the plugin route master/…', async () => {
    proxy.register('/signalk/v1/api/resources/charts/')
    const app = express()
    const router = express.Router()
    registerRoutes(
      router,
      () => null,
      () => [],
      () => null,
      () => proxy
    )
    app.use(ROUTE_PREFIX, router)
    const routed = await listen(app)
    const res = await fetch(
      `${base(routed)}${ROUTE_PREFIX}/master/signalk/v1/api/resources/charts/c1/2/3/4`
    )
    await close(routed)

    expect(res.status).toBe(200)
    expect(seen[0]?.url).toBe('/signalk/v1/api/resources/charts/c1/2/3/4')
  })
})
