/**
 * One dataset's library: the entries this server holds, with the version
 * every server agrees on without a master.
 *
 * Each entry carries a counter and the server that last changed it. A local
 * change takes the counter one past the entry's current one, so a change
 * made after seeing a peer's version wins over it. Two servers changing the
 * same entry without seeing each other's change tie on the counter; the
 * higher server id wins, so every server picks the same one without
 * comparing clocks.
 */

import crypto from 'node:crypto'

export interface Version {
  counter: number
  /** The server id that made this version. */
  origin: string
}

/** A file of an entry as peers see it. */
export interface FileInfo {
  name: string
  size: number
  sha256: string
}

/** A file of an entry as this server holds it. */
export interface LocalFile {
  name: string
  size: number
  mtimeMs: number
  sha256?: string
}

export interface Entry {
  key: string
  meta: unknown
  files: LocalFile[]
  /** Of `meta` and each file's name, size and time on this server; notices local changes. */
  fingerprint: string
  version: Version
  /** Set when the entry was deleted; it is kept as a tombstone. */
  deletedAt?: number
  /**
   * A peer's entry the dataset did not take (it lists nothing under the
   * key afterwards). Not a deletion: no tombstone is made for it.
   */
  declined?: boolean
  /** Local change sequence, for `manifest?since=`. */
  seq: number
}

export interface RemoteEntry {
  key: string
  meta: unknown
  files: FileInfo[]
  version: Version
  deletedAt?: number
}

export interface Library {
  seq: number
  entries: Record<string, Entry>
}

export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** A file written less than this long ago may still be growing, so its entry waits. */
export const SETTLE_MS = 30_000

const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/

/** Positive when `a` wins over `b`, negative when `b` wins, 0 when equal. */
export function compareVersions(a: Version, b: Version): number {
  if (a.counter !== b.counter) {
    return a.counter - b.counter
  }
  if (a.origin === b.origin) {
    return 0
  }
  return a.origin > b.origin ? 1 : -1
}

export function emptyLibrary(): Library {
  return { seq: 0, entries: {} }
}

export function fingerprint(meta: unknown, files: readonly LocalFile[]): string {
  const canonical = JSON.stringify({
    meta: meta ?? null,
    files: [...files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => [f.name, f.size, f.mtimeMs])
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

export function isValidFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.includes('..')
}

/** The shape checks every entry a peer sends must pass before anything else looks at it. */
export function isWellFormedRemote(raw: unknown): raw is RemoteEntry {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }
  const entry = raw as Partial<RemoteEntry>
  if (
    typeof entry.key !== 'string' ||
    entry.key.length === 0 ||
    entry.key.length > 512 ||
    entry.key.includes('\0') ||
    typeof entry.version?.counter !== 'number' ||
    !Number.isInteger(entry.version.counter) ||
    entry.version.counter < 1 ||
    typeof entry.version.origin !== 'string' ||
    !Array.isArray(entry.files)
  ) {
    return false
  }
  if (entry.deletedAt !== undefined && typeof entry.deletedAt !== 'number') {
    return false
  }
  const names = new Set<string>()
  for (const file of entry.files as unknown[]) {
    const f = file as Partial<FileInfo>
    if (
      typeof f.name !== 'string' ||
      !isValidFileName(f.name) ||
      names.has(f.name) ||
      typeof f.size !== 'number' ||
      !Number.isInteger(f.size) ||
      f.size < 0 ||
      typeof f.sha256 !== 'string' ||
      !SHA256.test(f.sha256)
    ) {
      return false
    }
    names.add(f.name)
  }
  return true
}

/** One entry as the dataset lists it now. */
export interface ListedEntry {
  key: string
  meta: unknown
  files: { name: string; size: number; mtimeMs: number }[]
}

export interface ScanResult {
  /** Keys whose entry changed and needs its files hashed. */
  changed: string[]
}

/**
 * Bring the library up to date with what the dataset lists: new or changed
 * entries get a new local version (once their files have settled), entries
 * gone become tombstones, tombstones past retention are dropped.
 */
export function applyListing(
  library: Library,
  listed: readonly ListedEntry[],
  serverId: string,
  now: number
): ScanResult {
  const changed: string[] = []
  const seen = new Set<string>()
  for (const item of listed) {
    seen.add(item.key)
    const prev = library.entries[item.key]
    const files: LocalFile[] = item.files.map((f) => ({
      name: f.name,
      size: f.size,
      mtimeMs: f.mtimeMs
    }))
    const print = fingerprint(item.meta, files)
    if (prev && prev.deletedAt === undefined && prev.fingerprint === print) {
      if (prev.declined) {
        delete prev.declined
      }
      continue
    }
    // A change of meta alone goes out at once; only a file may still be growing.
    const changedFiles = files.filter(
      (f) =>
        !prev?.files.some((o) => o.name === f.name && o.size === f.size && o.mtimeMs === f.mtimeMs)
    )
    if (changedFiles.some((f) => now - f.mtimeMs < SETTLE_MS)) {
      continue
    }
    // Keep the hashes of files that did not change.
    for (const file of files) {
      const old = prev?.files.find(
        (f) => f.name === file.name && f.size === file.size && f.mtimeMs === file.mtimeMs
      )
      if (old?.sha256 !== undefined) {
        file.sha256 = old.sha256
      }
    }
    library.seq++
    library.entries[item.key] = {
      key: item.key,
      meta: item.meta,
      files,
      fingerprint: print,
      version: { counter: (prev?.version.counter ?? 0) + 1, origin: serverId },
      seq: library.seq
    }
    changed.push(item.key)
  }
  for (const entry of Object.values(library.entries)) {
    if (seen.has(entry.key) || entry.declined) {
      continue
    }
    if (entry.deletedAt === undefined) {
      library.seq++
      library.entries[entry.key] = {
        key: entry.key,
        meta: null,
        files: [],
        fingerprint: '',
        version: { counter: entry.version.counter + 1, origin: serverId },
        deletedAt: now,
        seq: library.seq
      }
    } else if (now - entry.deletedAt > TOMBSTONE_RETENTION_MS) {
      Reflect.deleteProperty(library.entries, entry.key)
    }
  }
  return { changed }
}

function isOfferable(entry: Entry): boolean {
  return entry.deletedAt !== undefined || entry.files.every((f) => f.sha256 !== undefined)
}

export function toRemote(entry: Entry): RemoteEntry {
  const remote: RemoteEntry = {
    key: entry.key,
    meta: entry.meta,
    files: entry.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 ?? '' })),
    version: entry.version
  }
  if (entry.deletedAt !== undefined) {
    remote.deletedAt = entry.deletedAt
  }
  return remote
}

/** Entries changed after `since`. One not hashed yet stops the page, so the cursor never skips it. */
export function manifestSince(
  library: Library,
  since: number
): { cursor: number; entries: RemoteEntry[] } {
  let cursor = since
  const entries: RemoteEntry[] = []
  for (const entry of Object.values(library.entries).sort((a, b) => a.seq - b.seq)) {
    if (entry.seq <= since || entry.declined) {
      if (entry.seq > cursor) {
        cursor = entry.seq
      }
      continue
    }
    if (!isOfferable(entry)) {
      break
    }
    cursor = entry.seq
    entries.push(toRemote(entry))
  }
  return { cursor, entries }
}

/** Take over a peer's version, with what this server holds for it now (null: nothing). */
export function recordRemote(
  library: Library,
  remote: RemoteEntry,
  local: ListedEntry | null
): void {
  library.seq++
  const files: LocalFile[] = local
    ? local.files.map((f) => {
        const file: LocalFile = { name: f.name, size: f.size, mtimeMs: f.mtimeMs }
        const sha256 = remote.files.find((r) => r.name === f.name && r.size === f.size)?.sha256
        if (sha256 !== undefined) {
          file.sha256 = sha256
        }
        return file
      })
    : []
  const entry: Entry = {
    key: remote.key,
    meta: local ? local.meta : remote.meta,
    files,
    fingerprint: local ? fingerprint(local.meta, files) : '',
    version: remote.version,
    seq: library.seq
  }
  if (remote.deletedAt !== undefined) {
    entry.deletedAt = remote.deletedAt
  } else if (!local) {
    entry.declined = true
  }
  library.entries[remote.key] = entry
}
