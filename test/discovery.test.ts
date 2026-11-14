import type { Answer } from 'dns-packet'
import { describe, expect, it } from 'vitest'

import { ServerDiscovery } from '../src/discovery.js'

describe('server discovery', () => {
  it('spells a found server as a paired one is, without the default port', () => {
    const discovery = new ServerDiscovery(() => 3000)
    discovery.takeRecords([
      { type: 'PTR', name: '_signalk-http._tcp.local', data: 'helm._signalk-http._tcp.local' },
      {
        type: 'SRV',
        name: 'helm._signalk-http._tcp.local',
        data: { target: 'helm.local', port: 80 }
      },
      { type: 'TXT', name: 'helm._signalk-http._tcp.local', data: ['vname=Moin'] },
      { type: 'A', name: 'helm.local', data: '192.0.2.10' }
    ] as Answer[])
    expect(discovery.list()).toHaveLength(1)
    expect(discovery.list()[0]).toMatchObject({
      name: 'helm',
      url: 'http://192.0.2.10',
      vessel: 'Moin'
    })
  })
})
