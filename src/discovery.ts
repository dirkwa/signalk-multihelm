/**
 * Finds the other Signal K servers on the network, to offer them for pairing.
 *
 * Every Signal K server announces its REST API as `_signalk-http._tcp` (or
 * `_signalk-https._tcp`) over mDNS. The server's own discovery turns these
 * into data-connection suggestions only, so Multihelm asks for them itself
 * while it runs. Found servers are only shown; the user pairs with one.
 *
 * A server on more than one network is announced at an address on each; it
 * is listed once, at the address that answers, on the network of this
 * server's default route where it can be.
 */

import fs from 'node:fs'
import os from 'node:os'

import makeMdns from 'multicast-dns'
import type { Answer, TxtAnswer } from 'dns-packet'

import { answersAt, normalizePeerUrl } from './peer-client.js'

const SERVICES = ['_signalk-http._tcp.local', '_signalk-https._tcp.local']
const QUERY_INTERVAL_MS = 30_000
/** A server or an address not heard of for this long is dropped from the list. */
const FORGET_AFTER_MS = 3 * 60_000
/** How often each address is asked whether it answers. */
const CHECK_EVERY_MS = 60_000
/** How often the addresses due to be asked are looked for. */
const CHECK_TICK_MS = 10_000

export interface DiscoveredServer {
  /** The mDNS instance name, usually the host name. */
  name: string
  /** Where to pair with it: the first of `addresses`. */
  url: string
  /** Every address it is announced at, the best to pair at first. */
  addresses: string[]
  /** The vessel name from the announcement, when it has one. */
  vessel?: string
  lastSeen: number
  /** Whether it answered at `url` when last asked; unset until it was asked. */
  answers?: boolean
}

/** An IPv4 network this server is on. */
export interface Network {
  address: string
  netmask: string
}

interface Instance {
  service: string
  /** The host name, in lower case as `hosts` holds it. */
  target?: string
  port?: number
  txt: Record<string, string>
  seen: number
}

interface Announced {
  name: string
  url: string
  vessel?: string
  seen: number
}

interface Check {
  answers?: boolean
  at: number
  running: boolean
}

function txtRecord(answer: TxtAnswer): Record<string, string> {
  const result: Record<string, string> = {}
  const data = Array.isArray(answer.data) ? answer.data : [answer.data]
  for (const entry of data) {
    const text = typeof entry === 'string' ? entry : Buffer.from(entry).toString('utf-8')
    const eq = text.indexOf('=')
    if (eq > 0) {
      result[text.slice(0, eq)] = text.slice(eq + 1)
    }
  }
  return result
}

function ownAddresses(): Set<string> {
  const result = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      result.add(info.address)
    }
  }
  return result
}

function ipv4(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256)) {
    return null
  }
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0)
}

function onNetwork(network: Network, address: string): boolean {
  const host = ipv4(address)
  const own = ipv4(network.address)
  const mask = ipv4(network.netmask)
  return host !== null && own !== null && mask !== null && (host & mask) === (own & mask)
}

export interface DefaultRoute {
  iface: string
  /** Null for a route on the link itself, without a gateway. */
  gateway: string | null
}

/** The default routes in a Linux `/proc/net/route`, lowest metric first. */
export function defaultRoutes(routeTable: string): DefaultRoute[] {
  return routeTable
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, destination, gateway = '', , , , , mask]) =>
        destination === '00000000' && mask === '00000000' && /^[0-9A-F]{8}$/i.test(gateway)
    )
    .sort((a, b) => Number(a[6]) - Number(b[6]))
    .map(([iface = '', , gateway = '']) => ({
      iface,
      gateway:
        gateway === '00000000'
          ? null
          : [6, 4, 2, 0].map((at) => String(parseInt(gateway.slice(at, at + 2), 16))).join('.')
    }))
}

function routeTable(): string {
  try {
    return fs.readFileSync('/proc/net/route', 'utf8')
  } catch {
    return ''
  }
}

/** This server's IPv4 networks, those its default route leads through first. */
export function ownNetworks(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  routes: string = routeTable()
): Network[] {
  const networks = Object.entries(interfaces).flatMap(([iface, list]) =>
    (list ?? [])
      .filter((info) => info.family === 'IPv4' && !info.internal)
      .map((info) => ({ iface, network: { address: info.address, netmask: info.netmask } }))
  )
  const primary = defaultRoutes(routes).flatMap(({ iface, gateway }) =>
    networks
      .filter((own) => (gateway === null ? own.iface === iface : onNetwork(own.network, gateway)))
      .map((own) => own.network)
  )
  return [...new Set([...primary, ...networks.map((own) => own.network)])]
}

function preference(url: string, answers: boolean | undefined, networks: Network[]): number[] {
  const host = new URL(url).hostname
  const place = networks.findIndex((network) => onNetwork(network, host))
  return [
    answers === true ? 0 : answers === undefined ? 1 : 2,
    place === -1 ? networks.length : place,
    url.startsWith('https:') ? 0 : 1
  ]
}

function compare(a: number[], b: number[]): number {
  for (const [i, value] of a.entries()) {
    const other = b[i] ?? 0
    if (value !== other) {
      return value - other
    }
  }
  return 0
}

export class ServerDiscovery {
  private mdns: ReturnType<typeof makeMdns> | null = null
  private timer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private readonly instances = new Map<string, Instance>()
  /** Per host name in lower case, as DNS compares names, each address and when it was last announced. */
  private readonly hosts = new Map<string, Map<string, number>>()
  private readonly checks = new Map<string, Check>()

  constructor(
    private readonly ownPort: () => number | undefined,
    private readonly options: {
      answers?: (url: string) => Promise<boolean>
      networks?: () => Network[]
    } = {}
  ) {}

  start(): void {
    if (this.mdns) {
      return
    }
    try {
      this.mdns = makeMdns()
    } catch {
      this.mdns = null
      return
    }
    this.mdns.on('response', (response) => {
      this.takeRecords([...response.answers, ...response.additionals])
    })
    this.mdns.on('error', () => {
      // No multicast on this network; the list stays empty and pairing by address still works.
    })
    const query = (): void => {
      this.mdns?.query(SERVICES.map((name) => ({ name, type: 'PTR' as const })))
    }
    query()
    this.timer = setInterval(query, QUERY_INTERVAL_MS)
    this.checkTimer = setInterval(() => {
      this.checkAnswers(Date.now())
    }, CHECK_TICK_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.mdns?.destroy()
    this.mdns = null
  }

  /** One entry per server, by name. */
  list(): DiscoveredServer[] {
    const networks = (this.options.networks ?? ownNetworks)()
    const byName = new Map<string, Announced[]>()
    for (const announced of this.announced()) {
      const key = announced.name.toLowerCase()
      byName.set(key, [...(byName.get(key) ?? []), announced])
    }
    const result = [...byName.values()].map((found): DiscoveredServer => {
      const ranked = found
        .map((a) => ({ ...a, answers: this.checks.get(a.url)?.answers }))
        .sort(
          (a, b) =>
            compare(
              preference(a.url, a.answers, networks),
              preference(b.url, b.answers, networks)
            ) || a.url.localeCompare(b.url)
        )
      const [best] = ranked as [(typeof ranked)[number], ...typeof ranked]
      const vessel = ranked.find((a) => a.vessel !== undefined)?.vessel
      return {
        name: best.name,
        url: best.url,
        addresses: ranked.map((a) => a.url),
        lastSeen: Math.max(...ranked.map((a) => a.seen)),
        ...(vessel === undefined ? {} : { vessel }),
        ...(best.answers === undefined ? {} : { answers: best.answers })
      }
    })
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Fold in the records of one mDNS response. */
  takeRecords(records: Answer[]): void {
    const now = Date.now()
    for (const record of records) {
      if (record.type === 'PTR' && SERVICES.includes(record.name)) {
        if (record.ttl === 0) {
          this.instances.delete(record.data)
        } else {
          const instance = this.instances.get(record.data)
          if (instance) {
            instance.seen = now
          } else {
            this.instances.set(record.data, { service: record.name, txt: {}, seen: now })
          }
        }
      }
    }
    for (const record of records) {
      if (record.type === 'SRV') {
        const instance = this.instances.get(record.name)
        if (!instance) {
          continue
        }
        const target = record.data.target.toLowerCase()
        if (record.ttl !== 0) {
          instance.target = target
          instance.port = record.data.port
          instance.seen = now
        } else if (instance.target === target && instance.port === record.data.port) {
          delete instance.target
          delete instance.port
        }
      } else if (record.type === 'TXT') {
        const instance = this.instances.get(record.name)
        if (instance) {
          instance.txt = txtRecord(record)
          instance.seen = now
        }
      } else if (record.type === 'A') {
        const host = record.name.toLowerCase()
        const addresses = this.hosts.get(host) ?? new Map<string, number>()
        if (record.ttl === 0) {
          addresses.delete(record.data)
        } else {
          addresses.set(record.data, now)
        }
        this.hosts.set(host, addresses)
      }
    }
    this.checkAnswers(now)
  }

  /** Each address a server is announced at now, and drops what was not heard of for long. */
  private announced(now = Date.now()): Announced[] {
    for (const [name, instance] of this.instances) {
      if (now - instance.seen > FORGET_AFTER_MS) {
        this.instances.delete(name)
      }
    }
    for (const [host, addresses] of this.hosts) {
      for (const [address, seen] of addresses) {
        if (now - seen > FORGET_AFTER_MS) {
          addresses.delete(address)
        }
      }
      if (addresses.size === 0) {
        this.hosts.delete(host)
      }
    }
    const own = ownAddresses()
    const result: Announced[] = []
    for (const [instance, info] of this.instances) {
      if (!info.target || info.port === undefined) {
        continue
      }
      const scheme = info.service.startsWith('_signalk-https') ? 'https' : 'http'
      for (const [address, seen] of this.hosts.get(info.target) ?? []) {
        if (own.has(address) && info.port === this.ownPort()) {
          continue
        }
        // Spelled as a paired peer's address is, so the two can be matched.
        const url = normalizePeerUrl(`${scheme}://${address}:${String(info.port)}`)
        if (url) {
          result.push({
            name: instance.replace(`.${info.service}`, ''),
            url,
            seen: Math.min(seen, info.seen),
            ...(info.txt.vname ? { vessel: info.txt.vname } : {})
          })
        }
      }
    }
    const urls = new Set(result.map((a) => a.url))
    for (const url of this.checks.keys()) {
      if (!urls.has(url)) {
        this.checks.delete(url)
      }
    }
    return result
  }

  private checkAnswers(now: number): void {
    const answers = this.options.answers ?? answersAt
    for (const { url } of this.announced(now)) {
      const check = this.checks.get(url) ?? { at: 0, running: false }
      if (check.running || now - check.at < CHECK_EVERY_MS) {
        continue
      }
      check.running = true
      check.at = now
      this.checks.set(url, check)
      void answers(url)
        .catch(() => false)
        .then((answered) => {
          check.answers = answered
          check.running = false
        })
    }
  }
}
