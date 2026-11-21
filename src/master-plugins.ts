/**
 * Plugins that run on the boat's master only, such as an autopilot provider
 * that must not send from more than one server. The list is the same on
 * every server, kept in step as a dataset with no master, so a server that
 * becomes the master already knows it. Each server switches those plugins
 * on or off through its own REST API, as the admin UI does, so the state
 * survives a restart and the admin UI shows it.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js'
import type { OwnServerAccess } from './own-access.js'
import { PeerHttpError, callServer } from './peer-client.js'

export const SETTINGS_DATASET = 'signalk-multihelm/settings'
export const MASTER_PLUGINS_KEY = 'master-plugins'
const FILE = 'plugins.json'
const PLUGIN_ID = /^[\w@-][\w.@-]{0,99}$/
const MAX_PLUGINS = 100

export function isPluginId(id: string): boolean {
  return PLUGIN_ID.test(id)
}

export function parsePluginIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PLUGINS) {
    return null
  }
  const ids: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
      return null
    }
    ids.push(id)
  }
  return [...new Set(ids)].sort()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A list of plugins the same on every server, kept in a file of its own under `dir`, since a dataset entry is made of files. */
export class PluginList {
  private readonly file: string
  private current: string[]
  /** Writes one after the other, so two cannot share the temporary file or publish out of order. */
  private writes: Promise<unknown> = Promise.resolve()
  readonly dataset: DatasetDefinition

  constructor(
    dir: string,
    private readonly onChange: () => void,
    private readonly datasetId = SETTINGS_DATASET,
    private readonly key = MASTER_PLUGINS_KEY
  ) {
    this.file = path.join(dir, FILE)
    this.current = this.read()
    this.dataset = this.define()
  }

  ids(): string[] {
    return this.current
  }

  set(ids: string[]): Promise<void> {
    return this.queued(() => this.write(ids))
  }

  private define(): DatasetDefinition {
    return {
      id: this.datasetId,
      isValidKey: (key) => key === this.key,

      list: async (): Promise<DatasetEntry[]> => {
        let stat: fs.Stats
        try {
          stat = await fs.promises.stat(this.file)
        } catch {
          return []
        }
        return [
          {
            key: this.key,
            meta: null,
            files: [{ name: FILE, path: this.file, size: stat.size, mtimeMs: stat.mtimeMs }]
          }
        ]
      },

      apply: async (entry: IncomingEntry): Promise<void> => {
        const file = entry.files.find((f) => f.name === FILE)
        if (!file || entry.files.length !== 1) {
          throw new Error(`the plugin list has one file, ${String(entry.files.length)} came`)
        }
        const ids = parsePluginIds(JSON.parse(await fs.promises.readFile(file.path, 'utf8')))
        if (!ids) {
          throw new Error('not a list of plugin ids')
        }
        await this.queued(() => this.write(ids))
      },

      remove: async (): Promise<boolean> => {
        await this.queued(async () => {
          await fs.promises.rm(this.file, { force: true })
          this.changed([])
        })
        return true
      }
    }
  }

  private queued(work: () => Promise<void>): Promise<void> {
    const result = this.writes.then(work)
    this.writes = result.catch(() => undefined)
    return result
  }

  private read(): string[] {
    try {
      return parsePluginIds(JSON.parse(fs.readFileSync(this.file, 'utf8'))) ?? []
    } catch {
      return []
    }
  }

  private async write(ids: string[]): Promise<void> {
    const sorted = parsePluginIds(ids)
    if (!sorted) {
      throw new Error('not a list of plugin ids')
    }
    const text = JSON.stringify(sorted)
    let had: string | null = null
    try {
      had = await fs.promises.readFile(this.file, 'utf8')
    } catch {
      // Not written yet.
    }
    if (had !== text) {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.part`
      await fs.promises.writeFile(tmp, text)
      await fs.promises.rename(tmp, this.file)
    }
    this.changed(sorted)
  }

  private changed(ids: string[]): void {
    const before = JSON.stringify(this.current)
    this.current = ids
    if (JSON.stringify(ids) !== before) {
      this.onChange()
    }
  }
}

/** What `masterPluginsWanted` reads of the election. */
export interface Election {
  roleKnown(): boolean
  role(): 'master' | 'member'
  masterElsewhere(): boolean
  hasMajority(): boolean
  electedWithout(): boolean
  otherActs(): boolean
}

/**
 * Nothing is switched before the role is known, nor on a server with no master to defer to,
 * unless it reaches too few of the boat's servers to know there is none elsewhere, should be
 * the master but may not be it yet, or sees another server still acting as it.
 */
export function masterPluginsWanted(e: Election): boolean | null {
  if (!e.roleKnown()) {
    return null
  }
  if (e.role() === 'master') {
    return true
  }
  return e.masterElsewhere() || !e.hasMajority() || e.electedWithout() || e.otherActs()
    ? false
    : null
}

export interface SwitchHost {
  ids: () => string[]
  /** true: run them on this server; false: stop them here; null: leave them as they are. */
  wanted: () => boolean | null
  access: OwnServerAccess
  /** This server, over loopback: `http(s)://127.0.0.1:<port>`. */
  ownUrl: () => string
  /** Multihelm itself, which is never switched. */
  selfId: string
  /** `runsHere()` changed. */
  runningChanged?: () => void
  /**
   * Where the plugins seen running here are kept, so after a restart those
   * not looked at again yet still count as running.
   */
  runningFile?: string
  debug: (msg: string) => void
  error: (msg: string) => void
}

const configWrites = new Map<string, Promise<unknown>>()

/** One read-modify-write of a plugin's settings at a time, so no writer restores what another just changed. */
export function exclusivePluginConfig<T>(id: string, work: () => Promise<T>): Promise<T> {
  const result = (configWrites.get(id) ?? Promise.resolve()).then(work)
  const settled = result.catch(() => undefined)
  configWrites.set(id, settled)
  void settled.then(() => {
    if (configWrites.get(id) === settled) {
      configWrites.delete(id)
    }
  })
  return result
}

function pluginUrl(base: string, id: string, rest = ''): string {
  return `${base}/plugins/${encodeURIComponent(id)}${rest}`
}

/** Switches the listed plugins on this server to what its role wants; one run at a time. */
export class MasterOnlyPlugins {
  private busy = false
  private again = false
  /** Listed plugins this server found running or started, until it saw them stopped. */
  private readonly running = new Set<string>()
  /** Without a usable record from before, a plugin not looked at since the start may run. */
  private readonly unknown: boolean
  private readonly looked = new Set<string>()

  constructor(private readonly host: SwitchHost) {
    const kept = this.loadRunning()
    this.unknown = kept === null
    for (const id of kept ?? []) {
      this.running.add(id)
    }
  }

  /** null: no usable record, so what runs here is unknown. */
  private loadRunning(): string[] | null {
    if (this.host.runningFile === undefined) {
      return []
    }
    try {
      const kept: unknown = JSON.parse(fs.readFileSync(this.host.runningFile, 'utf-8'))
      return Array.isArray(kept) && kept.every((id) => typeof id === 'string' && PLUGIN_ID.test(id))
        ? (kept as string[])
        : null
    } catch {
      return null
    }
  }

  /**
   * Whether the record is safe to rely on after a restart: written, or
   * removed when it could not be, so the next start treats it as unknown.
   */
  private saveRunning(): boolean {
    const file = this.host.runningFile
    if (file === undefined) {
      return true
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify([...this.running]))
      fs.renameSync(`${file}.tmp`, file)
      return true
    } catch (error) {
      this.host.error(`Multihelm: cannot keep which plugins run here: ${errorText(error)}`)
    }
    try {
      fs.rmSync(file, { force: true })
      return true
    } catch (error) {
      this.host.error(`Multihelm: cannot remove ${file}: ${errorText(error)}`)
      return false
    }
  }

  /**
   * Whether a plugin that runs on the master only may still run here. A stop
   * that failed keeps it so, and is tried again on the next pass: two servers
   * must never run them at once.
   */
  runsHere(): boolean {
    return this.host
      .ids()
      .some(
        (id) =>
          id !== this.host.selfId &&
          (this.running.has(id) || (this.unknown && !this.looked.has(id)))
      )
  }

  /** Returns whether the record could be kept; a plugin is started only then. */
  private mark(id: string, running: boolean): boolean {
    const before = this.runsHere()
    const changed = this.running.has(id) !== running || !this.looked.has(id)
    this.looked.add(id)
    if (running) {
      this.running.add(id)
    } else {
      this.running.delete(id)
    }
    const kept = changed ? this.saveRunning() : true
    if (before !== this.runsHere()) {
      this.host.runningChanged?.()
    }
    return kept
  }

  apply(): void {
    if (this.busy) {
      this.again = true
      return
    }
    this.busy = true
    void this.applyOnce()
      .catch((error: unknown) => {
        this.host.error(
          `Multihelm: switching the plugins that run on the master: ${errorText(error)}`
        )
      })
      .finally(() => {
        this.busy = false
        if (this.again) {
          this.again = false
          this.apply()
        }
      })
  }

  async applyOnce(): Promise<void> {
    const wanted = this.host.wanted()
    const ids = this.host.ids().filter((id) => id !== this.host.selfId)
    if (ids.length === 0) {
      return
    }
    const token = await this.host.access.token()
    if (token === null) {
      return
    }
    const base = this.host.ownUrl()
    for (const id of ids) {
      try {
        const state = await callServer('GET', pluginUrl(base, id), token)
        const enabled = (state as { enabled?: unknown } | null)?.enabled === true
        this.mark(id, enabled)
        // Looked at even while the role does not say, so `runsHere()` is never a guess.
        if (wanted === null || enabled === wanted) {
          continue
        }
        const roleMoved = await exclusivePluginConfig(id, async () => {
          const options = await callServer('GET', pluginUrl(base, id, '/config'), token)
          // The role or the list may have moved during the requests; the next pass follows them.
          if (this.host.wanted() !== wanted) {
            return true
          }
          if (!this.host.ids().includes(id)) {
            return false
          }
          const body =
            typeof options === 'object' && options !== null && !Array.isArray(options)
              ? { ...options, enabled: wanted }
              : { enabled: wanted }
          if (wanted && !this.mark(id, true)) {
            this.host.error(`Multihelm: not starting ${id}: cannot keep that it runs here`)
            return false
          }
          await callServer('POST', pluginUrl(base, id, '/config'), token, body)
          this.mark(id, wanted)
          this.host.debug(
            `Multihelm: ${wanted ? 'started' : 'stopped'} ${id}, which runs on the master only`
          )
          return false
        })
        if (roleMoved) {
          return
        }
      } catch (error) {
        if (error instanceof PeerHttpError && error.status === 404) {
          this.host.debug(`Multihelm: ${id}, set to run on the master only, is not installed here`)
          this.mark(id, false)
          continue
        }
        if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
          this.host.access.revoked()
          this.host.error(`Multihelm: this server refused its own admin token: ${errorText(error)}`)
          return
        }
        this.host.error(
          `Multihelm: cannot ${wanted ? 'start' : 'stop'} ${id}, which runs on the master only: ${errorText(error)}`
        )
      }
    }
  }
}
