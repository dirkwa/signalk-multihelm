import { describe, expect, it } from 'vitest'

import type { PeerInfo } from '../src/api.js'
import {
  ago,
  approveAccessUrl,
  peerName,
  roleNotice,
  unpairedServers
} from '../src/configpanel/view.js'
import type { Status } from '../src/status.js'

function status(over: Partial<Status> = {}): Status {
  return {
    available: true,
    running: true,
    serverId: 'own',
    name: 'port',
    role: 'member',
    master: null,
    masterConflict: false,
    datasets: [],
    peers: [],
    discovered: [],
    ownAccess: null,
    ...over
  }
}

const helm: PeerInfo = { id: 'h', name: 'helm', url: 'http://192.0.2.10', state: 'paired' }

describe('the configuration panel', () => {
  it('asks to pair while there is no peer, and names the master once there is one', () => {
    expect(roleNotice(status())).toMatchObject({ tone: 'warning', text: /not paired yet/ })
    expect(roleNotice(status({ peers: [helm] }))).toMatchObject({
      tone: 'warning',
      text: /none of the paired servers/
    })
    expect(roleNotice(status({ peers: [helm], master: helm }))).toEqual({
      tone: 'success',
      text: "The boat's master is helm."
    })
    expect(roleNotice(status({ role: 'master' })).tone).toBe('info')
    expect(roleNotice(status({ masterConflict: true })).tone).toBe('danger')
    expect(roleNotice(status({ running: false })).tone).toBe('danger')
  })

  it('offers only the servers found that are not paired, by address or by name', () => {
    const found = [
      { name: 'helm', url: 'http://198.51.100.10', lastSeen: 0 },
      { name: 'salon', url: 'http://192.0.2.10', lastSeen: 0 },
      { name: 'nav', url: 'http://192.0.2.20', lastSeen: 0 }
    ]
    expect(
      unpairedServers(status({ peers: [helm], discovered: found })).map((s) => s.name)
    ).toEqual(['nav'])
  })

  it('names a peer that has not answered yet as the network knows it', () => {
    const waiting: PeerInfo = {
      id: '',
      name: 'http://192.0.2.20',
      url: 'http://192.0.2.20',
      state: 'waiting-approval'
    }
    const found = [{ name: 'nav', url: 'http://192.0.2.20', lastSeen: 0 }]
    expect(peerName(waiting, found)).toBe('nav')
    expect(peerName(waiting, [])).toBe('http://192.0.2.20')
    expect(peerName(helm, found)).toBe('helm')
  })

  it('says how long ago a peer was seen', () => {
    const now = 1_000_000_000
    expect(ago(undefined, now)).toBe('never')
    expect(ago(now - 3_000, now)).toBe('just now')
    expect(ago(now - 42_000, now)).toBe('42 s ago')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago')
  })

  it('approves the request on the server the admin UI runs on', () => {
    expect(approveAccessUrl('signalk-multihelm-self-28d20b08')).toBe(
      '/skServer/security/access/requests/signalk-multihelm-self-28d20b08/approved'
    )
  })
})
