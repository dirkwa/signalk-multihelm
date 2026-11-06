/**
 * Multihelm state on disk, in the plugin's data dir: this server's id, its
 * paired peers and one library per dataset. Peers hold access tokens, so
 * their file is readable by the server's user only.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'

import { emptyLibrary, type Library } from './library.js'

export const PeerSchema = Type.Object({
  /** The peer's server id, from its `hello`; empty until it answered once. */
  id: Type.String(),
  name: Type.String(),
  /** Base URL of the peer's Signal K server, e.g. `http://192.168.1.20:3000`. */
  url: Type.String(),
  /** Readonly device token; empty when the peer runs without security. */
  token: Type.String(),
  /** Set while an access request waits for approval on the peer. */
  requestHref: Type.Optional(Type.String()),
  state: Type.Union([
    Type.Literal('waiting-approval'),
    Type.Literal('paired'),
    Type.Literal('needs-pairing')
  ]),
  /** Per dataset, the peer's change sequence this server has applied up to. */
  cursors: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  lastSeen: Type.Optional(Type.Number()),
  lastSync: Type.Optional(Type.Number()),
  lastError: Type.Optional(Type.String())
})

export type Peer = Static<typeof PeerSchema>

const PeersFileSchema = Type.Array(PeerSchema)

/** This server's admin device token on itself, for writing what follows the master. */
export const OwnAccessSchema = Type.Object({
  token: Type.String(),
  requestHref: Type.Optional(Type.String()),
  state: Type.Union([
    Type.Literal('none'),
    Type.Literal('waiting-approval'),
    Type.Literal('granted'),
    Type.Literal('denied')
  ])
})

export type OwnAccess = Static<typeof OwnAccessSchema>

const LibraryFileSchema = Type.Object({
  seq: Type.Integer({ minimum: 0 }),
  entries: Type.Record(Type.String(), Type.Any())
})

function writeAtomic(file: string, data: string, mode?: number): void {
  const tmp = `${file}.${String(process.pid)}.tmp`
  fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode })
  fs.renameSync(tmp, file)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
  } catch {
    return undefined
  }
}

export class MultihelmStore {
  readonly dir: string

  constructor(dataDir: string) {
    this.dir = dataDir
    fs.mkdirSync(path.join(dataDir, 'datasets'), { recursive: true })
  }

  /** Where a peer's files for `dataset` wait until they are verified and applied. */
  incomingDir(dataset: string): string {
    return path.join(this.dir, 'incoming', encodeURIComponent(dataset))
  }

  private libraryFile(dataset: string): string {
    return path.join(this.dir, 'datasets', `${encodeURIComponent(dataset)}.json`)
  }

  loadLibrary(dataset: string): Library {
    const raw = readJson(this.libraryFile(dataset))
    return Value.Check(LibraryFileSchema, raw) ? raw : emptyLibrary()
  }

  saveLibrary(dataset: string, library: Library): void {
    writeAtomic(this.libraryFile(dataset), JSON.stringify(library))
  }

  loadPeers(): Peer[] {
    const raw = readJson(path.join(this.dir, 'peers.json'))
    return Value.Check(PeersFileSchema, raw) ? raw : []
  }

  savePeers(peers: readonly Peer[]): void {
    writeAtomic(path.join(this.dir, 'peers.json'), JSON.stringify(peers, null, 2), 0o600)
  }

  loadOwnAccess(): OwnAccess {
    const raw = readJson(path.join(this.dir, 'own-access.json'))
    return Value.Check(OwnAccessSchema, raw) ? raw : { token: '', state: 'none' }
  }

  saveOwnAccess(access: OwnAccess): void {
    writeAtomic(path.join(this.dir, 'own-access.json'), JSON.stringify(access), 0o600)
  }

  /** A random id made once per installation: every server of a boat shares its vessel id. */
  serverId(): string {
    const file = path.join(this.dir, 'server-id')
    try {
      const id = fs.readFileSync(file, 'utf-8').trim()
      if (id) {
        return id
      }
    } catch {
      // First start.
    }
    const id = crypto.randomUUID()
    writeAtomic(file, id)
    return id
  }
}
