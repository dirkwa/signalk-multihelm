/**
 * Plugins whose settings are the same on every server, such as a buddy list
 * that keeps everything in its plugin settings. Each listed plugin is one
 * entry of a dataset with no master; its file is the plugin's
 * `configuration`, read and written through this server's own REST API as
 * the admin UI does. Whether the plugin runs, and its logging, stay as they
 * are on each server.
 *
 * Only the server where a plugin was added to the list offers its settings
 * at first; the others wait for them, so adding a plugin never replaces the
 * settings the user meant to share with another server's.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js'
import { exclusivePluginConfig, isPluginId } from './master-plugins.js'
import type { OwnServerAccess } from './own-access.js'
import { PeerHttpError, callServer } from './peer-client.js'

export const SHARED_PLUGINS_DATASET = 'signalk-multihelm/shared-plugins'
export const SHARED_PLUGINS_KEY = 'shared-plugins'
export const PLUGIN_CONFIG_DATASET = 'signalk-multihelm/plugin-config'
const FILE = 'configuration.json'
const SEED = 'seed'

export interface SharedConfigHost {
  /** The plugins on the list, the same on every server. */
  ids: () => string[]
  access: OwnServerAccess
  /** This server, over loopback: `http(s)://127.0.0.1:<port>`. */
  ownUrl: () => string
  /** Multihelm itself, whose settings are each server's own. */
  selfId: string
  /** Where the copies of the shared settings live. */
  dir: string
  debug: (msg: string) => void
  error: (msg: string) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pluginConfigUrl(base: string, id: string): string {
  return `${base}/plugins/${encodeURIComponent(id)}/config`
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file)
    return true
  } catch {
    return false
  }
}

export class SharedPluginConfig {
  constructor(private readonly host: SharedConfigHost) {}

  /** Plugins newly put on the list here: this server's settings for them go out to the others. */
  async seed(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (isPluginId(id) && id !== this.host.selfId) {
        await fs.promises.mkdir(this.entryDir(id), { recursive: true })
        await fs.promises.writeFile(path.join(this.entryDir(id), SEED), '')
      }
    }
  }

  readonly dataset: DatasetDefinition = {
    id: PLUGIN_CONFIG_DATASET,
    isValidKey: (key) => isPluginId(key) && key !== this.host.selfId,

    list: async (): Promise<DatasetEntry[]> => {
      const shared = this.shared()
      await this.forgetUnshared(shared)
      if (shared.length === 0) {
        return []
      }
      const token = await this.host.access.token()
      const entries: DatasetEntry[] = []
      for (const id of shared) {
        if (token !== null) {
          await this.readOwn(id, token)
        }
        const file = path.join(this.entryDir(id), FILE)
        try {
          const stat = await fs.promises.stat(file)
          entries.push({
            key: id,
            meta: null,
            files: [{ name: FILE, path: file, size: stat.size, mtimeMs: stat.mtimeMs }]
          })
        } catch {
          // Not offered by this server, nor taken from a peer yet.
        }
      }
      return entries
    },

    apply: async (entry: IncomingEntry): Promise<void> => {
      const file = entry.files.find((f) => f.name === FILE)
      if (!file || entry.files.length !== 1) {
        throw new Error(`shared settings have one file, ${String(entry.files.length)} came`)
      }
      const configuration: unknown = JSON.parse(await fs.promises.readFile(file.path, 'utf8'))
      if (!isPlainObject(configuration)) {
        throw new Error(`the shared settings of ${entry.key} are not an object`)
      }
      if (!this.shared().includes(entry.key)) {
        throw new Error(`${entry.key} is not on the list of plugins with shared settings yet`)
      }
      const token = await this.host.access.token()
      if (token === null) {
        throw new Error("this server's own access request is not approved yet")
      }
      const url = pluginConfigUrl(this.host.ownUrl(), entry.key)
      const installed = await exclusivePluginConfig(entry.key, async () => {
        let options: unknown
        try {
          options = await callServer('GET', url, token)
        } catch (error) {
          if (error instanceof PeerHttpError && error.status === 404) {
            return false
          }
          throw error
        }
        await callServer('POST', url, token, {
          ...(isPlainObject(options) ? options : {}),
          configuration
        })
        return true
      })
      if (!installed) {
        // Declined: listing nothing for it, this server does not offer settings it never used.
        this.host.debug(`Multihelm: ${entry.key}, with shared settings, is not installed here`)
        return
      }
      await this.writeCopy(entry.key, JSON.stringify(configuration))
      this.host.debug(`Multihelm: took over the shared settings of ${entry.key}`)
    },

    remove: async (key: string): Promise<boolean> => {
      // Taken off the list: the plugin keeps the settings it has here.
      await fs.promises.rm(this.entryDir(key), { recursive: true, force: true })
      return true
    }
  }

  private shared(): string[] {
    return this.host.ids().filter((id) => isPluginId(id) && id !== this.host.selfId)
  }

  private entryDir(id: string): string {
    return path.join(this.host.dir, id)
  }

  /** A change made here, or the first settings of a plugin seeded here, becomes this server's copy. */
  private async readOwn(id: string, token: string): Promise<void> {
    const dir = this.entryDir(id)
    const copy = path.join(dir, FILE)
    const seeded = await exists(path.join(dir, SEED))
    const had = await fs.promises.readFile(copy, 'utf8').catch(() => null)
    if (had === null && !seeded) {
      return
    }
    let options: unknown
    try {
      options = await callServer('GET', pluginConfigUrl(this.host.ownUrl(), id), token)
    } catch (error) {
      if (error instanceof PeerHttpError && (error.status === 401 || error.status === 403)) {
        this.host.access.revoked()
      }
      if (!(error instanceof PeerHttpError && error.status === 404)) {
        this.host.error(`Multihelm: cannot read the settings of ${id}: ${errorText(error)}`)
      }
      return
    }
    const configuration = isPlainObject(options) ? options.configuration : undefined
    const text = JSON.stringify(isPlainObject(configuration) ? configuration : {})
    if (text !== had) {
      await this.writeCopy(id, text)
    }
  }

  private async writeCopy(id: string, text: string): Promise<void> {
    const dir = this.entryDir(id)
    await fs.promises.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `${FILE}.part`)
    await fs.promises.writeFile(tmp, text)
    await fs.promises.rename(tmp, path.join(dir, FILE))
    await fs.promises.rm(path.join(dir, SEED), { force: true })
  }

  private async forgetUnshared(shared: string[]): Promise<void> {
    let names: string[]
    try {
      names = await fs.promises.readdir(this.host.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!shared.includes(name)) {
        await fs.promises.rm(path.join(this.host.dir, name), { recursive: true, force: true })
      }
    }
  }
}
