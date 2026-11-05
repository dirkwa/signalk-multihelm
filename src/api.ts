/**
 * What other plugins use. Multihelm publishes it as the PropertyValue
 * `multihelm`: `{ apiVersion: 1, ...MultihelmApi }` from its start, and
 * `{ apiVersion: 1 }` without the methods after its stop. A plugin acts on
 * the last value, registers its datasets again whenever the methods
 * reappear, and unregisters them in its own `stop()`.
 *
 * Compatibility: `apiVersion` changes only with a change users must know
 * about; everything else grows by addition.
 */

export const API_VERSION = 1
export const PROPERTY_NAME = 'multihelm'

/** One file of an entry on this server. */
export interface DatasetFile {
  /** Unique within the entry: letters, digits, `.`, `_`, `-`, not starting with `.`. */
  name: string
  /** Absolute path on this server. */
  path: string
  size: number
  mtimeMs: number
}

export interface DatasetEntry {
  /** Unique within the dataset, e.g. a path relative to the dataset's folder. */
  key: string
  /** Small JSON value replicated with the entry, e.g. `{ enabled: true }`. */
  meta: unknown
  files: DatasetFile[]
}

/** A peer's entry to take over; every file has arrived whole and matches its hash. */
export interface IncomingEntry {
  key: string
  meta: unknown
  files: {
    name: string
    /**
     * Absolute path of the verified file: in Multihelm's work folder for a
     * file that changed (move it into place), or the dataset's own copy for
     * one that did not.
     */
    path: string
    size: number
    sha256: string
    /** True when `path` is the dataset's own unchanged file. */
    unchanged: boolean
  }[]
}

export interface DatasetDefinition {
  /** Unique across plugins: `<plugin id>/<name>`. */
  id: string
  /** What this server holds now. Called once per round, and after each `apply`. */
  list: () => Promise<DatasetEntry[]>
  /** Take over a peer's entry. Throwing leaves it to be tried again next round. */
  apply: (entry: IncomingEntry) => Promise<void>
  /**
   * A peer deleted the entry. Return false to keep it here: it is then
   * offered back to the peers as a change of this server's.
   */
  remove: (key: string) => Promise<boolean>
  /** Checked on every key a peer sends, before `apply` or `remove` sees it. */
  isValidKey?: (key: string) => boolean
}

export interface DatasetHandle {
  /** Something changed here: look sooner than the next round. */
  changed: () => void
  unregister: () => void
}

export interface PeerInfo {
  id: string
  name: string
  url: string
  state: 'waiting-approval' | 'paired' | 'needs-pairing'
  lastSeen?: number
  lastSync?: number
  lastError?: string
}

export interface MultihelmApi {
  registerDataset: (definition: DatasetDefinition) => DatasetHandle
  peers: () => PeerInfo[]
  /** This server's id among the boat's servers. */
  serverId: () => string
}

export type MultihelmProperty = { apiVersion: typeof API_VERSION } & Partial<MultihelmApi>
