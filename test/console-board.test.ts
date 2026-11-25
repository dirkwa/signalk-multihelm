import { describe, expect, it } from 'vitest'

import type { PeerInfo } from '../src/api.js'
import {
  attention,
  installedPlugins,
  masterPluginProblems,
  serverColumns,
  stateText
} from '../src/console/board.js'
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
      [],
      now
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

  it('puts a missing master at the top, and nothing when all is well', () => {
    expect(attention(status({ peers: [port] }), [], now)[0]?.text).toMatch(/No master found/)
    expect(attention(status({ peers: [port], master: port }), [], now)).toEqual([])
  })
})
