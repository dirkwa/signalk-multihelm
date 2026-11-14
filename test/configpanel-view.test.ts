import { describe, expect, it } from 'vitest'

import type { PeerInfo } from '../src/api.js'
import {
  ago,
  approveAccessUrl,
  peerName,
  roleNotice,
  unpairedServers,
  versionText
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
    pairedBy: [],
    discovered: [],
    ownAccess: null,
    ...over
  }
}

const now = 1_000_000_000
const helm: PeerInfo = {
  id: 'h',
  name: 'helm',
  url: 'http://192.0.2.10',
  state: 'paired',
  online: true,
  lastSeen: now - 12_000
}

describe('the configuration panel', () => {
  it('asks to pair while there is no peer, and names the master once there is one', () => {
    expect(roleNotice(status(), now)).toMatchObject({ tone: 'warning', text: /not paired yet/ })
    expect(roleNotice(status({ peers: [helm] }), now)).toMatchObject({
      tone: 'warning',
      text: /none of the paired servers/
    })
    expect(roleNotice(status({ peers: [helm], master: helm }), now)).toEqual({
      tone: 'success',
      text: "The boat's master is helm; it answered 12 s ago."
    })
    expect(roleNotice(status({ masterConflict: true }), now).tone).toBe('danger')
    expect(roleNotice(status({ running: false }), now).tone).toBe('danger')
  })

  it('says which paired servers cannot be reached while no master is found', () => {
    const away = { ...helm, name: 'nav', url: 'http://192.0.2.11', online: false }
    expect(roleNotice(status({ peers: [helm, away] }), now)).toEqual({
      tone: 'danger',
      text: 'No master found: nav is not reachable.'
    })
  })

  it('counts on the master the servers paired with it that are online', () => {
    const server = { id: 'n', name: 'nav', lastSeen: now, online: true }
    expect(roleNotice(status({ role: 'master' }), now)).toEqual({
      tone: 'info',
      text: "This server is the boat's master. No other server is paired with it yet."
    })
    expect(
      roleNotice(
        status({ role: 'master', pairedBy: [server, { ...server, id: 'c', online: false }] }),
        now
      ).text
    ).toBe("This server is the boat's master. 1 of the 2 servers paired with it is online.")
  })

  it('names the versions a server said', () => {
    expect(versionText({ signalk: '2.37.0', multihelm: '0.5.0' })).toBe(
      'Signal K 2.37.0 · Multihelm 0.5.0'
    )
    expect(versionText({ signalk: '2.37.0' })).toBe('Signal K 2.37.0')
    expect(versionText({})).toBe('')
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
