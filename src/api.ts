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
  /** The peer is set to be the boat's master, and answered within the last rounds. */
  master?: boolean
}

/**
 * `master`: this server is the boat's master. `member`: another server is,
 * or none is. The master is set by hand on one server; when several are set,
 * the one with the smallest server id is the master.
 */
export type Role = 'master' | 'member'

export interface MasterRouteHandle {
  unregister: () => void
}

export interface MasterResponse {
  status: number
  /** The response headers that matter to a reader: type, length, caching. */
  headers: Record<string, string>
  body: Buffer
}

export interface MultihelmApi {
  registerDataset: (definition: DatasetDefinition) => DatasetHandle
  peers: () => PeerInfo[]
  /** This server's id among the boat's servers. */
  serverId: () => string
  role: () => Role
  /** The peer that is the master; null when this server is the master or there is none. */
  master: () => PeerInfo | null
  /**
   * Calls `cb` whenever this server's role or the master changes; returns a
   * function that stops the calls. A master-mode plugin starts its work when
   * its server becomes the master and stops it when it no longer is.
   */
  onRoleChanged: (cb: (role: Role, master: PeerInfo | null) => void) => () => void
  /**
   * Lets this server serve the master's GET requests under `prefix` (a path
   * ending in `/`, e.g. `/signalk/v1/api/resources/charts/`) at
   * `masterPath(...)`, to anyone who may read on this server. Admin and
   * access routes are refused.
   */
  registerMasterRoute: (prefix: string) => MasterRouteHandle
  /** Where this server serves the master's `path`, e.g. for a tile URL handed to a browser. */
  masterPath: (path: string) => string
  /** Reads the master's `path`, under a registered prefix; rejects when there is no master. */
  fetchMaster: (path: string) => Promise<MasterResponse>
}

export type MultihelmProperty = { apiVersion: typeof API_VERSION } & Partial<MultihelmApi>
