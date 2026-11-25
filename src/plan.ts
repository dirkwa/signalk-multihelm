/**
 * The boat plan: each server's Multihelm settings, kept in step as a dataset
 * with no master, so the console on any server shows and changes those of
 * every server. Each server applies only its own entry, to its own plugin
 * settings. Whether a server is set to be the master stays in its own
 * settings, so a boat whose plan went wrong still has a master.
 */

import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js'
import { ConfigSchema } from './config.js'

export const PLAN_DATASET = 'signalk-multihelm/plan'
const FILE = 'plan.json'
const APPLIED_FILE = 'applied.json'
const KEY = /^server-([\w-]{1,64})$/
export const MAX_LOCATION_LENGTH = 60

export const PlanSettingsSchema = Type.Required(Type.Omit(ConfigSchema, ['master']))
export type PlanSettings = Static<typeof PlanSettingsSchema>

export const ServerPlanSchema = Type.Object({
  /** Where the server is on board, such as "Flybridge port"; empty when not given. */
  location: Type.String({ maxLength: MAX_LOCATION_LENGTH }),
  settings: PlanSettingsSchema
})
export type ServerPlan = Static<typeof ServerPlanSchema>

const PlanFileSchema = Type.Record(Type.String(), ServerPlanSchema)

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** A server's stored settings as the plan holds them, with the defaults filled in. */
export function planSettings(config: object): PlanSettings {
  const c = config as Partial<Record<keyof PlanSettings, unknown>>
  const on = (value: unknown): boolean => value !== false
  return {
    takeOver:
      typeof c.takeOver === 'number' && Number.isInteger(c.takeOver) && c.takeOver > 0
        ? Math.min(c.takeOver, 9)
        : 0,
    syncResources: on(c.syncResources),
    followVessel: on(c.followVessel),
    followMetadata: on(c.followMetadata),
    followSourcePriorities: on(c.followSourcePriorities),
    historyFromMaster: on(c.historyFromMaster),
    autopilotFromMaster: on(c.autopilotFromMaster),
    courseFromMaster: on(c.courseFromMaster),
    alarmsFromMaster: on(c.alarmsFromMaster),
    sharePaths: strings(c.sharePaths),
    shareConnections: strings(c.shareConnections),
    takeSharedData: on(c.takeSharedData)
  }
}

export function isServerPlan(value: unknown): value is ServerPlan {
  return Value.Check(ServerPlanSchema, value)
}

export function planKey(serverId: string): string {
  return `server-${serverId}`
}

/**
 * What a server does with its own entry when it starts. Its settings were
 * changed in the plugin settings when they differ from those it last
 * applied or published: they then go to the plan. Otherwise a plan entry
 * that differs, changed on another server, is applied here.
 */
export function onStart(
  settings: PlanSettings,
  applied: PlanSettings | null,
  planned: PlanSettings | null
): 'publish' | 'apply' | 'none' {
  if (planned === null || applied === null || !isDeepStrictEqual(settings, applied)) {
    return 'publish'
  }
  return isDeepStrictEqual(planned, settings) ? 'none' : 'apply'
}

export interface BoatPlanHost {
  serverId: string
  dir: string
  /** A peer's entry changed this server's settings. */
  ownChanged: (settings: PlanSettings) => void
  /** The plan changed here, to be offered to the peers. */
  changed: () => void
}

/** What the routes reach of the plan. */
export interface PlanControl {
  plan: BoatPlan
  /** Applies settings planned for this server, from the console here. */
  applyOwn: (settings: PlanSettings) => void
}

export class BoatPlan {
  private readonly file: string
  private readonly appliedFile: string
  private plan: Record<string, ServerPlan>
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly host: BoatPlanHost) {
    this.file = path.join(host.dir, FILE)
    this.appliedFile = path.join(host.dir, APPLIED_FILE)
    this.plan = this.read()
  }

  servers(): Record<string, ServerPlan> {
    return this.plan
  }

  get(serverId: string): ServerPlan | null {
    return this.plan[serverId] ?? null
  }

  applied(): PlanSettings | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.appliedFile, 'utf8'))
      return Value.Check(PlanSettingsSchema, raw) ? raw : null
    } catch {
      return null
    }
  }

  /** This server's settings as it now runs with them. */
  markApplied(settings: PlanSettings): void {
    fs.mkdirSync(this.host.dir, { recursive: true })
    fs.writeFileSync(this.appliedFile, JSON.stringify(settings))
  }

  /** A change made on this server; applying it to this server's own settings is the caller's. */
  set(serverId: string, plan: ServerPlan): Promise<void> {
    return this.queued(async () => {
      await this.write({ ...this.plan, [serverId]: plan })
      this.host.changed()
    })
  }

  readonly dataset: DatasetDefinition = {
    id: PLAN_DATASET,
    isValidKey: (key) => KEY.test(key),

    list: (): Promise<DatasetEntry[]> =>
      Promise.resolve(
        Object.entries(this.plan).map(([serverId, plan]) => ({
          key: planKey(serverId),
          meta: plan,
          files: []
        }))
      ),

    apply: (entry: IncomingEntry): Promise<void> => {
      const serverId = KEY.exec(entry.key)?.[1]
      if (serverId === undefined || !isServerPlan(entry.meta) || entry.files.length > 0) {
        return Promise.reject(new Error(`not a server's plan: ${entry.key}`))
      }
      const plan = entry.meta
      return this.queued(async () => {
        const before = this.plan[serverId]
        await this.write({ ...this.plan, [serverId]: plan })
        if (
          serverId === this.host.serverId &&
          !isDeepStrictEqual(before?.settings, plan.settings)
        ) {
          this.host.ownChanged(plan.settings)
        }
      })
    },

    remove: (key: string): Promise<boolean> => {
      const serverId = KEY.exec(key)?.[1]
      if (serverId === undefined || serverId === this.host.serverId) {
        // This server keeps its own entry, and offers it back.
        return Promise.resolve(false)
      }
      return this.queued(async () => {
        const rest = { ...this.plan }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete rest[serverId]
        await this.write(rest)
      }).then(() => true)
    }
  }

  private queued(work: () => Promise<void>): Promise<void> {
    const result = this.writes.then(work)
    this.writes = result.catch(() => undefined)
    return result
  }

  private read(): Record<string, ServerPlan> {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return Value.Check(PlanFileSchema, raw) ? raw : {}
    } catch {
      return {}
    }
  }

  private async write(plan: Record<string, ServerPlan>): Promise<void> {
    await fs.promises.mkdir(this.host.dir, { recursive: true })
    const tmp = `${this.file}.part`
    await fs.promises.writeFile(tmp, JSON.stringify(plan))
    await fs.promises.rename(tmp, this.file)
    this.plan = plan
  }
}
