/**
 * Which server is the boat's master, chosen from the console on any server
 * and kept in step as a dataset with no master of its own. Each server
 * applies the choice to its own `master` setting, which the master election
 * reads as before; a change of that setting in a server's plugin settings
 * becomes the boat's choice the same way.
 *
 * Every choice carries a term one past the one it replaced, and a server
 * says in its `hello` the term its setting follows. A server that was off
 * while the master moved comes back with its old setting and an older term,
 * so the others do not count it as the master until it has taken the
 * choice over. A server takes a peer's choice only over an older one: the
 * later term wins, and of two made at once the larger server id.
 */

import fs from 'node:fs'
import path from 'node:path'

import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'

import type { DatasetDefinition, DatasetEntry, IncomingEntry } from './api.js'

export const MASTER_DATASET = 'signalk-multihelm/master'
const KEY = 'master'
const FILE = 'master.json'
const APPLIED_FILE = 'applied.json'

export const MasterChoiceSchema = Type.Object({
  /** The server set to be the master; empty for none. */
  serverId: Type.String({ maxLength: 64, pattern: '^[\\w-]*$' }),
  term: Type.Integer({ minimum: 1 })
})
export type MasterChoice = Static<typeof MasterChoiceSchema>

/** The `master` setting a server runs with, and the term of the choice it follows; 0 for none. */
const AppliedMasterSchema = Type.Object({
  master: Type.Boolean(),
  term: Type.Integer({ minimum: 0 })
})
export type AppliedMaster = Static<typeof AppliedMasterSchema>

export function isMasterChoice(value: unknown): value is MasterChoice {
  return Value.Check(MasterChoiceSchema, value)
}

/** A server id a choice can name; '' names none. */
export function isChoosableId(value: unknown): value is string {
  return Value.Check(MasterChoiceSchema.properties.serverId, value)
}

function laterChoice(a: MasterChoice, b: MasterChoice): boolean {
  return a.term > b.term || (a.term === b.term && a.serverId > b.serverId)
}

export type MasterOnStart =
  | { action: 'publish'; choice: MasterChoice }
  | { action: 'apply'; applied: AppliedMaster }
  | { action: 'record'; applied: AppliedMaster }

/**
 * What a server does about the boat's choice when it starts. A setting that
 * differs from the one it last applied was changed in its plugin settings,
 * and goes to the boat. Otherwise the boat's choice wins over the setting,
 * also on the first start with this, so a server that was set to be the
 * master by hand follows a choice made meanwhile. Without a choice, the
 * setting stays as the user set it.
 */
export function masterOnStart(
  serverId: string,
  setting: boolean,
  applied: AppliedMaster | null,
  choice: MasterChoice | null
): MasterOnStart {
  const term = choice?.term ?? 0
  const chosen = choice !== null && choice.serverId === serverId
  if (applied !== null && applied.master !== setting) {
    if (setting !== chosen) {
      return { action: 'publish', choice: { serverId: setting ? serverId : '', term: term + 1 } }
    }
    return { action: 'record', applied: { master: setting, term } }
  }
  if (choice === null || chosen === setting) {
    return { action: 'record', applied: { master: setting, term } }
  }
  return { action: 'apply', applied: { master: chosen, term } }
}

export interface BoatMasterHost {
  dir: string
  /** Applies the boat's choice, made on a peer or here, to this server; fails when it cannot. */
  chosen: (choice: MasterChoice) => Promise<void>
  /** The choice changed here, to be offered to the peers. */
  changed: () => void
}

export class BoatMaster {
  private readonly file: string
  private readonly appliedFile: string
  private current: MasterChoice | null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly host: BoatMasterHost) {
    this.file = path.join(host.dir, FILE)
    this.appliedFile = path.join(host.dir, APPLIED_FILE)
    this.current = this.read()
  }

  choice(): MasterChoice | null {
    return this.current
  }

  /**
   * Makes `serverId` the boat's master, or none for '', and returns the
   * choice; offered to the peers only once applied here. A choice that
   * cannot be applied fails and leaves the one before it.
   */
  choose(serverId: string): Promise<MasterChoice> {
    return this.queued(async () => {
      const previous = this.current
      const choice = { serverId, term: (previous?.term ?? 0) + 1 }
      // On disk first, for the restart applying it causes.
      await this.write(choice)
      try {
        await this.host.chosen(choice)
      } catch (error) {
        await this.restore(choice, previous).catch(() => undefined)
        throw error
      }
      this.current = choice
      this.host.changed()
      return choice
    })
  }

  /** A choice made in this server's plugin settings; applying it here is the caller's. */
  publish(choice: MasterChoice): Promise<void> {
    return this.queued(async () => {
      await this.write(choice)
      this.current = choice
      this.host.changed()
    })
  }

  applied(): AppliedMaster | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.appliedFile, 'utf8'))
      return Value.Check(AppliedMasterSchema, raw) ? raw : null
    } catch {
      return null
    }
  }

  /** This server now runs with `applied`. */
  markApplied(applied: AppliedMaster): void {
    fs.mkdirSync(this.host.dir, { recursive: true })
    fs.writeFileSync(this.appliedFile, JSON.stringify(applied))
  }

  readonly dataset: DatasetDefinition = {
    id: MASTER_DATASET,
    isValidKey: (key) => key === KEY,

    list: (): Promise<DatasetEntry[]> =>
      Promise.resolve(this.current ? [{ key: KEY, meta: this.current, files: [] }] : []),

    apply: (entry: IncomingEntry): Promise<boolean> => {
      if (!isMasterChoice(entry.meta) || entry.files.length > 0) {
        return Promise.reject(new Error('not a choice of master'))
      }
      const choice = entry.meta
      return this.queued(async () => {
        const current = this.current
        if (current !== null && laterChoice(current, choice)) {
          return false
        }
        // On disk first, for the start applying it may cause; listed only once applied,
        // so a choice that failed stays the peer's and comes again next round.
        if (current?.term !== choice.term || current.serverId !== choice.serverId) {
          await this.write(choice)
        }
        await this.host.chosen(choice)
        this.current = choice
        return true
      })
    },

    // The choice is never deleted; this server offers its own back.
    remove: (): Promise<boolean> => Promise.resolve(false)
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work)
    this.writes = result.catch(() => undefined)
    return result
  }

  private read(): MasterChoice | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return isMasterChoice(raw) ? raw : null
    } catch {
      return null
    }
  }

  /** Puts `previous` back for `choice`, unless a run that replaced this one has written since. */
  private async restore(choice: MasterChoice, previous: MasterChoice | null): Promise<void> {
    const onDisk = this.read()
    if (onDisk?.term !== choice.term || onDisk.serverId !== choice.serverId) {
      return
    }
    if (previous) {
      await this.write(previous)
    } else {
      await fs.promises.rm(this.file, { force: true })
    }
  }

  private async write(choice: MasterChoice): Promise<void> {
    await fs.promises.mkdir(this.host.dir, { recursive: true })
    const tmp = `${this.file}.part`
    await fs.promises.writeFile(tmp, JSON.stringify(choice))
    await fs.promises.rename(tmp, this.file)
  }
}
