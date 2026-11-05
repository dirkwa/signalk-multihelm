import { describe, expect, it } from 'vitest'

import {
  applyListing,
  compareVersions,
  emptyLibrary,
  isWellFormedRemote,
  manifestSince,
  recordRemote,
  SETTLE_MS,
  TOMBSTONE_RETENTION_MS,
  type ListedEntry,
  type RemoteEntry
} from '../src/library.js'

const NOW = 100 * SETTLE_MS
const HASH = 'a'.repeat(64)

function listed(key: string, mtimeMs = 0, meta: unknown = { enabled: true }): ListedEntry {
  return { key, meta, files: [{ name: 'data', size: 4, mtimeMs }] }
}

function remote(overrides: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    key: 'k',
    meta: null,
    files: [{ name: 'data', size: 4, sha256: HASH }],
    version: { counter: 1, origin: 'peer' },
    ...overrides
  }
}

describe('versions', () => {
  it('order by counter, then by origin', () => {
    expect(
      compareVersions({ counter: 2, origin: 'a' }, { counter: 1, origin: 'z' })
    ).toBeGreaterThan(0)
    expect(
      compareVersions({ counter: 1, origin: 'b' }, { counter: 1, origin: 'a' })
    ).toBeGreaterThan(0)
    expect(compareVersions({ counter: 1, origin: 'a' }, { counter: 1, origin: 'b' })).toBeLessThan(
      0
    )
    expect(compareVersions({ counter: 3, origin: 'a' }, { counter: 3, origin: 'a' })).toBe(0)
  })
})

describe('applyListing', () => {
  it('versions new and changed entries and leaves unchanged ones alone', () => {
    const lib = emptyLibrary()
    expect(applyListing(lib, [listed('a')], 'me', NOW).changed).toEqual(['a'])
    expect(lib.entries.a?.version).toEqual({ counter: 1, origin: 'me' })
    expect(applyListing(lib, [listed('a')], 'me', NOW).changed).toEqual([])
    expect(applyListing(lib, [listed('a', 0, { enabled: false })], 'me', NOW).changed).toEqual([
      'a'
    ])
    expect(lib.entries.a?.version.counter).toBe(2)
  })

  it('waits for files still being written', () => {
    const lib = emptyLibrary()
    expect(applyListing(lib, [listed('a', NOW - 1000)], 'me', NOW).changed).toEqual([])
    expect(lib.entries.a).toBeUndefined()
  })

  it('makes a tombstone for a vanished entry and drops it after retention', () => {
    const lib = emptyLibrary()
    applyListing(lib, [listed('a')], 'me', NOW)
    applyListing(lib, [], 'me', NOW)
    expect(lib.entries.a?.deletedAt).toBe(NOW)
    expect(lib.entries.a?.version.counter).toBe(2)
    applyListing(lib, [], 'me', NOW + TOMBSTONE_RETENTION_MS + 1)
    expect(lib.entries.a).toBeUndefined()
  })

  it('keeps hashes of files that did not change', () => {
    const lib = emptyLibrary()
    applyListing(lib, [listed('a')], 'me', NOW)
    const file = lib.entries.a?.files[0]
    if (file) {
      file.sha256 = HASH
    }
    applyListing(lib, [listed('a', 0, { enabled: false })], 'me', NOW)
    expect(lib.entries.a?.files[0]?.sha256).toBe(HASH)
  })
})

describe('manifestSince', () => {
  it('stops at an entry not hashed yet, so the cursor never skips it', () => {
    const lib = emptyLibrary()
    applyListing(lib, [listed('a'), listed('b')], 'me', NOW)
    const a = lib.entries.a?.files[0]
    if (a) {
      a.sha256 = HASH
    }
    const first = manifestSince(lib, 0)
    expect(first.entries.map((e) => e.key)).toEqual(['a'])
    const b = lib.entries.b?.files[0]
    if (b) {
      b.sha256 = HASH
    }
    expect(manifestSince(lib, first.cursor).entries.map((e) => e.key)).toEqual(['b'])
  })

  it('does not offer entries the dataset declined', () => {
    const lib = emptyLibrary()
    recordRemote(lib, remote(), null)
    expect(lib.entries.k?.declined).toBe(true)
    expect(manifestSince(lib, 0)).toEqual({ cursor: 1, entries: [] })
    // Nor does the next listing turn it into a deletion.
    applyListing(lib, [], 'me', NOW)
    expect(lib.entries.k?.deletedAt).toBeUndefined()
  })
})

describe('isWellFormedRemote', () => {
  it('accepts a proper entry', () => {
    expect(isWellFormedRemote(remote())).toBe(true)
  })

  it.each([
    ['no key', { key: '' }],
    ['a NUL in the key', { key: 'a\0b' }],
    ['counter 0', { version: { counter: 0, origin: 'p' } }],
    ['a path as file name', { files: [{ name: '../x', size: 1, sha256: HASH }] }],
    ['a hidden file', { files: [{ name: '.x', size: 1, sha256: HASH }] }],
    ['a bad hash', { files: [{ name: 'x', size: 1, sha256: 'nope' }] }],
    ['a negative size', { files: [{ name: 'x', size: -1, sha256: HASH }] }],
    [
      'a file twice',
      {
        files: [
          { name: 'x', size: 1, sha256: HASH },
          { name: 'x', size: 1, sha256: HASH }
        ]
      }
    ]
  ])('rejects %s', (_label, overrides) => {
    expect(isWellFormedRemote(remote(overrides as Partial<RemoteEntry>))).toBe(false)
  })
})

describe('settling', () => {
  it('lets a change of meta alone through while files are new', () => {
    const lib = emptyLibrary()
    applyListing(lib, [listed('a', NOW - 1000)], 'me', NOW + SETTLE_MS)
    expect(
      applyListing(lib, [listed('a', NOW - 1000, { enabled: false })], 'me', NOW).changed
    ).toEqual(['a'])
  })
})
