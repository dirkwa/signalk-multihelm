import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ServerAPI } from '@signalk/server-api'
import { describe, expect, it } from 'vitest'

import { PROPERTY_NAME, type MultihelmProperty } from '../src/api.js'
import createPlugin from '../src/index.js'

describe('the plugin', () => {
  it('publishes the API from start and withdraws its methods at stop', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-plugin-'))
    const emitted: MultihelmProperty[] = []
    const app = {
      getDataDirPath: () => dataDir,
      emitPropertyValue: (name: string, value: unknown) => {
        if (name === PROPERTY_NAME) {
          emitted.push(value as MultihelmProperty)
        }
      },
      setPluginStatus: () => undefined,
      debug: () => undefined,
      error: () => undefined
    } as unknown as ServerAPI
    const plugin = createPlugin(app)

    plugin.start({}, () => undefined)
    const api = emitted.at(-1)
    expect(api?.apiVersion).toBe(1)
    expect(typeof api?.registerDataset).toBe('function')
    expect(api?.serverId?.()).toMatch(/^[0-9a-f-]{36}$/)
    expect(api?.peers?.()).toEqual([])
    expect(api?.role?.()).toBe('member')
    expect(api?.master?.()).toBeNull()

    void plugin.stop()
    expect(emitted.at(-1)).toEqual({ apiVersion: 1 })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('is the master when set to be', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-plugin-'))
    let api: MultihelmProperty | undefined
    const statuses: string[] = []
    const app = {
      getDataDirPath: () => dataDir,
      emitPropertyValue: (name: string, value: unknown) => {
        if (name === PROPERTY_NAME) {
          api = value as MultihelmProperty
        }
      },
      setPluginStatus: (s: string) => {
        statuses.push(s)
      },
      debug: () => undefined,
      error: () => undefined
    } as unknown as ServerAPI
    const plugin = createPlugin(app)
    plugin.start({ master: true }, () => undefined)
    expect(api?.role?.()).toBe('master')
    expect(statuses.at(-1)).toBe("Master of the boat's servers")
    void plugin.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})
