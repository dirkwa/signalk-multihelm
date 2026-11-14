/**
 * Membership and dataset replication between the Signal K servers of a boat.
 *
 * Every server keeps a full copy of each registered dataset. Each round it
 * lists its own datasets, then asks every paired peer for the entries that
 * changed there and takes over those whose version wins over its own (see
 * `library.ts`). Replication has no master: any server may change or delete an
 * entry and the others follow, also a server that was off at the time.
 *
 * All work is serialized: a round, a pairing step and a registration never
 * run at the same time, so each library is changed by one of them at a time.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import type {
  DatasetDefinition,
  DatasetEntry,
  DatasetHandle,
  IncomingEntry,
  PeerInfo,
  Role
} from './api.js'
import {
  applyListing,
  compareVersions,
  isWellFormedRemote,
  manifestSince,
  recordRemote,
  type Library,
  type ListedEntry,
  type RemoteEntry
} from './library.js'
import {
  PeerHttpError,
  downloadFile,
  fetchHello,
  fetchManifest,
  normalizePeerUrl,
  pollAccess,
  requestAccess,
  type AccessRequestResult,
  type Hello
} from './peer-client.js'
import type { MultihelmStore, Peer } from './store.js'

export const PROTOCOL = 1
export const ROUND_INTERVAL_MS = 60_000
/**
 * Paired peers are asked whether they are set to be the master this often,
 * on a timer of its own, so a long round of transfers does not hold it up.
 */
export const MASTER_CHECK_INTERVAL_MS = 30_000
/**
 * A peer set to be the master counts as the master while it answered this
 * recently, so a few missed answers do not move the role.
 */
export const MASTER_STALE_MS = 5 * MASTER_CHECK_INTERVAL_MS
/** A pairing request waiting for approval is followed this often, so an approval shows at once. */
export const PAIRING_POLL_MS = 5_000
/** Free space kept beyond an incoming file, as a fraction of its size. */
const FREE_SPACE_MARGIN = 0.05

export interface MultihelmHost {
  serverName: () => string
  /** The user set this server to be the boat's master. */
  isMaster: () => boolean
  debug: (msg: string) => void
  error: (msg: string) => void
}

interface Dataset {
  definition: DatasetDefinition
  library: Library
  /** The last listing, for serving files: key → entry. */
  listed: Map<string, DatasetEntry>
}

export async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toListed(entry: DatasetEntry): ListedEntry {
  return {
    key: entry.key,
    meta: entry.meta,
    files: entry.files.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs }))
  }
}

export class Multihelm {
  private peers: Peer[]
  private readonly datasets = new Map<string, Dataset>()
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null
  /** Rounds run on their own between start and stop. */
  private started = false
  /** Set by stop: work under way ends at the next step. */
  private stopped = false
  /** Peer URL → when it last answered as set to be the master. */
  private readonly masterSeen = new Map<string, number>()
  private readonly roleListeners = new Set<(role: Role, master: PeerInfo | null) => void>()
  private readonly statusListeners = new Set<() => void>()
  /** What the role listeners were last told: role and master id. */
  private announcedRole = ''
  /** What the status listeners were last told: role, master id and conflict. */
  private announcedStatus = ''
  private masterTimer: NodeJS.Timeout | null = null
  private checkingMasters = false
  private pairingTimer: NodeJS.Timeout | null = null
  private pollingPairings = false
  readonly serverId: string

  constructor(
    private readonly store: MultihelmStore,
    private readonly host: MultihelmHost
  ) {
    this.peers = store.loadPeers()
    this.serverId = store.serverId()
  }

  start(): void {
    this.started = true
    this.stopped = false
    const tick = (): void => {
      void this.runRound().finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(tick, ROUND_INTERVAL_MS)
        }
      })
    }
    this.timer = setTimeout(tick, 0)
    this.masterTimer = setInterval(() => {
      void this.checkMasters()
    }, MASTER_CHECK_INTERVAL_MS)
    this.pairingTimer = setInterval(() => {
      this.pollPairings().catch((error: unknown) => {
        this.host.error(`Multihelm: following a pairing request: ${errorText(error)}`)
      })
    }, PAIRING_POLL_MS)
  }

  stop(): void {
    this.started = false
    this.stopped = true
    for (const timer of [this.timer, this.soon]) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    this.timer = null
    this.soon = null
    for (const timer of [this.masterTimer, this.pairingTimer]) {
      if (timer) {
        clearInterval(timer)
      }
    }
    this.masterTimer = null
    this.pairingTimer = null
  }

  /**
   * Asks every paired peer whether it is set to be the master. Runs outside
   * the work queue and touches nothing but `masterSeen`, so it neither waits
   * for a round nor races one.
   */
  async checkMasters(): Promise<void> {
    if (this.checkingMasters || this.stopped) {
      return
    }
    this.checkingMasters = true
    try {
      await Promise.all(
        this.peers
          .filter((p) => p.state === 'paired' && p.id !== '')
          .map(async (peer) => {
            let hello
            try {
              hello = await fetchHello(peer.url, peer.token)
            } catch {
              return // It counts until its last answer is stale.
            }
            // Unpaired or stopped meanwhile, or another server at that address now.
            if (this.stopped || !this.peers.includes(peer) || hello.serverId !== peer.id) {
              return
            }
            if (hello.master) {
              this.masterSeen.set(peer.url, Date.now())
            } else {
              this.masterSeen.delete(peer.url)
            }
          })
      )
    } finally {
      this.checkingMasters = false
    }
    // stop() may have run during the awaits above.
    if (!(this.stopped as boolean)) {
      this.announceRole()
    }
  }

  /**
   * Follows up the pairing requests waiting for approval, between rounds. At
   * most one waits in the queue, so a long round does not pile them up.
   */
  async pollPairings(): Promise<void> {
    const waiting = (): Peer[] => this.peers.filter((p) => p.state === 'waiting-approval')
    if (this.pollingPairings || this.stopped || waiting().length === 0) {
      return
    }
    this.pollingPairings = true
    try {
      await this.serialize(async () => {
        let paired = false
        for (const peer of waiting()) {
          if (this.stopped) {
            break
          }
          await this.pollPairingLocked(peer)
          paired ||= peer.state === 'paired'
        }
        this.store.savePeers(this.peers)
        this.announceRole()
        if (paired) {
          this.changedSoon()
        }
      })
    } finally {
      this.pollingPairings = false
    }
  }

  /** Run `task` after every task queued before it. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  // --- datasets -------------------------------------------------------

  registerDataset(definition: DatasetDefinition): DatasetHandle {
    if (this.datasets.has(definition.id)) {
      throw new Error(`dataset ${definition.id} is already registered`)
    }
    this.datasets.set(definition.id, {
      definition,
      library: this.store.loadLibrary(definition.id),
      listed: new Map()
    })
    this.changedSoon()
    return {
      changed: () => {
        this.changedSoon()
      },
      unregister: () => {
        if (this.datasets.get(definition.id)?.definition === definition) {
          this.datasets.delete(definition.id)
        }
      }
    }
  }

  datasetIds(): string[] {
    return [...this.datasets.keys()].sort()
  }

  /** A round a few seconds from now, so a burst of changes makes one round. */
  private changedSoon(): void {
    if (!this.started || this.soon) {
      return
    }
    this.soon = setTimeout(() => {
      this.soon = null
      void this.runRound()
    }, 2_000)
  }

  /** One listing of every dataset, then one round with every paired peer. */
  runRound(): Promise<void> {
    return this.serialize(async () => {
      for (const dataset of this.datasets.values()) {
        await this.listLocked(dataset)
      }
      for (const peer of this.peers) {
        if (this.stopped) {
          break
        }
        await this.pollPairingLocked(peer)
        if (peer.state === 'paired') {
          await this.helloLocked(peer)
        }
        if (peer.state === 'paired') {
          await this.syncPeerLocked(peer)
        }
      }
      this.store.savePeers(this.peers)
      this.announceRole()
    })
  }

  // --- master role ----------------------------------------------------

  /** The servers set to be the master that count now, this one included, smallest id first. */
  private masterCandidates(): { id: string; peer: Peer | null }[] {
    const now = Date.now()
    const candidates: { id: string; peer: Peer | null }[] = []
    if (this.host.isMaster()) {
      candidates.push({ id: this.serverId, peer: null })
    }
    for (const peer of this.peers) {
      const seen = this.masterSeen.get(peer.url)
      if (
        peer.state === 'paired' &&
        peer.id !== '' &&
        seen !== undefined &&
        now - seen <= MASTER_STALE_MS
      ) {
        candidates.push({ id: peer.id, peer })
      }
    }
    return candidates.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  }

  role(): Role {
    return this.masterCandidates()[0]?.peer === null ? 'master' : 'member'
  }

  master(): PeerInfo | null {
    const peer = this.masterCandidates()[0]?.peer
    return peer ? this.infoOf(peer) : null
  }

  /** Where to reach the master, with the pairing token; null when this server is it or there is none. */
  masterAccess(): { url: string; token: string } | null {
    const peer = this.masterCandidates()[0]?.peer
    return peer ? { url: peer.url, token: peer.token } : null
  }

  /** More than one server is set to be the master: the user should set one only. */
  masterConflict(): boolean {
    return this.masterCandidates().length > 1
  }

  /** Calls `cb` whenever the role, the master or `masterConflict()` changes. */
  onStatusChanged(cb: () => void): () => void {
    this.statusListeners.add(cb)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  onRoleChanged(cb: (role: Role, master: PeerInfo | null) => void): () => void {
    this.roleListeners.add(cb)
    return () => {
      this.roleListeners.delete(cb)
    }
  }

  private announceRole(): void {
    const role = this.role()
    const master = this.master()
    const now = `${role}:${master?.id ?? ''}`
    const status = `${now}:${String(this.masterConflict())}`
    if (now !== this.announcedRole) {
      this.announcedRole = now
      for (const cb of this.roleListeners) {
        try {
          cb(role, master)
        } catch (error) {
          this.host.error(`Multihelm: a role listener failed: ${errorText(error)}`)
        }
      }
    }
    if (status !== this.announcedStatus) {
      this.announcedStatus = status
      for (const cb of this.statusListeners) {
        try {
          cb()
        } catch (error) {
          this.host.error(`Multihelm: a status listener failed: ${errorText(error)}`)
        }
      }
    }
  }

  private async listLocked(dataset: Dataset): Promise<void> {
    const id = dataset.definition.id
    let listed: DatasetEntry[]
    try {
      listed = await dataset.definition.list()
    } catch (error) {
      this.host.error(`Multihelm: listing ${id} failed: ${errorText(error)}`)
      return
    }
    dataset.listed = new Map(listed.map((e) => [e.key, e]))
    const { changed } = applyListing(
      dataset.library,
      listed.map(toListed),
      this.serverId,
      Date.now()
    )
    for (const key of changed) {
      const entry = dataset.library.entries[key]
      const local = dataset.listed.get(key)
      if (!entry || !local) {
        continue
      }
      for (const file of entry.files) {
        if (this.stopped) {
          break
        }
        const source = local.files.find((f) => f.name === file.name)
        if (!source || file.sha256 !== undefined) {
          continue
        }
        try {
          file.sha256 = await hashFile(source.path)
        } catch (error) {
          this.host.debug(`Multihelm: cannot hash ${source.path}: ${errorText(error)}`)
        }
      }
    }
    // Hashes stay unknown for entries whose files could not be read: those are held back.
    this.store.saveLibrary(id, dataset.library)
  }

  // --- serving --------------------------------------------------------

  hello(): Hello {
    return {
      serverId: this.serverId,
      name: this.host.serverName(),
      protocol: PROTOCOL,
      datasets: this.datasetIds(),
      master: this.host.isMaster()
    }
  }

  manifest(datasetId: string, since: number): { cursor: number; entries: RemoteEntry[] } | null {
    const dataset = this.datasets.get(datasetId)
    return dataset ? manifestSince(dataset.library, since) : null
  }

  /** Absolute path of a file this server offers, or null. */
  servableFile(datasetId: string, key: string, name: string): string | null {
    const dataset = this.datasets.get(datasetId)
    const entry = dataset?.library.entries[key]
    if (!dataset || !entry || entry.deletedAt !== undefined) {
      return null
    }
    const file = entry.files.find((f) => f.name === name)
    const local = dataset.listed.get(key)?.files.find((f) => f.name === name)
    if (!file?.sha256 || !local || local.size !== file.size || local.mtimeMs !== file.mtimeMs) {
      return null
    }
    return local.path
  }

  // --- pulling --------------------------------------------------------

  private async syncPeerLocked(peer: Peer): Promise<void> {
    try {
      for (const dataset of this.datasets.values()) {
        if (this.stopped) {
          return
        }
        await this.syncDatasetLocked(peer, dataset)
      }
      peer.lastSeen = Date.now()
      peer.lastSync = Date.now()
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        peer.state = 'needs-pairing'
        peer.lastError = 'access was revoked on the peer'
      } else {
        peer.lastError = errorText(error)
      }
      this.host.debug(`Multihelm: ${peer.name}: ${peer.lastError}`)
    }
  }

  private async syncDatasetLocked(peer: Peer, dataset: Dataset): Promise<void> {
    const id = dataset.definition.id
    let manifest
    try {
      manifest = await fetchManifest(peer.url, peer.token, id, peer.cursors[id] ?? 0)
    } catch (error) {
      if (error instanceof PeerHttpError && error.status === 404) {
        return // The peer does not have this dataset.
      }
      throw error
    }
    try {
      for (const raw of manifest.entries) {
        if (this.stopped) {
          return
        }
        // Stop at the first entry that fails, so the cursor never skips it.
        if (!(await this.applyRemote(peer, dataset, raw))) {
          return
        }
      }
      peer.cursors[id] = manifest.cursor
      if (peer.lastError?.startsWith(`${id}:`)) {
        delete peer.lastError
      }
    } finally {
      this.store.saveLibrary(id, dataset.library)
    }
  }

  /** Apply one entry of a peer's manifest; false when it failed and is tried again. */
  private async applyRemote(peer: Peer, dataset: Dataset, raw: unknown): Promise<boolean> {
    const { definition, library } = dataset
    if (!isWellFormedRemote(raw) || (definition.isValidKey && !definition.isValidKey(raw.key))) {
      this.host.debug(`Multihelm: ignoring a malformed ${definition.id} entry from ${peer.name}`)
      return true
    }
    const remote = raw
    const local = library.entries[remote.key]
    if (local && compareVersions(remote.version, local.version) <= 0) {
      return true
    }
    const fail = (error: unknown): false => {
      peer.lastError = `${definition.id}: ${remote.key}: ${errorText(error)}`
      this.host.debug(`Multihelm: ${peer.lastError}`)
      return false
    }

    if (remote.deletedAt !== undefined) {
      if (!local || local.deletedAt !== undefined || local.declined) {
        recordRemote(library, remote, null)
        return true
      }
      try {
        if (await definition.remove(remote.key)) {
          recordRemote(library, remote, null)
        } else {
          // Kept here: offer it back as this server's change.
          library.seq++
          library.entries[remote.key] = {
            ...local,
            version: { counter: remote.version.counter + 1, origin: this.serverId },
            seq: library.seq
          }
        }
        return true
      } catch (error) {
        return fail(error)
      }
    }

    try {
      const incoming = await this.fetchFiles(peer, dataset, remote)
      if (!incoming) {
        return false
      }
      await definition.apply(incoming)
      await this.cleanIncoming(definition.id, incoming)
      const after = (await definition.list()).find((e) => e.key === remote.key)
      if (after) {
        dataset.listed.set(after.key, after)
      }
      recordRemote(library, remote, after ? toListed(after) : null)
      return true
    } catch (error) {
      return fail(error)
    }
  }

  /** The peer's entry with every file verified on this server's disk, or null on failure. */
  private async fetchFiles(
    peer: Peer,
    dataset: Dataset,
    remote: RemoteEntry
  ): Promise<IncomingEntry | null> {
    const id = dataset.definition.id
    const mine = dataset.library.entries[remote.key]
    const listed = dataset.listed.get(remote.key)
    const incomingDir = this.store.incomingDir(id)
    await fs.promises.mkdir(incomingDir, { recursive: true })
    const files: IncomingEntry['files'] = []
    for (const file of remote.files) {
      const have = mine?.files.find(
        (f) => f.name === file.name && f.sha256 === file.sha256 && f.size === file.size
      )
      const own = have ? listed?.files.find((f) => f.name === file.name) : undefined
      if (own && own.size === file.size) {
        files.push({
          name: file.name,
          path: own.path,
          size: file.size,
          sha256: file.sha256,
          unchanged: true
        })
        continue
      }
      const dest = path.join(incomingDir, file.sha256)
      const already = await fs.promises.stat(dest).then(
        (s) => s.size,
        () => 0
      )
      if (already > file.size) {
        await fs.promises.rm(dest, { force: true })
      }
      if (already !== file.size) {
        const free = await fs.promises.statfs(incomingDir)
        if (free.bavail * free.bsize < (file.size - already) * (1 + FREE_SPACE_MARGIN)) {
          peer.lastError = `${id}: not enough free space for ${remote.key}`
          return null
        }
        this.host.debug(`Multihelm: fetching ${id} ${remote.key} ${file.name} from ${peer.name}`)
        await downloadFile(
          peer.url,
          peer.token,
          { dataset: id, key: remote.key, name: file.name },
          dest
        )
      }
      const size = (await fs.promises.stat(dest)).size
      if (size !== file.size || (await hashFile(dest)) !== file.sha256) {
        await fs.promises.rm(dest, { force: true })
        peer.lastError = `${id}: ${remote.key} arrived damaged; it is fetched again`
        return null
      }
      files.push({
        name: file.name,
        path: dest,
        size: file.size,
        sha256: file.sha256,
        unchanged: false
      })
    }
    return { key: remote.key, meta: remote.meta, files }
  }

  /** Files the dataset copied rather than moved are left in the work folder; remove them. */
  private async cleanIncoming(datasetId: string, entry: IncomingEntry): Promise<void> {
    const dir = this.store.incomingDir(datasetId)
    for (const file of entry.files) {
      if (!file.unchanged && path.dirname(file.path) === dir) {
        await fs.promises.rm(file.path, { force: true })
      }
    }
  }

  // --- peers ----------------------------------------------------------

  peerInfo(): PeerInfo[] {
    return this.peers.map((p) => this.infoOf(p))
  }

  private infoOf(p: Peer): PeerInfo {
    const info: PeerInfo = { id: p.id, name: p.name, url: p.url, state: p.state }
    if (p.lastSeen !== undefined) {
      info.lastSeen = p.lastSeen
    }
    if (p.lastSync !== undefined) {
      info.lastSync = p.lastSync
    }
    if (p.lastError !== undefined) {
      info.lastError = p.lastError
    }
    const seen = this.masterSeen.get(p.url)
    if (seen !== undefined && Date.now() - seen <= MASTER_STALE_MS) {
      info.master = true
    }
    return info
  }

  /**
   * Pair with the server at `input`: without security it is paired at once,
   * otherwise a readonly device access request waits for approval there.
   */
  pair(input: string): Promise<PeerInfo> {
    return this.serialize(async () => {
      const url = normalizePeerUrl(input)
      if (!url) {
        throw new Error('not a server address')
      }
      let peer = this.peers.find((p) => p.url === url)
      if (!peer) {
        peer = { id: '', name: url, url, token: '', state: 'needs-pairing', cursors: {} }
        this.peers.push(peer)
      }
      const result = await requestAccess(
        url,
        `signalk-multihelm-${this.serverId}-${crypto.randomUUID().slice(0, 8)}`,
        `Multihelm on ${this.host.serverName()}`
      )
      this.applyAccessResult(peer, result)
      if (peer.state === 'paired') {
        await this.helloLocked(peer)
      }
      this.store.savePeers(this.peers)
      const info = this.peerInfo().find((p) => p.url === url)
      if (!info) {
        throw new Error('peer vanished')
      }
      if (peer.state === 'paired') {
        this.changedSoon()
      }
      return info
    })
  }

  unpair(url: string): Promise<boolean> {
    return this.serialize(() => {
      const before = this.peers.length
      this.peers = this.peers.filter((p) => p.url !== url)
      this.masterSeen.delete(url)
      this.store.savePeers(this.peers)
      this.announceRole()
      return Promise.resolve(this.peers.length !== before)
    })
  }

  private applyAccessResult(peer: Peer, result: AccessRequestResult): void {
    switch (result.kind) {
      case 'no-security':
        peer.token = ''
        peer.state = 'paired'
        delete peer.requestHref
        break
      case 'approved':
        peer.token = result.token
        peer.state = 'paired'
        delete peer.requestHref
        delete peer.lastError
        break
      case 'pending':
        peer.requestHref = result.href
        peer.state = 'waiting-approval'
        break
      case 'denied':
        peer.state = 'needs-pairing'
        delete peer.requestHref
        peer.lastError = 'the access request was denied'
        break
      case 'error':
        peer.state = 'needs-pairing'
        peer.lastError = result.message
        break
    }
  }

  private async pollPairingLocked(peer: Peer): Promise<void> {
    if (peer.state !== 'waiting-approval' || !peer.requestHref) {
      return
    }
    try {
      this.applyAccessResult(peer, await pollAccess(peer.url, peer.requestHref))
      // applyAccessResult changed the state; read it afresh.
      if ((peer.state as Peer['state']) === 'paired') {
        await this.helloLocked(peer)
      }
    } catch (error) {
      peer.lastError = errorText(error)
    }
  }

  private async helloLocked(peer: Peer): Promise<void> {
    try {
      const hello = await fetchHello(peer.url, peer.token)
      if (hello.serverId === this.serverId) {
        peer.state = 'needs-pairing'
        peer.lastError = 'this is this server itself'
        return
      }
      peer.id = hello.serverId
      peer.name = hello.name
      peer.lastSeen = Date.now()
      if (hello.master) {
        this.masterSeen.set(peer.url, peer.lastSeen)
      } else {
        this.masterSeen.delete(peer.url)
      }
    } catch (error) {
      peer.lastError =
        error instanceof PeerHttpError && error.status === 404
          ? 'Multihelm is not running there'
          : errorText(error)
    }
  }
}
