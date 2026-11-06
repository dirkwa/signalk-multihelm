/**
 * Serves what the boat's master provides at this server's own
 * `/plugins/signalk-multihelm/master/<path>`, so a browser at this station
 * talks to its own server only: no token for the master, no CORS, no mixed
 * content. Only paths under a prefix a plugin registered are forwarded,
 * always to the paired master and with its readonly pairing token; the
 * caller's credentials stay here.
 */

import http from 'node:http'
import https from 'node:https'

import type { MasterResponse, MasterRouteHandle } from './api.js'
import { ROUTE_PREFIX } from './peer-client.js'

export const MASTER_ROUTE = '/master'
const REQUEST_TIMEOUT_MS = 30_000
/** Largest body `fetch` reads into memory; the route itself streams. */
const MAX_FETCH_BYTES = 16 * 1024 * 1024

const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/
/** Encoded `.`, `/`, `\` and NUL, which could turn into a traversal after decoding. */
const ENCODED_SEPARATOR = /%(2e|2f|5c|00)/i
const FORBIDDEN_PREFIXES = [
  '/admin',
  '/skServer',
  '/signalk/v1/access',
  '/signalk/v1/auth',
  `${ROUTE_PREFIX}/`
]

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'if-none-match',
  'if-modified-since',
  'range'
]
const FORWARDED_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'vary'
]

export interface MasterAccess {
  url: string
  /** Empty when the master runs without security. */
  token: string
}

export class MasterProxyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export function isSafePath(path: string): boolean {
  if (!SAFE_PATH.test(path) || path.includes('//') || ENCODED_SEPARATOR.test(path)) {
    return false
  }
  return path
    .split('/')
    .slice(1)
    .every((segment) => segment !== '.' && segment !== '..')
}

export function isValidPrefix(prefix: string): boolean {
  return (
    prefix.length > 1 &&
    prefix.endsWith('/') &&
    isSafePath(prefix) &&
    !FORBIDDEN_PREFIXES.some((forbidden) => prefix.startsWith(forbidden))
  )
}

function headersFrom(source: http.IncomingHttpHeaders, names: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string') {
      headers[name] = value
    }
  }
  return headers
}

export class MasterProxy {
  private readonly prefixes = new Map<symbol, string>()
  private readonly agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true })
  }

  constructor(private readonly master: () => MasterAccess | null) {}

  register(prefix: string): MasterRouteHandle {
    if (!isValidPrefix(prefix)) {
      throw new Error(`not a path prefix Multihelm forwards to the master: ${prefix}`)
    }
    const id = Symbol(prefix)
    this.prefixes.set(id, prefix)
    return {
      unregister: () => {
        this.prefixes.delete(id)
      }
    }
  }

  /** The path and query of `target` when it may be forwarded, else null. */
  allowed(target: string): string | null {
    const queryAt = target.indexOf('?')
    const path = queryAt === -1 ? target : target.slice(0, queryAt)
    if (!isSafePath(path)) {
      return null
    }
    for (const prefix of this.prefixes.values()) {
      // A collection is listed at the prefix without its slash.
      if (path.startsWith(prefix) || path === prefix.slice(0, -1)) {
        return target
      }
    }
    return null
  }

  /** Forwards a GET that arrived at `<route>/master<target>` and streams the answer back. */
  forward(target: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    let upstream: http.ClientRequest
    try {
      upstream = this.request(target, headersFrom(req.headers, FORWARDED_REQUEST_HEADERS))
    } catch (error) {
      const status = error instanceof MasterProxyError ? error.status : 500
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      return
    }
    upstream.on('response', (answer) => {
      res.writeHead(
        answer.statusCode ?? 502,
        headersFrom(answer.headers, FORWARDED_RESPONSE_HEADERS)
      )
      answer.pipe(res)
    })
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      res.statusCode = error.message.startsWith('timeout') ? 504 : 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: `the master did not answer: ${error.message}` }))
    })
    res.on('close', () => {
      if (!res.writableFinished) {
        upstream.destroy()
      }
    })
    upstream.end()
  }

  /** Reads a path under a registered prefix from the master, for plugins on this server. */
  fetch(target: string): Promise<MasterResponse> {
    return new Promise((resolve, reject) => {
      const upstream = this.request(target, {})
      upstream.on('response', (answer) => {
        const chunks: Buffer[] = []
        let size = 0
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_FETCH_BYTES) {
            upstream.destroy(new Error(`answer larger than ${String(MAX_FETCH_BYTES)} bytes`))
            return
          }
          chunks.push(chunk)
        })
        answer.on('end', () => {
          resolve({
            status: answer.statusCode ?? 0,
            headers: headersFrom(answer.headers, FORWARDED_RESPONSE_HEADERS),
            body: Buffer.concat(chunks)
          })
        })
        answer.on('error', reject)
      })
      upstream.on('error', reject)
      upstream.end()
    })
  }

  stop(): void {
    this.prefixes.clear()
    this.agents.http.destroy()
    this.agents.https.destroy()
  }

  private request(target: string, headers: Record<string, string>): http.ClientRequest {
    const allowed = this.allowed(target)
    if (allowed === null) {
      throw new MasterProxyError(404, 'no plugin forwards this path to the master')
    }
    const master = this.master()
    if (!master) {
      throw new MasterProxyError(503, 'no other server is the master now')
    }
    const url = new URL(`${master.url}${allowed}`)
    const secure = url.protocol === 'https:'
    const request = secure ? https.request : http.request
    const upstream = request(url, {
      method: 'GET',
      headers: master.token ? { ...headers, Authorization: `Bearer ${master.token}` } : headers,
      agent: secure ? this.agents.https : this.agents.http,
      timeout: REQUEST_TIMEOUT_MS
    })
    upstream.on('timeout', () => {
      upstream.destroy(new Error(`timeout after ${String(REQUEST_TIMEOUT_MS)} ms`))
    })
    return upstream
  }
}
