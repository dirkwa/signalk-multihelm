/**
 * Finds the other Signal K servers on the network, to offer them for pairing.
 *
 * Every Signal K server announces its REST API as `_signalk-http._tcp` (or
 * `_signalk-https._tcp`) over mDNS. The server's own discovery turns these
 * into data-connection suggestions only, so Multihelm asks for them itself
 * while it runs. Found servers are only shown; the user pairs with one.
 */

import os from 'node:os'

import makeMdns from 'multicast-dns'
import type { Answer, TxtAnswer } from 'dns-packet'

import { normalizePeerUrl } from './peer-client.js'

const SERVICES = ['_signalk-http._tcp.local', '_signalk-https._tcp.local']
const QUERY_INTERVAL_MS = 30_000
/** A server not heard of for this long is dropped from the list. */
const FORGET_AFTER_MS = 3 * 60_000

export interface DiscoveredServer {
  /** The mDNS instance name, usually the host name. */
  name: string
  url: string
  /** The vessel name from the announcement, when it has one. */
  vessel?: string
  lastSeen: number
}

interface Instance {
  service: string
  target?: string
  port?: number
  txt: Record<string, string>
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

export class ServerDiscovery {
  private mdns: ReturnType<typeof makeMdns> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly instances = new Map<string, Instance>()
  private readonly addresses = new Map<string, string>()
  private readonly found = new Map<string, DiscoveredServer>()

  constructor(private readonly ownPort: () => number | undefined) {}

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
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.mdns?.destroy()
    this.mdns = null
  }

  list(): DiscoveredServer[] {
    const now = Date.now()
    for (const [key, server] of this.found) {
      if (now - server.lastSeen > FORGET_AFTER_MS) {
        this.found.delete(key)
      }
    }
    return [...this.found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Fold in the records of one mDNS response. */
  takeRecords(records: Answer[]): void {
    for (const record of records) {
      if (record.type === 'PTR' && SERVICES.includes(record.name)) {
        const instance = record.data
        if (!this.instances.has(instance)) {
          this.instances.set(instance, { service: record.name, txt: {} })
        }
      }
    }
    for (const record of records) {
      if (record.type === 'SRV') {
        const instance = this.instances.get(record.name)
        if (instance) {
          const srv = record.data
          instance.target = srv.target
          instance.port = srv.port
        }
      } else if (record.type === 'TXT') {
        const instance = this.instances.get(record.name)
        if (instance) {
          instance.txt = txtRecord(record)
        }
      } else if (record.type === 'A') {
        this.addresses.set(record.name, record.data)
      }
    }
    const own = ownAddresses()
    for (const [instance, info] of this.instances) {
      if (!info.target || info.port === undefined) {
        continue
      }
      const address = this.addresses.get(info.target)
      if (!address) {
        continue
      }
      if (own.has(address) && info.port === this.ownPort()) {
        continue
      }
      const scheme = info.service.startsWith('_signalk-https') ? 'https' : 'http'
      // Spelled as a paired peer's address is, so the two can be matched.
      const url = normalizePeerUrl(`${scheme}://${address}:${String(info.port)}`)
      if (!url) {
        continue
      }
      const server: DiscoveredServer = {
        name: instance.replace(`.${info.service}`, ''),
        url,
        lastSeen: Date.now()
      }
      if (info.txt.vname) {
        server.vessel = info.txt.vname
      }
      this.found.set(url, server)
    }
  }
}
