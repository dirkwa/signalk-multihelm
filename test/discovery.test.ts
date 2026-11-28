import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Answer } from 'dns-packet'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultRoutes, ownNetworks, ServerDiscovery, type Network } from '../src/discovery.js'
import { answersAt } from '../src/peer-client.js'

vi.mock('multicast-dns', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: () =>
      Object.assign(new EventEmitter(), { query: () => undefined, destroy: () => undefined })
  }
})

const PRIMARY: Network = { address: '192.0.2.1', netmask: '255.255.255.0' }
const RADAR: Network = { address: '198.51.100.1', netmask: '255.255.0.0' }

function announce(
  name: string,
  addresses: string[],
  options: { port?: number; service?: string; vessel?: string } = {}
): Answer[] {
  const service = options.service ?? '_signalk-http._tcp.local'
  const instance = `${name}.${service}`
  return [
    { type: 'PTR', name: service, data: instance },
    {
      type: 'SRV',
      name: instance,
      data: { target: `${name}.local`, port: options.port ?? 80 }
    },
    { type: 'TXT', name: instance, data: options.vessel ? [`vname=${options.vessel}`] : [] },
    ...addresses.map((address): Answer => ({ type: 'A', name: `${name}.local`, data: address }))
  ] as Answer[]
}

function discovery(answering: (url: string) => boolean = () => true): {
  found: ServerDiscovery
  asked: string[]
} {
  const asked: string[] = []
  const found = new ServerDiscovery(() => 3000, {
    networks: () => [PRIMARY, RADAR],
    answers: (url) => {
      asked.push(url)
      return Promise.resolve(answering(url))
    }
  })
  return { found, asked }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('server discovery', () => {
  it('spells a found server as a paired one is, without the default port', () => {
    const { found } = discovery()
    found.takeRecords(announce('helm', ['192.0.2.10'], { vessel: 'Moin' }))
    expect(found.list()).toHaveLength(1)
    expect(found.list()[0]).toMatchObject({
      name: 'helm',
      url: 'http://192.0.2.10',
      addresses: ['http://192.0.2.10'],
      vessel: 'Moin'
    })
  })

  it("lists a server on two networks once, at its address on this server's primary one", async () => {
    const { found, asked } = discovery()
    found.takeRecords(announce('radar', ['198.51.100.148', '192.0.2.148']))
    expect(found.list()).toEqual([
      expect.objectContaining({
        url: 'http://192.0.2.148',
        addresses: ['http://192.0.2.148', 'http://198.51.100.148']
      })
    ])
    await vi.waitFor(() => {
      expect(found.list()[0]?.answers).toBe(true)
    })
    expect(asked.sort()).toEqual(['http://192.0.2.148', 'http://198.51.100.148'])
  })

  it('pairs at an address that answers, and says when none does', async () => {
    const { found } = discovery((url) => url.includes('198.51.100.'))
    found.takeRecords([
      ...announce('radar', ['192.0.2.148', '198.51.100.148']),
      ...announce('cabin', ['198.51.100.54'], { port: 45531 })
    ])
    await vi.waitFor(() => {
      expect(found.list().map((s) => [s.name, s.url, s.answers])).toEqual([
        ['cabin', 'http://198.51.100.54:45531', true],
        ['radar', 'http://198.51.100.148', true]
      ])
    })

    const { found: silent } = discovery(() => false)
    silent.takeRecords(announce('cabin', ['198.51.100.54'], { port: 45531 }))
    await vi.waitFor(() => {
      expect(silent.list()[0]?.answers).toBe(false)
    })
  })

  it('takes the HTTPS address of a server that announces both', () => {
    const { found } = discovery()
    found.takeRecords([
      ...announce('helm', ['192.0.2.10'], { port: 3000 }),
      ...announce('helm', ['192.0.2.10'], { port: 3443, service: '_signalk-https._tcp.local' })
    ])
    expect(found.list().map((s) => s.addresses)).toEqual([
      ['https://192.0.2.10:3443', 'http://192.0.2.10:3000']
    ])
  })

  it('forgets a server and an address it no longer hears of, while others still answer', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { found } = discovery()
    found.takeRecords([...announce('helm', ['192.0.2.10']), ...announce('cabin', ['192.0.2.54'])])
    vi.setSystemTime(Date.now() + 2 * 60_000)
    found.takeRecords(announce('helm', ['198.51.100.10']))
    vi.setSystemTime(Date.now() + 2 * 60_000)
    found.takeRecords(announce('helm', ['198.51.100.10']))
    expect(found.list().map((s) => [s.name, s.addresses])).toEqual([
      ['helm', ['http://198.51.100.10']]
    ])
  })

  it('drops a service and an address their goodbye takes back', () => {
    const { found } = discovery()
    found.takeRecords([...announce('helm', ['192.0.2.10', '198.51.100.10'])])
    found.takeRecords([{ type: 'A', name: 'helm.local', data: '192.0.2.10', ttl: 0 }] as Answer[])
    expect(found.list().map((s) => s.addresses)).toEqual([['http://198.51.100.10']])
    found.takeRecords([
      {
        type: 'PTR',
        name: '_signalk-http._tcp.local',
        data: 'helm._signalk-http._tcp.local',
        ttl: 0
      }
    ] as Answer[])
    expect(found.list()).toEqual([])
  })

  it('withdraws the endpoint an SRV goodbye takes back', () => {
    const { found } = discovery()
    found.takeRecords(announce('helm', ['192.0.2.10']))
    const srv = (target: string, ttl: number): Answer[] =>
      [
        {
          type: 'SRV',
          name: 'helm._signalk-http._tcp.local',
          data: { target, port: 80 },
          ttl
        }
      ] as Answer[]
    found.takeRecords(srv('other.local', 0))
    expect(found.list()).toHaveLength(1)
    found.takeRecords(srv('HELM.local', 0))
    expect(found.list()).toEqual([])
    found.takeRecords(srv('Helm.local', 120))
    expect(found.list().map((s) => s.url)).toEqual(['http://192.0.2.10'])
  })

  it('asks each address again every minute, also without a new announcement', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const found = new ServerDiscovery(() => 3000, {
      networks: () => [PRIMARY],
      answers: (url) => {
        asked.push(url)
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(true)
          }, 3000)
        })
      }
    })
    found.start()
    found.takeRecords(announce('helm', ['192.0.2.10']))
    expect(asked).toEqual(['http://192.0.2.10'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toHaveLength(3)
    found.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toHaveLength(3)
  })
})

describe("this server's networks", () => {
  const routes = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'eth0\t00001FAC\t00000000\t0001\t0\t0\t100\t0000FFFF\t0\t0\t0',
    'eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0'
  ].join('\n')

  const info = { mac: '00:00:00:00:00:00', cidr: null }
  const ipv4 = (address: string, netmask: string) => ({
    ...info,
    address,
    netmask,
    family: 'IPv4' as const,
    internal: false
  })

  it('reads the default routes from the route table', () => {
    expect(defaultRoutes(routes)).toEqual([{ iface: 'eth0', gateway: '192.168.0.1' }])
    expect(
      defaultRoutes(`${routes}\nwlan0\t00000000\t00000000\t0001\t0\t0\t50\t00000000\t0\t0\t0`)
    ).toEqual([
      { iface: 'wlan0', gateway: null },
      { iface: 'eth0', gateway: '192.168.0.1' }
    ])
    expect(defaultRoutes('')).toEqual([])
  })

  it('puts the network of a default route without a gateway first, by its interface', () => {
    const onLink = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'wlan0\t00000000\t00000000\t0001\t0\t0\t600\t00000000\t0\t0\t0'
    ].join('\n')
    expect(
      ownNetworks(
        {
          eth0: [ipv4('172.31.3.122', '255.255.0.0')],
          wlan0: [ipv4('10.0.0.5', '255.255.255.0')]
        },
        onLink
      )
    ).toEqual([
      { address: '10.0.0.5', netmask: '255.255.255.0' },
      { address: '172.31.3.122', netmask: '255.255.0.0' }
    ])
  })

  it('puts the network of the default route first, and leaves out loopback and IPv6', () => {
    expect(
      ownNetworks(
        {
          lo: [
            { ...info, address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }
          ],
          eth0: [
            {
              ...info,
              address: '172.31.3.122',
              netmask: '255.255.0.0',
              family: 'IPv4',
              internal: false
            },
            {
              ...info,
              address: '192.168.0.122',
              netmask: '255.255.255.0',
              family: 'IPv4',
              internal: false
            },
            {
              ...info,
              address: 'fe80::1',
              netmask: 'ffff:ffff:ffff:ffff::',
              family: 'IPv6',
              internal: false,
              scopeid: 2
            }
          ]
        },
        routes
      )
    ).toEqual([
      { address: '192.168.0.122', netmask: '255.255.255.0' },
      { address: '172.31.3.122', netmask: '255.255.0.0' }
    ])
  })
})

describe('asking whether a server answers', () => {
  it('counts any HTTP answer, and no connection as none', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 401
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    expect(await answersAt(`http://127.0.0.1:${String(port)}`)).toBe(true)
    await new Promise((resolve) => server.close(resolve))
    expect(await answersAt(`http://127.0.0.1:${String(port)}`)).toBe(false)
  })
})
