import { describe, expect, it } from 'vitest'

import type { PeerInfo } from '../src/api.js'
import {
  attention,
  consoleRoleNotice,
  installedPlugins,
  masterPluginProblems,
  pluginChoices,
  serverColumns,
  settingsNote,
  stateText
} from '../src/console/view.js'
import type { Status } from '../src/status.js'

function status(over: Partial<Status> = {}): Status {
  return {
    available: true,
    running: true,
    serverId: 'own',
    name: 'salon',
    role: 'member',
    master: null,
    masterConflict: false,
    datasets: [],
    peers: [],
    pairedBy: [],
    discovered: [],
    ownAccess: null,
    masterPlugins: [],
    sharedPlugins: [],
    controlAccess: null,
    ...over
  }
}

function fail(): never {
  throw new Error('no such column')
}

const now = 1_000_000_000
const port: PeerInfo = {
  id: 'p',
  name: 'flybridge-port',
  url: 'http://192.0.2.10',
  state: 'paired',
  online: true,
  master: true,
  lastSeen: now - 15_000,
  signalk: '2.33.0',
  multihelm: '0.9.1'
}
const stbd: PeerInfo = {
  id: 's',
  name: 'flybridge-stbd',
  url: 'http://192.0.2.11',
  state: 'paired',
  online: false,
  lastSeen: now - 600_000
}

describe('the console board', () => {
  it('shows this server first, then its peers, then servers that only pair with it', () => {
    const columns = serverColumns(
      status({
        peers: [port, stbd],
        master: port,
        pairedBy: [
          { id: 'p', name: 'flybridge-port', lastSeen: now, online: true },
          { id: 'b', name: 'backup', lastSeen: now - 20_000, online: true }
        ]
      })
    )
    expect(columns.map((c) => [c.name, c.here, c.master, c.state, c.oneWay])).toEqual([
      ['salon', true, false, 'online', false],
      ['flybridge-port', false, true, 'online', false],
      ['flybridge-stbd', false, false, 'offline', false],
      ['backup', false, false, 'online', true]
    ])
    expect(columns[1]?.versions).toBe('Signal K 2.33.0 · Multihelm 0.9.1')
  })

  it('names a peer that has not answered yet as the network does, and keeps its address', () => {
    const waiting: PeerInfo = {
      id: '',
      name: 'http://192.0.2.20',
      url: 'http://192.0.2.20',
      state: 'waiting-approval'
    }
    const [, column] = serverColumns(
      status({
        peers: [waiting],
        discovered: [{ name: 'nav', url: 'http://192.0.2.20', lastSeen: now }]
      })
    )
    expect([column?.name, column?.url]).toEqual(['nav', 'http://192.0.2.20'])
  })

  it('offers every installed plugin but Multihelm for a list, then those listed but not installed', () => {
    expect(
      pluginChoices(
        [
          { id: 'signalk-multihelm', name: 'Multihelm', enabled: true },
          { id: 'zz', name: 'Autopilot', enabled: true },
          { id: 'aa', name: 'Zigbee', enabled: false }
        ],
        ['gone', 'zz']
      )
    ).toEqual([
      { id: 'zz', name: 'Autopilot', installed: true },
      { id: 'aa', name: 'Zigbee', installed: true },
      { id: 'gone', name: 'gone', installed: false }
    ])
  })

  it("shows this server's own versions", () => {
    const [here] = serverColumns(status({ signalk: '2.37.0', multihelm: '0.10.1' }))
    expect(here?.versions).toBe('Signal K 2.37.0 · Multihelm 0.10.1')
  })

  it('offers to pair with a server that only pairs with this one, when it is announced', () => {
    const pairedBy = [{ id: 'r', name: 'pi5radar', lastSeen: now, online: true }]
    const [, announced] = serverColumns(
      status({
        pairedBy,
        discovered: [
          { name: 'pi5radar', url: 'http://192.0.2.20:3000', lastSeen: now },
          { name: 'pi5radar', url: 'https://192.0.2.20:3443', lastSeen: now },
          { name: 'other', url: 'http://192.0.2.30:3000', lastSeen: now }
        ]
      })
    )
    expect(announced?.pairUrl).toBe('https://192.0.2.20:3443')
    expect(settingsNote(announced ?? fail())).toContain('pair this server with pi5radar too')
    expect(settingsNote(announced ?? fail(), true)).toMatch(/^To keep both in step, pair/)

    const [, unknown] = serverColumns(status({ pairedBy }))
    expect(unknown?.pairUrl).toBeUndefined()
    expect(settingsNote(unknown ?? fail())).toContain('enter its address')
  })

  it('asks to update a peer whose Multihelm does not know the plan, and waits for one that does', () => {
    const [, older] = serverColumns(status({ peers: [port] }))
    expect(settingsNote(older ?? fail())).toBe(
      'To change its settings here, update Multihelm on flybridge-port to 0.10.0 or later.'
    )
    const [, newer] = serverColumns(status({ peers: [{ ...port, multihelm: '0.10.0' }] }))
    expect(settingsNote(newer ?? fail())).toBe(
      'Its settings show here once it has answered this server.'
    )
    const [, later] = serverColumns(status({ peers: [{ ...port, multihelm: '1.2.0-beta.1' }] }))
    expect(settingsNote(later ?? fail())).not.toContain('update')
  })

  it('marks this server as the master while it is', () => {
    const [here] = serverColumns(status({ role: 'master' }))
    expect(here?.master).toBe(true)
  })

  it('does not take a peer set to be master for the master the server follows', () => {
    const columns = serverColumns(status({ peers: [port] }))
    expect(columns[1]?.master).toBe(false)
  })

  it('says how long ago a peer answered', () => {
    const [, online, offline] = serverColumns(status({ peers: [port, stbd] }))
    expect(online && stateText(online, now)).toBe('Online, answered 15 s ago')
    expect(offline && stateText(offline, now)).toBe('Offline, last answered 10 min ago')
  })

  it('reads the installed plugins and whether they run', () => {
    expect(
      installedPlugins([
        { id: 'signalk-questdb', name: 'QuestDB', data: { enabled: true } },
        { id: 'rules', name: '', data: { enabled: false } },
        { name: 'no id' },
        null
      ])
    ).toEqual([
      { id: 'signalk-questdb', name: 'QuestDB', enabled: true },
      { id: 'rules', name: 'rules', enabled: false }
    ])
    expect(installedPlugins({})).toEqual([])
  })

  it('on the master, flags a master-only plugin that is missing or not started', () => {
    const installed = installedPlugins([
      { id: 'autopilot', name: 'Autopilot', data: { enabled: false } },
      { id: 'rules', name: 'Rules', data: { enabled: true } }
    ])
    const s = status({ role: 'master', masterPlugins: ['autopilot', 'rules', 'router'] })
    expect(masterPluginProblems(s, installed).map((a) => a.text)).toEqual([
      'Autopilot runs on the master only and is not started here yet.',
      'router runs on the master only, but is not installed here.'
    ])
    expect(masterPluginProblems({ ...s, role: 'member' }, installed)).toEqual([])
  })

  it('lists what needs someone to act, with where to do it', () => {
    const items = attention(
      status({
        peers: [port, { ...stbd, state: 'waiting-approval' }],
        master: port,
        ownAccess: { state: 'waiting-approval', request: 'r1' },
        controlAccess: { masterId: 'p', request: 'r2' }
      }),
      []
    )
    expect(items.map((a) => [a.tone, a.text, a.link?.href])).toEqual([
      [
        'warning',
        'Multihelm waits for admin access to this server.',
        '/admin/#/security/access/requests'
      ],
      [
        'warning',
        'The master, flybridge-port, has not approved commands from this server yet.',
        'http://192.0.2.10/admin/#/security/access/requests'
      ],
      [
        'warning',
        'Pairing with flybridge-stbd waits for approval there.',
        'http://192.0.2.11/admin/#/security/access/requests'
      ]
    ])
  })

  it('lists nothing when all is well', () => {
    expect(attention(status({ peers: [port], master: port }), [])).toEqual([])
  })

  it('sends a server not paired yet to pairing, and keeps the other notices', () => {
    expect(consoleRoleNotice(status(), now)).toEqual({
      tone: 'warning',
      text: "No master found: this server is not paired yet. Pair it with the boat's master under Pair with another server below."
    })
    expect(
      consoleRoleNotice(status({ peers: [{ ...port, state: 'waiting-approval' }] }), now).text
    ).toMatch(/not paired yet/)
    expect(consoleRoleNotice(status({ peers: [port] }), now).text).toMatch(
      /none of the paired servers/
    )
    expect(consoleRoleNotice(status({ peers: [port], master: port }), now).tone).toBe('success')
  })
})
