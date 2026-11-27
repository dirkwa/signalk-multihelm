/**
 * HTTP client for a Multihelm peer: its routes, and the Signal K
 * device access request that pairs with it.
 *
 * Peers are other Signal K servers on the boat's network, addressed by the
 * URL the user confirmed. An HTTPS peer is trusted the way Node trusts any
 * server or, when no CA that Node knows vouches for it, by the certificate it
 * presented when it was paired (see `locatePeer()`).
 */

import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { pipeline } from 'node:stream/promises'
import tls from 'node:tls'

export const ROUTE_PREFIX = '/plugins/signalk-multihelm'
const REQUEST_TIMEOUT_MS = 30_000
const ANSWER_TIMEOUT_MS = 3_000

/**
 * What Node calls a chain whose issuer it does not trust, the one failure a
 * certificate kept from pairing stands in for. Expiry and a name it was not
 * issued for are not among them: pinning must not paper over those.
 */
export const UNTRUSTED_ISSUER: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
])

/** Where a peer is, and how to trust it over HTTPS. */
export interface PeerAddress {
  url: string
  /**
   * PEM of the certificate the peer's chain must lead to, taken when it was
   * paired; absent when Node trusts the peer by itself, or over HTTP.
   */
  ca?: string
}

export interface Hello {
  serverId: string
  name: string
  protocol: number
  datasets: string[]
  /** This server is set to be the boat's master. */
  master: boolean
  /** Its place among the servers that take over as master while none set to be it is there; 0 or missing: never. */
  standby?: number
  /** It acts as the master now; older Multihelm versions leave it out, and act as the master while set to be it. */
  acting?: boolean
  /** The server it would make the master by taking over; its vote, so two never take over at once. */
  elects?: string
  /** The place to take over it keeps for the server asking, 0 for none; a server takes over only once every peer knows its place. */
  seesStandby?: number
  /** The Signal K server's version; older Multihelm versions leave it out. */
  signalk?: string
  /** Multihelm's version; older Multihelm versions leave it out. */
  multihelm?: string
  /** It serves data of its own at `shared-data` for the other servers to take. */
  shares?: boolean
}

/**
 * The server asking for a peer's `hello`, sent along so the peer can list
 * the servers paired with it. Older peers ignore it.
 */
export interface HelloFrom {
  serverId: string
  name: string
  /** It is set to be the boat's master; a peer that knew otherwise asks again at once. */
  master?: boolean
  /** It acts as the master now; a peer that knew otherwise asks again at once. */
  acting?: boolean
  signalk?: string
  multihelm?: string
}

function helloQuery(from: HelloFrom | undefined): string {
  if (!from) {
    return ''
  }
  const query = new URLSearchParams({ from: from.serverId, name: from.name })
  if (from.master !== undefined) {
    query.set('master', from.master ? '1' : '0')
  }
  if (from.acting !== undefined) {
    query.set('acting', from.acting ? '1' : '0')
  }
  if (from.signalk) {
    query.set('signalk', from.signalk)
  }
  if (from.multihelm) {
    query.set('multihelm', from.multihelm)
  }
  return `?${query.toString()}`
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
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

/** How to check the certificate of `target`, an HTTPS URL, trusted by `ca` when it is set. */
export function tlsOptions(target: URL, ca: string | undefined): https.RequestOptions {
  if (ca) {
    return {
      ca,
      // Trusted by this very certificate, whatever names it was issued for:
      // Signal K's own is issued for `localhost`, and a boat's IPs change.
      checkServerIdentity: () => undefined,
      // It is the leaf or an intermediate when a server leaves the rest of its chain out.
      allowPartialTrustChain: true
    }
  }
  // This server itself, reached over loopback, may well have a self-signed certificate.
  return target.hostname === '127.0.0.1' ? { rejectUnauthorized: false } : {}
}

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  options: {
    token?: string
    body?: unknown
    headers?: Record<string, string>
    ca?: string | undefined
  } = {}
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
    const req = request(
      target,
      { method, headers, timeout: REQUEST_TIMEOUT_MS, ...tlsOptions(target, options.ca) },
      (res) => {
        resolve({ status: res.statusCode ?? 0, stream: res })
      }
    )
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

async function getJson(url: string, token?: string, ca?: string): Promise<unknown> {
  const res = await send('GET', url, { token, ca })
  const text = await readBody(res)
  if (res.status < 200 || res.status >= 300) {
    throw new PeerHttpError(res.status, `HTTP ${String(res.status)} from ${url}`)
  }
  return JSON.parse(text) as unknown
}

/**
 * Whether a server answers Signal K's public discovery route at `url`. Only
 * that it answers counts, so nothing is read and its certificate is not
 * checked; pairing checks it.
 */
export function answersAt(url: string): Promise<boolean> {
  const target = new URL('/signalk', url)
  const request = target.protocol === 'https:' ? https.request : http.request
  return new Promise((resolve) => {
    const req = request(
      target,
      {
        timeout: ANSWER_TIMEOUT_MS,
        ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        res.resume()
        resolve(true)
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => {
      resolve(false)
    })
    req.end()
  })
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

/**
 * Where and how to reach the server at `url`, a normalized address, worked
 * out when pairing with it. An HTTP port that redirects to HTTPS on the same
 * host, as Signal K's does once SSL is on, is followed, and an address that
 * speaks HTTPS only is taken as HTTPS. An HTTPS server that no CA Node knows
 * vouches for is trusted from then on by the top certificate of the chain it
 * presents: the CA when signalk-ssl issued its certificate, the certificate
 * itself when Signal K made it.
 */
export async function locatePeer(url: string): Promise<PeerAddress> {
  const typed = new URL(url)
  const target = typed.protocol === 'https:' ? typed : await httpsTarget(typed)
  if (!target) {
    return { url }
  }
  const secureUrl = `https://${target.host}`
  const ca = await untrustedAnchor(target)
  return ca === undefined ? { url: secureUrl } : { url: secureUrl, ca }
}

/** Where HTTP `target` is to be reached over HTTPS instead; null when it is not. */
async function httpsTarget(target: URL): Promise<URL | null> {
  let res: RawResponse
  try {
    res = await send('GET', `${target.origin}/signalk`)
  } catch (error) {
    // A Signal K server's SSL port, typed without `https://`, hangs up on plain HTTP.
    if ((error as { code?: unknown }).code === 'ECONNRESET') {
      const same = new URL(`https://${target.hostname}:${target.port || '80'}`)
      if (await speaksTls(same)) {
        return same
      }
    }
    throw error
  }
  res.stream.resume()
  const location = res.status >= 300 && res.status < 400 ? res.stream.headers.location : undefined
  if (location === undefined) {
    return null
  }
  const next = new URL(location, target)
  return next.protocol === 'https:' && next.hostname === target.hostname
    ? new URL(`https://${next.host}`)
    : null
}

function connectTls(target: URL): Promise<tls.TLSSocket> {
  const host = target.hostname.replace(/^\[(.*)\]$/, '$1')
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port: Number(target.port || 443),
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
        // Checked by the caller, which needs the certificate either way.
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS
      },
      () => {
        resolve(socket)
      }
    )
    socket.on('timeout', () => {
      socket.destroy(new Error(`timeout after ${String(REQUEST_TIMEOUT_MS)} ms`))
    })
    socket.on('error', reject)
  })
}

async function speaksTls(target: URL): Promise<boolean> {
  try {
    ;(await connectTls(target)).end()
    return true
  } catch {
    return false
  }
}

/**
 * The top certificate of the chain `target` presents, as PEM, when Node
 * refuses the chain for its issuer alone; undefined otherwise.
 */
async function untrustedAnchor(target: URL): Promise<string | undefined> {
  const socket = await connectTls(target)
  try {
    // Node sets it to the error's code, though it is typed as the error.
    const reason = String(socket.authorizationError)
    if (socket.authorized || !UNTRUSTED_ISSUER.has(reason)) {
      return undefined
    }
    let top = socket.getPeerCertificate(true)
    // Node links a self-signed certificate to itself; the bound guards against any other loop.
    for (let depth = 0; depth < 10; depth++) {
      const issuer = top.issuerCertificate as tls.DetailedPeerCertificate | undefined
      if (!issuer || issuer.fingerprint256 === top.fingerprint256) {
        break
      }
      top = issuer
    }
    return new X509Certificate(top.raw).toString()
  } finally {
    socket.end()
  }
}

export async function fetchHello(
  peer: PeerAddress,
  token?: string,
  from?: HelloFrom
): Promise<Hello> {
  const body = (await getJson(
    `${peer.url}${ROUTE_PREFIX}/hello${helloQuery(from)}`,
    token,
    peer.ca
  )) as Partial<Hello>
  if (typeof body.serverId !== 'string' || typeof body.protocol !== 'number') {
    throw new Error(`${peer.url} did not answer as a Multihelm peer`)
  }
  const hello: Hello = {
    serverId: body.serverId,
    name: typeof body.name === 'string' ? body.name : peer.url,
    protocol: body.protocol,
    datasets: Array.isArray(body.datasets)
      ? body.datasets.filter((d): d is string => typeof d === 'string')
      : [],
    master: (body as { master?: unknown }).master === true
  }
  const signalk = optionalText(body.signalk)
  const multihelm = optionalText(body.multihelm)
  const standby = (body as { standby?: unknown }).standby
  const acting = (body as { acting?: unknown }).acting
  const elects = (body as { elects?: unknown }).elects
  const seesStandby = (body as { seesStandby?: unknown }).seesStandby
  const shares = (body as { shares?: unknown }).shares
  return {
    ...hello,
    ...(typeof standby === 'number' && Number.isInteger(standby) && standby > 0 ? { standby } : {}),
    ...(typeof acting === 'boolean' ? { acting } : {}),
    ...(typeof elects === 'string' && elects !== '' ? { elects } : {}),
    ...(typeof seesStandby === 'number' && Number.isInteger(seesStandby) && seesStandby >= 0
      ? { seesStandby }
      : {}),
    ...(signalk ? { signalk } : {}),
    ...(multihelm ? { multihelm } : {}),
    ...(shares === true ? { shares } : {})
  }
}

export async function fetchVesselSettings(peer: PeerAddress, token: string): Promise<unknown> {
  return getJson(`${peer.url}${ROUTE_PREFIX}/vessel-settings`, token, peer.ca)
}

/** A request to a Signal K server's own REST API; throws on any status but 2xx. */
/** A response read as it arrives; destroying `stream` ends it. */
export async function openStream(
  peer: PeerAddress,
  route: string,
  token: string
): Promise<{ status: number; stream: http.IncomingMessage }> {
  const res = await send('GET', `${peer.url}${ROUTE_PREFIX}${route}`, {
    token,
    ca: peer.ca,
    headers: { Accept: 'text/event-stream' }
  })
  return { status: res.status, stream: res.stream }
}

export async function callServer(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  body?: unknown
): Promise<unknown> {
  const res = await send(method, url, { token, body })
  const text = await readBody(res)
  if (res.status < 200 || res.status >= 300) {
    throw new PeerHttpError(res.status, `HTTP ${String(res.status)} from ${method} ${url}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** A request to a paired peer's REST API, trusted as when it was paired; throws on any status but 2xx. */
export async function callPeer(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  peer: PeerAddress,
  path: string,
  token: string,
  body?: unknown
): Promise<unknown> {
  const url = `${peer.url}${path}`
  const res = await send(method, url, { token, body, ca: peer.ca })
  const text = await readBody(res)
  if (res.status < 200 || res.status >= 300) {
    throw new PeerHttpError(res.status, `HTTP ${String(res.status)} from ${method} ${url}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** A page of a peer's dataset changes; its entries are checked by the caller. */
export async function fetchManifest(
  peer: PeerAddress,
  token: string,
  dataset: string,
  since: number
): Promise<Manifest> {
  const body = (await getJson(
    `${peer.url}${ROUTE_PREFIX}/manifest?dataset=${encodeURIComponent(dataset)}&since=${String(since)}`,
    token,
    peer.ca
  )) as Partial<Manifest>
  if (typeof body.cursor !== 'number' || !Array.isArray(body.entries)) {
    throw new Error(`${peer.url} sent a malformed manifest`)
  }
  return { cursor: body.cursor, entries: body.entries }
}

/** Download one file of a peer's entry into `dest`, resuming from what `dest` holds. */
export function downloadFile(
  peer: PeerAddress,
  token: string,
  file: { dataset: string; key: string; name: string },
  dest: string
): Promise<void> {
  const query =
    `file?dataset=${encodeURIComponent(file.dataset)}` +
    `&key=${encodeURIComponent(file.key)}&file=${encodeURIComponent(file.name)}`
  return download(peer, token, query, `${file.key}/${file.name}`, dest)
}

async function download(
  peer: PeerAddress,
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
  const url = `${peer.url}${ROUTE_PREFIX}/${query}`
  const res = await send('GET', url, {
    token,
    headers: offset > 0 ? { Range: `bytes=${String(offset)}-` } : {},
    ca: peer.ca
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
  /** The server no longer knows the request: it keeps them in memory, for an hour at most. */
  | { kind: 'gone' }
  | { kind: 'error'; message: string }

/** Ask the peer for a device token, readonly unless said otherwise. */
export async function requestAccess(
  peer: PeerAddress,
  clientId: string,
  description: string,
  permissions: 'readonly' | 'readwrite' | 'admin' = 'readonly'
): Promise<AccessRequestResult> {
  const res = await send('POST', `${peer.url}/signalk/v1/access/requests`, {
    body: { clientId, description, permissions },
    ca: peer.ca
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
export async function pollAccess(peer: PeerAddress, href: string): Promise<AccessRequestResult> {
  const url = href.startsWith('/') ? `${peer.url}${href}` : href
  if (!url.startsWith(`${peer.url}/`)) {
    return { kind: 'error', message: 'the access request points to another server' }
  }
  try {
    return interpretReply(await getJson(url, undefined, peer.ca))
  } catch (error) {
    if (error instanceof PeerHttpError && error.status === 404) {
      return { kind: 'gone' }
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
