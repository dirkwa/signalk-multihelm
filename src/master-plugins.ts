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
const PLUGIN_ID = /^[\w.@-]{1,100}$/
const MAX_PLUGINS = 100

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

/** The list, kept in a file of its own under `dir`, since a dataset entry is made of files. */
export class MasterPluginList {
  private readonly file: string
  private current: string[]
  /** Writes one after the other, so two cannot share the temporary file or publish out of order. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    dir: string,
    private readonly onChange: () => void
  ) {
    this.file = path.join(dir, FILE)
    this.current = this.read()
  }

  ids(): string[] {
    return this.current
  }

  set(ids: string[]): Promise<void> {
    return this.queued(() => this.write(ids))
  }

  readonly dataset: DatasetDefinition = {
    id: SETTINGS_DATASET,
    isValidKey: (key) => key === MASTER_PLUGINS_KEY,

    list: async (): Promise<DatasetEntry[]> => {
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(this.file)
      } catch {
        return []
      }
      return [
        {
          key: MASTER_PLUGINS_KEY,
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

export interface SwitchHost {
  ids: () => string[]
  /** true: run them on this server; false: stop them here; null: leave them as they are. */
  wanted: () => boolean | null
  access: OwnServerAccess
  /** This server, over loopback: `http(s)://127.0.0.1:<port>`. */
  ownUrl: () => string
  /** Multihelm itself, which is never switched. */
  selfId: string
  debug: (msg: string) => void
  error: (msg: string) => void
}

function pluginUrl(base: string, id: string, rest = ''): string {
  return `${base}/plugins/${encodeURIComponent(id)}${rest}`
}

/** Switches the listed plugins on this server to what its role wants; one run at a time. */
export class MasterOnlyPlugins {
  private running = false
  private again = false

  constructor(private readonly host: SwitchHost) {}

  apply(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    void this.applyOnce()
      .catch((error: unknown) => {
        this.host.error(
          `Multihelm: switching the plugins that run on the master: ${errorText(error)}`
        )
      })
      .finally(() => {
        this.running = false
        if (this.again) {
          this.again = false
          this.apply()
        }
      })
  }

  async applyOnce(): Promise<void> {
    const wanted = this.host.wanted()
    const ids = this.host.ids().filter((id) => id !== this.host.selfId)
    if (wanted === null || ids.length === 0) {
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
        if ((state as { enabled?: unknown } | null)?.enabled === wanted) {
          continue
        }
        const options = await callServer('GET', pluginUrl(base, id, '/config'), token)
        // The role may have moved during the requests; the next pass follows the new one.
        if (this.host.wanted() !== wanted) {
          return
        }
        const body =
          typeof options === 'object' && options !== null && !Array.isArray(options)
            ? { ...options, enabled: wanted }
            : { enabled: wanted }
        await callServer('POST', pluginUrl(base, id, '/config'), token, body)
        this.host.debug(
          `Multihelm: ${wanted ? 'started' : 'stopped'} ${id}, which runs on the master only`
        )
      } catch (error) {
        if (error instanceof PeerHttpError && error.status === 404) {
          this.host.debug(`Multihelm: ${id}, set to run on the master only, is not installed here`)
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
