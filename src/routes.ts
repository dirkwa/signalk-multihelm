/**
 * Routes under `/plugins/signalk-multihelm/`.
 *
 * Peers read `hello`, `manifest`, `file` and `vessel-settings` with the readonly device token
 * they got when pairing, so those are registered with readonly access
 * (`router.access`, signalk-server 2.31 and later). Without it plugin routes
 * are admin-only, a readonly token cannot reach them, and `status` says
 * Multihelm is unavailable. `master/…` serves the master's answers to anyone
 * who may read here. Pairing and the status page stay admin-only.
 */

import type { IRouter, Request, Response } from 'express'

import type { DiscoveredServer } from './discovery.js'
import { MASTER_ROUTE, type MasterProxy } from './master-proxy.js'
import type { Multihelm } from './multihelm.js'
import type { HelloFrom } from './peer-client.js'
import type { OwnAccessState, Status } from './status.js'
import type { VesselSettings } from './vessel-settings.js'

type Handler = (req: Request, res: Response) => void | Promise<void>

interface AccessScopedRouter {
  get: (path: string, handler: Handler) => AccessScopedRouter
}

type RouterWithAccess = IRouter & {
  access?: (level: 'readonly' | 'readwrite' | 'admin') => AccessScopedRouter
}

const MAX_URL_LENGTH = 300

function queryString(req: Request, name: string): string {
  const value = (req.query as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : ''
}

const SERVER_ID = /^[\w-]{1,64}$/
const VERSION = /^[\w.+-]{1,32}$/

/** The server asking, when it said; what does not fit is left out. */
function helloFrom(req: Request): HelloFrom | null {
  const serverId = queryString(req, 'from')
  const name = queryString(req, 'name').trim().slice(0, 100)
  if (!SERVER_ID.test(serverId) || name === '') {
    return null
  }
  const signalk = queryString(req, 'signalk')
  const multihelm = queryString(req, 'multihelm')
  return {
    serverId,
    name,
    ...(VERSION.test(signalk) ? { signalk } : {}),
    ...(VERSION.test(multihelm) ? { multihelm } : {})
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerRoutes(
  router: IRouter,
  multihelm: () => Multihelm | null,
  discovered: () => DiscoveredServer[],
  vesselSettings: () => VesselSettings | null = () => null,
  masterProxy: () => MasterProxy | null = () => null,
  ownAccess: () => OwnAccessState = () => null
): void {
  const scoped = (router as RouterWithAccess).access
  const available = typeof scoped === 'function'
  const readonly: AccessScopedRouter = available
    ? scoped.call(router, 'readonly')
    : {
        get(path, handler) {
          router.get(path, handler)
          return this
        }
      }

  const running =
    (handler: (mh: Multihelm, req: Request, res: Response) => void | Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      const mh = multihelm()
      if (!mh) {
        res.status(503).json({ error: 'Multihelm is not running' })
        return
      }
      try {
        await handler(mh, req, res)
      } catch (error) {
        res.status(500).json({ error: errorText(error) })
      }
    }

  readonly.get(
    '/hello',
    running((mh, req, res) => {
      const from = helloFrom(req)
      if (from) {
        mh.sawPairedServer(from)
      }
      res.json(mh.hello())
    })
  )

  readonly.get(
    '/vessel-settings',
    running((_mh, _req, res) => {
      const settings = vesselSettings()
      if (!settings) {
        res.status(501).json({ error: 'this server does not expose its vessel settings' })
        return
      }
      res.json(settings)
    })
  )

  readonly.get(
    '/manifest',
    running((mh, req, res) => {
      const since = Number(queryString(req, 'since') || '0')
      if (!Number.isInteger(since) || since < 0) {
        res.status(400).json({ error: 'since must be a non-negative integer' })
        return
      }
      const manifest = mh.manifest(queryString(req, 'dataset'), since)
      if (!manifest) {
        res.status(404).json({ error: 'no such dataset' })
        return
      }
      res.json(manifest)
    })
  )

  readonly.get(
    '/file',
    running((mh, req, res) => {
      const file = mh.servableFile(
        queryString(req, 'dataset'),
        queryString(req, 'key'),
        queryString(req, 'file')
      )
      if (!file) {
        res.status(404).json({ error: 'no such file' })
        return
      }
      // Only files the dataset lists get here; the server's data dir sits under `.signalk`.
      res.sendFile(file, { acceptRanges: true, dotfiles: 'allow' })
    })
  )

  const forwardToMaster: Handler = (req, res) => {
    const proxy = masterProxy()
    if (!proxy) {
      res.status(503).json({ error: 'Multihelm is not running' })
      return
    }
    proxy.forward(req.url.slice(MASTER_ROUTE.length), req, res)
  }
  // The master's answer goes to whoever may read here; this server's own security decides who that is.
  // Express 4, which signalk-server runs, and Express 5 spell a wildcard differently.
  try {
    readonly.get(`${MASTER_ROUTE}/*`, forwardToMaster)
  } catch {
    readonly.get(`${MASTER_ROUTE}/*path`, forwardToMaster)
  }

  router.get('/status', (_req: Request, res: Response) => {
    const mh = multihelm()
    const status: Status = {
      available,
      running: mh !== null,
      serverId: mh?.serverId ?? null,
      name: mh?.hello().name ?? '',
      role: mh?.role() ?? null,
      master: mh?.master() ?? null,
      masterConflict: mh?.masterConflict() ?? false,
      datasets: mh?.datasetIds() ?? [],
      peers: mh?.peerInfo() ?? [],
      pairedBy: mh?.pairedByInfo() ?? [],
      discovered: mh ? discovered() : [],
      ownAccess: mh ? ownAccess() : null
    }
    res.json(status)
  })

  router.post(
    '/peers',
    running(async (mh, req, res) => {
      const url = (req.body as { url?: unknown } | undefined)?.url
      if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
        res.status(400).json({ error: 'url is required' })
        return
      }
      try {
        res.json(await mh.pair(url))
      } catch (error) {
        res.status(400).json({ error: errorText(error) })
      }
    })
  )

  router.delete(
    '/peers',
    running(async (mh, req, res) => {
      const url = queryString(req, 'url')
      res.status((await mh.unpair(url)) ? 200 : 404).json({ removed: url })
    })
  )

  router.delete(
    '/paired-by',
    running((mh, req, res) => {
      const id = queryString(req, 'id')
      res.status(mh.forgetPairedBy(id) ? 200 : 404).json({ removed: id })
    })
  )

  router.post(
    '/run',
    running((mh, _req, res) => {
      void mh.runRound()
      res.status(202).json({ started: true })
    })
  )
}
