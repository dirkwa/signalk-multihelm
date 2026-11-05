/**
 * HTTP client for a Multihelm peer: its routes, and the Signal K
 * device access request that pairs with it.
 *
 * Peers are other Signal K servers on the boat's network, addressed by the
 * URL the user confirmed. HTTPS peers are verified as usual, so a server
 * with a self-signed certificate is reached over its HTTP port instead.
 */

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'

export const ROUTE_PREFIX = '/plugins/signalk-multihelm'
const REQUEST_TIMEOUT_MS = 30_000

export interface Hello {
  serverId: string
  name: string
  protocol: number
  datasets: string[]
}

export interface Manifest {
  cursor: number
  entries: unknown[]
}

interface RawResponse {
  status: number
  stream: http.IncomingMessage
}

export class PeerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function send(
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`
  }
  let payload: string | undefined
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body)
    headers['Content-Type'] = 'application/json'
  }
  const target = new URL(url)
  const request = target.protocol === 'https:' ? https.request : http.request
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      resolve({ status: res.statusCode ?? 0, stream: res })
    })
    req.on('timeout', () =>
      req.destroy(new Error(`timeout after ${String(REQUEST_TIMEOUT_MS)} ms`))
    )
    req.on('error', reject)
    if (payload !== undefined) {
      req.write(payload)
    }
    req.end()
  })
}

async function readBody(res: RawResponse): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of res.stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function getJson(url: string, token?: string): Promise<unknown> {
  const res = await send('GET', url, { token })
  const text = await readBody(res)
  if (res.status < 200 || res.status >= 300) {
    throw new PeerHttpError(res.status, `HTTP ${String(res.status)} from ${url}`)
  }
  return JSON.parse(text) as unknown
}

/** `host:port` or a URL, reduced to `http(s)://host:port`; null when it is neither. */
export function normalizePeerUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.includes('://') ? input : `http://${input}`)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return null
  }
  return `${url.protocol}//${url.host}`
}

export async function fetchHello(base: string, token?: string): Promise<Hello> {
  const body = (await getJson(`${base}${ROUTE_PREFIX}/hello`, token)) as Partial<Hello>
  if (typeof body.serverId !== 'string' || typeof body.protocol !== 'number') {
    throw new Error(`${base} did not answer as a Multihelm peer`)
  }
  return {
    serverId: body.serverId,
    name: typeof body.name === 'string' ? body.name : base,
    protocol: body.protocol,
    datasets: Array.isArray(body.datasets)
      ? body.datasets.filter((d): d is string => typeof d === 'string')
      : []
  }
}

/** A page of a peer's dataset changes; its entries are checked by the caller. */
export async function fetchManifest(
  base: string,
  token: string,
  dataset: string,
  since: number
): Promise<Manifest> {
  const body = (await getJson(
    `${base}${ROUTE_PREFIX}/manifest?dataset=${encodeURIComponent(dataset)}&since=${String(since)}`,
    token
  )) as Partial<Manifest>
  if (typeof body.cursor !== 'number' || !Array.isArray(body.entries)) {
    throw new Error(`${base} sent a malformed manifest`)
  }
  return { cursor: body.cursor, entries: body.entries }
}

/** Download one file of a peer's entry into `dest`, resuming from what `dest` holds. */
export function downloadFile(
  base: string,
  token: string,
  file: { dataset: string; key: string; name: string },
  dest: string
): Promise<void> {
  const query =
    `file?dataset=${encodeURIComponent(file.dataset)}` +
    `&key=${encodeURIComponent(file.key)}&file=${encodeURIComponent(file.name)}`
  return download(base, token, query, `${file.key}/${file.name}`, dest)
}

async function download(
  base: string,
  token: string,
  query: string,
  label: string,
  dest: string
): Promise<void> {
  let offset = 0
  try {
    offset = fs.statSync(dest).size
  } catch {
    // Nothing to resume.
  }
  const url = `${base}${ROUTE_PREFIX}/${query}`
  const res = await send('GET', url, {
    token,
    headers: offset > 0 ? { Range: `bytes=${String(offset)}-` } : {}
  })
  if (res.status === 206) {
    await pipeline(res.stream, fs.createWriteStream(dest, { flags: 'a' }))
    return
  }
  if (res.status === 200) {
    await pipeline(res.stream, fs.createWriteStream(dest))
    return
  }
  res.stream.resume()
  throw new PeerHttpError(res.status, `HTTP ${String(res.status)} for ${label}`)
}

export type AccessRequestResult =
  | { kind: 'no-security' }
  | { kind: 'pending'; href: string }
  | { kind: 'approved'; token: string }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

/** Ask the peer for a readonly device token. */
export async function requestAccess(
  base: string,
  clientId: string,
  description: string
): Promise<AccessRequestResult> {
  const res = await send('POST', `${base}/signalk/v1/access/requests`, {
    body: { clientId, description, permissions: 'readonly' }
  })
  const text = await readBody(res)
  if (res.status === 404) {
    return { kind: 'no-security' }
  }
  if (res.status === 403) {
    return { kind: 'error', message: 'the peer does not accept device access requests' }
  }
  if (res.status !== 200 && res.status !== 202) {
    return { kind: 'error', message: `HTTP ${String(res.status)} from the access request` }
  }
  return interpretReply(JSON.parse(text) as unknown)
}

/** Follow up an access request that is waiting for approval. */
export async function pollAccess(base: string, href: string): Promise<AccessRequestResult> {
  const url = href.startsWith('/') ? `${base}${href}` : href
  if (!url.startsWith(`${base}/`)) {
    return { kind: 'error', message: 'the access request points to another server' }
  }
  try {
    return interpretReply(await getJson(url))
  } catch (error) {
    if (error instanceof PeerHttpError && error.status === 404) {
      return { kind: 'denied' }
    }
    throw error
  }
}

function interpretReply(raw: unknown): AccessRequestResult {
  const reply = raw as {
    state?: string
    href?: string
    accessRequest?: { permission?: string; token?: string }
  }
  if (reply.state === 'PENDING' && typeof reply.href === 'string') {
    return { kind: 'pending', href: reply.href }
  }
  if (reply.state === 'COMPLETED') {
    const token = reply.accessRequest?.token
    return token ? { kind: 'approved', token } : { kind: 'denied' }
  }
  return { kind: 'error', message: 'unexpected access request reply' }
}
