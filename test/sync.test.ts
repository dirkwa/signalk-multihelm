/**
 * Two servers replicating a folder dataset over real HTTP on localhost.
 */

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatasetDefinition, DatasetEntry, DatasetHandle } from '../src/api.js'
import { SETTLE_MS } from '../src/library.js'
import { Multihelm, type MultihelmHost } from '../src/multihelm.js'
import { downloadFile, ROUTE_PREFIX } from '../src/peer-client.js'
import { registerRoutes } from '../src/routes.js'
import { MultihelmStore } from '../src/store.js'

const DATASET = 'test-plugin/folder'

/**
 * One entry per sub folder of `dir`, its files the folder's files; `meta`
 * comes from a map, as a plugin's own settings would.
 */
class FolderDataset implements DatasetDefinition {
  readonly id = DATASET
  readonly meta = new Map<string, unknown>()
  readonly removed: string[] = []
  keep = new Set<string>()

  constructor(readonly dir: string) {}

  list = (): Promise<DatasetEntry[]> => {
    const entries = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory())
    return Promise.resolve(
      entries.map((d) => {
        const folder = path.join(this.dir, d.name)
        return {
          key: d.name,
          meta: this.meta.get(d.name) ?? null,
          files: fs.readdirSync(folder).map((name) => {
            const file = path.join(folder, name)
            const stat = fs.statSync(file)
            return { name, path: file, size: stat.size, mtimeMs: stat.mtimeMs }
          })
        }
      })
    )
  }

  apply = async (entry: Parameters<DatasetDefinition['apply']>[0]): Promise<void> => {
    const folder = path.join(this.dir, entry.key)
    await fs.promises.mkdir(folder, { recursive: true })
    for (const file of entry.files) {
      if (!file.unchanged) {
        await fs.promises.rename(file.path, path.join(folder, file.name))
      }
    }
    for (const name of await fs.promises.readdir(folder)) {
      if (!entry.files.some((f) => f.name === name)) {
        await fs.promises.rm(path.join(folder, name))
      }
    }
    this.meta.set(entry.key, entry.meta)
  }

  remove = async (key: string): Promise<boolean> => {
    if (this.keep.has(key)) {
      return false
    }
    this.removed.push(key)
    await fs.promises.rm(path.join(this.dir, key), { recursive: true, force: true })
    return true
  }

  isValidKey = (key: string): boolean => /^[a-z0-9-]+$/.test(key)
}

interface Station {
  mh: Multihelm
  dataset: FolderDataset
  handle: DatasetHandle
  url: string
  server: http.Server
}

// A hidden folder on the way, as `~/.signalk` is, must not stop files being served.
const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-')), '.signalk')

function quiet(): MultihelmHost {
  return {
    serverName: () => 'quiet',
    isMaster: () => false,
    debug: (m: string) => {
      if (process.env.MHDEBUG) console.log(m)
    },
    error: () => undefined
  }
}

async function listen(app: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${String(port)}` }
}

async function station(name: string, master: () => boolean = () => false): Promise<Station> {
  const dir = path.join(root, name, 'folder')
  fs.mkdirSync(dir, { recursive: true })
  const mh = new Multihelm(new MultihelmStore(path.join(root, name, 'data')), {
    ...quiet(),
    serverName: () => name,
    isMaster: master
  })
  const dataset = new FolderDataset(dir)
  const handle = mh.registerDataset(dataset)
  const app = express()
  app.use(express.json())
  const router = express.Router()
  registerRoutes(
    router,
    () => mh,
    () => []
  )
  app.use(ROUTE_PREFIX, router)
  return { mh, dataset, handle, ...(await listen(app)) }
}

/**
 * Write a file, and make every file of its entry old enough to count as
 * settled (files a round just received are new).
 */
function write(dir: string, key: string, name: string, content: string): void {
  const folder = path.join(dir, key)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, name), content)
  const past = new Date(Date.now() - 2 * SETTLE_MS)
  for (const file of fs.readdirSync(folder)) {
    fs.utimesSync(path.join(folder, file), past, past)
  }
}

function read(dir: string, key: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, key, name), 'utf-8')
  } catch {
    return null
  }
}

describe('two servers', () => {
  let a: Station
  let b: Station

  beforeAll(async () => {
    a = await station('salon')
    b = await station('flybridge')
  })

  afterAll(() => {
    a.server.close()
    b.server.close()
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  })

  it('pairs without security and copies an entry with all its files', async () => {
    write(a.dataset.dir, 'finland', 'tiles', 'tiles of Finland')
    write(a.dataset.dir, 'finland', 'legend', 'legend')
    a.dataset.meta.set('finland', { enabled: true })
    await a.mh.runRound()

    const info = await b.mh.pair(a.url)
    expect(info).toMatchObject({ state: 'paired', name: 'salon', id: a.mh.serverId })

    await b.mh.runRound()
    expect(read(b.dataset.dir, 'finland', 'tiles')).toBe('tiles of Finland')
    expect(read(b.dataset.dir, 'finland', 'legend')).toBe('legend')
    expect(b.dataset.meta.get('finland')).toEqual({ enabled: true })
  })

  it('does not send an entry back to where it came from', async () => {
    await a.mh.pair(b.url)
    const before = fs.statSync(path.join(a.dataset.dir, 'finland', 'tiles')).mtimeMs
    await b.mh.runRound()
    await a.mh.runRound()
    expect(fs.statSync(path.join(a.dataset.dir, 'finland', 'tiles')).mtimeMs).toBe(before)
  })

  it('follows a change made on the other server, fetching only the changed file', async () => {
    write(b.dataset.dir, 'finland', 'tiles', 'newer tiles of Finland')
    const legend = fs.statSync(path.join(a.dataset.dir, 'finland', 'legend')).mtimeMs
    await b.mh.runRound()
    await a.mh.runRound()
    expect(read(a.dataset.dir, 'finland', 'tiles')).toBe('newer tiles of Finland')
    expect(fs.statSync(path.join(a.dataset.dir, 'finland', 'legend')).mtimeMs).toBe(legend)
  })

  it('follows a change of meta alone', async () => {
    a.dataset.meta.set('finland', { enabled: false })
    await a.mh.runRound()
    await b.mh.runRound()
    expect(b.dataset.meta.get('finland')).toEqual({ enabled: false })
  })

  it('follows a deletion, and the tombstone keeps it from coming back', async () => {
    fs.rmSync(path.join(a.dataset.dir, 'finland'), { recursive: true })
    await a.mh.runRound()
    await b.mh.runRound()
    expect(b.dataset.removed).toEqual(['finland'])
    expect(fs.existsSync(path.join(b.dataset.dir, 'finland'))).toBe(false)
    await a.mh.runRound()
    expect(fs.existsSync(path.join(a.dataset.dir, 'finland'))).toBe(false)
  })

  it('offers an entry the dataset keeps back to the peer that deleted it', async () => {
    write(a.dataset.dir, 'mine', 'cells', 'cells')
    await a.mh.runRound()
    await b.mh.runRound()
    expect(read(b.dataset.dir, 'mine', 'cells')).toBe('cells')

    a.dataset.keep.add('mine')
    fs.rmSync(path.join(b.dataset.dir, 'mine'), { recursive: true })
    await b.mh.runRound()
    await a.mh.runRound()
    expect(read(a.dataset.dir, 'mine', 'cells')).toBe('cells')
    await b.mh.runRound()
    expect(read(b.dataset.dir, 'mine', 'cells')).toBe('cells')
  })

  it('ignores keys the dataset does not accept', async () => {
    write(a.dataset.dir, 'Bad_Key', 'x', 'x')
    await a.mh.runRound()
    await b.mh.runRound()
    expect(fs.existsSync(path.join(b.dataset.dir, 'Bad_Key'))).toBe(false)
    fs.rmSync(path.join(a.dataset.dir, 'Bad_Key'), { recursive: true })
  })

  it('serves only files the dataset lists', async () => {
    const query = new URLSearchParams({ dataset: DATASET, key: '..', file: 'peers.json' })
    const res = await fetch(`${a.url}${ROUTE_PREFIX}/file?${query.toString()}`)
    expect(res.status).toBe(404)
  })

  it('answers 404 for a dataset it does not have', async () => {
    const res = await fetch(`${a.url}${ROUTE_PREFIX}/manifest?dataset=nope&since=0`)
    expect(res.status).toBe(404)
  })

  it('resumes an interrupted download', async () => {
    write(a.dataset.dir, 'resume', 'data', '0123456789')
    await a.mh.runRound()
    const dest = path.join(root, 'partial')
    fs.writeFileSync(dest, '01234')
    await downloadFile(a.url, '', { dataset: DATASET, key: 'resume', name: 'data' }, dest)
    expect(fs.readFileSync(dest, 'utf-8')).toBe('0123456789')
  })

  it('stops serving a dataset once it is unregistered', async () => {
    a.handle.unregister()
    expect(a.mh.hello().datasets).toEqual([])
    const res = await fetch(`${a.url}${ROUTE_PREFIX}/manifest?dataset=${DATASET}&since=0`)
    expect(res.status).toBe(404)
  })
})

describe('the master role', () => {
  const stations: Station[] = []

  afterAll(() => {
    for (const s of stations) {
      s.server.close()
    }
  })

  async function make(name: string, master: boolean | (() => boolean)): Promise<Station> {
    const s = await station(name, typeof master === 'function' ? master : () => master)
    stations.push(s)
    return s
  }

  it('is the server set to be the master, and the others learn it', async () => {
    const master = await make('role-salon', true)
    const member = await make('role-port', false)
    const seen: (string | null)[] = []
    member.mh.onRoleChanged((role, m) => {
      seen.push(`${role}:${m?.name ?? ''}`)
    })
    expect(master.mh.role()).toBe('master')
    expect(master.mh.master()).toBeNull()
    expect(member.mh.role()).toBe('member')
    expect(member.mh.master()).toBeNull()

    await member.mh.pair(master.url)
    await member.mh.runRound()
    expect(member.mh.role()).toBe('member')
    expect(member.mh.master()).toMatchObject({ name: 'role-salon', master: true })
    expect(seen).toEqual(['member:role-salon'])

    await member.mh.runRound()
    expect(seen).toHaveLength(1)

    await member.mh.unpair(master.url)
    expect(member.mh.master()).toBeNull()
    expect(seen).toEqual(['member:role-salon', 'member:'])
  })

  it('goes to the smallest server id when several are set to be the master', async () => {
    const x = await make('role-x', true)
    const y = await make('role-y', true)
    await x.mh.pair(y.url)
    await y.mh.pair(x.url)
    await x.mh.runRound()
    await y.mh.runRound()
    const [first, second] = [x, y].sort((p, q) => (p.mh.serverId < q.mh.serverId ? -1 : 1))
    expect(first?.mh.role()).toBe('master')
    expect(second?.mh.role()).toBe('member')
    expect(second?.mh.master()?.id).toBe(first?.mh.serverId)
    expect(x.mh.masterConflict()).toBe(true)
    expect(y.mh.masterConflict()).toBe(true)
  })

  it('learns the master while a round is still busy', async () => {
    let isMaster = false
    const master = await make('role-busy-salon', () => isMaster)
    const member = await make('role-busy-port', false)
    await member.mh.pair(master.url)
    isMaster = true

    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const list = member.dataset.list
    member.dataset.list = async () => {
      await blocked
      return list()
    }
    const round = member.mh.runRound()
    await member.mh.checkMasters()
    expect(member.mh.master()).toMatchObject({ name: 'role-busy-salon' })
    release()
    await round
    member.dataset.list = list
  })

  it('tells status listeners when a conflict ends, though the role stays', async () => {
    const set = new Map<string, boolean>([
      ['role-c-x', true],
      ['role-c-y', true]
    ])
    const x = await make('role-c-x', () => set.get('role-c-x') === true)
    const y = await make('role-c-y', () => set.get('role-c-y') === true)
    await x.mh.pair(y.url)
    await y.mh.pair(x.url)
    await x.mh.runRound()
    await y.mh.runRound()
    const larger = x.mh.serverId > y.mh.serverId ? x : y
    const smaller = larger === x ? y : x
    const roles: string[] = []
    const statuses: boolean[] = []
    smaller.mh.onRoleChanged((role) => {
      roles.push(role)
    })
    smaller.mh.onStatusChanged(() => {
      statuses.push(smaller.mh.masterConflict())
    })
    set.set(larger === x ? 'role-c-x' : 'role-c-y', false)
    await smaller.mh.checkMasters()
    expect(smaller.mh.role()).toBe('master')
    expect(roles).toEqual([])
    expect(statuses).toEqual([false])
  })
})

describe('a peer that refuses the token', () => {
  it('is marked for pairing again', async () => {
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 401
      res.end()
    })
    const store = new MultihelmStore(path.join(root, 'refused'))
    store.savePeers([
      { id: 'x', name: 'gone', url, token: 'revoked', state: 'paired', cursors: {} }
    ])
    const mh = new Multihelm(store, quiet())
    mh.registerDataset(new FolderDataset(path.join(root, 'refused')))
    await mh.runRound()
    server.close()
    expect(mh.peerInfo()[0]).toMatchObject({
      state: 'needs-pairing',
      lastError: 'access was revoked on the peer'
    })
  })
})
