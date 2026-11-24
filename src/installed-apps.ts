/**
 * The plugins and webapps installed on each server, so the settings can show
 * what the other servers of the boat have and this one lacks: a fresh
 * install knows none of the apps set up elsewhere. Only package names,
 * versions and whether a plugin is on travel between servers.
 */

import { callPeer, callServer, ROUTE_PREFIX, type PeerAddress } from './peer-client.js'

export const INSTALLED_ROUTE = '/installed'
/** A server's list is read again at most this often. */
const LIST_MAX_AGE_MS = 60_000

export interface InstalledApp {
  /** The npm package name. */
  name: string
  version: string
  /** The name the user knows it by. */
  title: string
  plugin: boolean
  webapp: boolean
  /** Whether the plugin is on; null for a webapp alone. */
  enabled: boolean | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** One entry per package from the answers of `/skServer/plugins` and `/skServer/webapps`. */
export function installedApps(plugins: unknown, webapps: unknown): InstalledApp[] {
  const apps = new Map<string, InstalledApp>()
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (!isPlainObject(p) || text(p.packageName) === '') {
      continue
    }
    const data = isPlainObject(p.data) ? p.data : {}
    apps.set(text(p.packageName), {
      name: text(p.packageName),
      version: text(p.version),
      title: text(p.name) || text(p.packageName),
      plugin: true,
      webapp: false,
      enabled: data.enabled === true
    })
  }
  for (const w of Array.isArray(webapps) ? webapps : []) {
    if (!isPlainObject(w) || text(w.name) === '') {
      continue
    }
    const known = apps.get(text(w.name))
    if (known) {
      known.webapp = true
      continue
    }
    const signalk = isPlainObject(w.signalk) ? w.signalk : {}
    apps.set(text(w.name), {
      name: text(w.name),
      version: text(w.version),
      title: text(signalk.displayName) || text(w.name),
      plugin: false,
      webapp: true,
      enabled: null
    })
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** A list of apps as a peer sends it; what does not fit is left out. */
export function parseInstalled(raw: unknown): InstalledApp[] {
  const list = isPlainObject(raw) && Array.isArray(raw.apps) ? raw.apps : []
  return list.filter(
    (a): a is InstalledApp =>
      isPlainObject(a) &&
      typeof a.name === 'string' &&
      a.name !== '' &&
      typeof a.version === 'string' &&
      typeof a.title === 'string' &&
      typeof a.plugin === 'boolean' &&
      typeof a.webapp === 'boolean' &&
      (typeof a.enabled === 'boolean' || a.enabled === null)
  )
}

export interface LocalAppsHost {
  /** This server's admin token on itself: the plugin list is admin-only. */
  token: () => Promise<string | null>
  ownUrl: () => string
}

/** This server's own apps, read through its REST API and kept for a minute. */
export class LocalApps {
  private cached: { at: number; apps: InstalledApp[] } | null = null

  constructor(private readonly host: LocalAppsHost) {}

  /** Null while this server's admin access waits for approval. */
  async list(now = Date.now()): Promise<InstalledApp[] | null> {
    if (this.cached && now - this.cached.at < LIST_MAX_AGE_MS) {
      return this.cached.apps
    }
    const token = await this.host.token()
    if (token === null) {
      return null
    }
    const base = this.host.ownUrl()
    const [plugins, webapps] = await Promise.all([
      callServer('GET', `${base}/skServer/plugins`, token),
      callServer('GET', `${base}/skServer/webapps`, token)
    ])
    const apps = installedApps(plugins, webapps)
    this.cached = { at: now, apps }
    return apps
  }
}

export interface ServerApps {
  name: string
  /** Null when the server could not say, with the reason in `error`. */
  apps: InstalledApp[] | null
  error?: string
}

export interface AppElsewhere {
  name: string
  title: string
  plugin: boolean
  webapp: boolean
  /** Each server that has it, with its version there. */
  servers: { name: string; version: string }[]
}

export interface AppsReport {
  /** Null while this server cannot read its own list. */
  here: string | null
  /** On another server, not on this one. */
  missing: AppElsewhere[]
  /** On this server at `version`, on another at a different one. */
  versions: (AppElsewhere & { version: string })[]
  /** A plugin on here and on another server, off here and on there. */
  disabled: AppElsewhere[]
  /** The packages the user set aside on this server. */
  hidden: string[]
  /** The servers whose list could not be read. */
  unreadable: { name: string; error: string }[]
}

export function compareApps(
  local: InstalledApp[] | null,
  servers: ServerApps[],
  hidden: readonly string[],
  hereError: string | null = null
): AppsReport {
  const mine = new Map((local ?? []).map((a) => [a.name, a]))
  const elsewhere = new Map<string, { app: InstalledApp; servers: ServerApps[] }>()
  for (const server of servers) {
    for (const app of server.apps ?? []) {
      const entry = elsewhere.get(app.name) ?? { app, servers: [] }
      entry.servers.push(server)
      elsewhere.set(app.name, entry)
    }
  }
  const report: AppsReport = {
    here: local ? null : (hereError ?? 'this server cannot read its own apps yet'),
    missing: [],
    versions: [],
    disabled: [],
    hidden: [...hidden].sort((a, b) => a.localeCompare(b)),
    unreadable: servers
      .filter((s) => s.apps === null)
      .map((s) => ({ name: s.name, error: s.error ?? 'no answer' }))
  }
  if (!local) {
    return report
  }
  const skip = new Set(hidden)
  for (const [name, { app, servers: on }] of [...elsewhere].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (skip.has(name)) {
      continue
    }
    const versionOn = (s: ServerApps): string => s.apps?.find((a) => a.name === name)?.version ?? ''
    const entry = (only: ServerApps[]): AppElsewhere => ({
      name,
      title: app.title,
      plugin: app.plugin,
      webapp: app.webapp,
      servers: only.map((s) => ({ name: s.name, version: versionOn(s) }))
    })
    const here = mine.get(name)
    if (!here) {
      report.missing.push(entry(on))
      continue
    }
    const otherVersion = on.filter((s) => versionOn(s) !== here.version)
    if (otherVersion.length > 0) {
      report.versions.push({ ...entry(otherVersion), version: here.version })
    }
    if (here.enabled === false) {
      const enabledThere = on.filter((s) => s.apps?.find((a) => a.name === name)?.enabled === true)
      if (enabledThere.length > 0) {
        report.disabled.push(entry(enabledThere))
      }
    }
  }
  return report
}

/** A peer's apps; a peer with an older Multihelm has no such route. */
export async function peerApps(
  peer: PeerAddress & { name: string; token: string }
): Promise<ServerApps> {
  try {
    const raw = await callPeer('GET', peer, `${ROUTE_PREFIX}${INSTALLED_ROUTE}`, peer.token)
    return { name: peer.name, apps: parseInstalled(raw) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      name: peer.name,
      apps: null,
      error: /^HTTP 404 /.test(message)
        ? 'it runs an older Multihelm'
        : /^HTTP 503 /.test(message)
          ? 'its own access request waits for approval there'
          : message
    }
  }
}

export interface AppsOverviewHost {
  local: LocalApps
  /** The paired servers answering now. */
  peers: () => (PeerAddress & { name: string; token: string })[]
  hidden: () => string[]
  saveHidden: (names: string[]) => void
}

/** What the settings show of the apps on the other servers. */
export class AppsOverview {
  constructor(private readonly host: AppsOverviewHost) {}

  async report(): Promise<AppsReport> {
    let local: InstalledApp[] | null = null
    let hereError: string | null = null
    const [servers] = await Promise.all([
      Promise.all(this.host.peers().map((p) => peerApps(p))),
      this.host.local.list().then(
        (apps) => {
          local = apps
        },
        (error: unknown) => {
          hereError = error instanceof Error ? error.message : String(error)
        }
      )
    ])
    return compareApps(local, servers, this.host.hidden(), hereError)
  }

  setHidden(name: string, hidden: boolean): void {
    const names = new Set(this.host.hidden())
    if (hidden) {
      names.add(name)
    } else {
      names.delete(name)
    }
    this.host.saveHidden([...names])
  }
}
