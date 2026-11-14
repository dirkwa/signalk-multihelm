/**
 * The source priorities the user set under Data -> Source Priorities, in the
 * shape of the server's `/skServer/priorities`: which source wins for a path
 * while it sends, and how long until the next one takes over.
 */

export interface PriorityGroup {
  id: string
  sources: string[]
  inactive?: boolean
}

export interface PriorityEntry {
  sourceRef: string
  timeout: number
}

export interface SourcePriorities {
  groups: PriorityGroup[]
  /** Signal K path -> its sources, best first. */
  overrides: Record<string, PriorityEntry[]>
  defaults: { fallbackMs?: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function group(value: unknown): PriorityGroup | null {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !Array.isArray(value.sources) ||
    !(value.sources as unknown[]).every(isText) ||
    (value.inactive !== undefined && typeof value.inactive !== 'boolean')
  ) {
    return null
  }
  const sources = value.sources as string[]
  return value.inactive === undefined
    ? { id: value.id, sources }
    : { id: value.id, sources, inactive: value.inactive }
}

/** The server takes a timeout as an integer or a string of one, and keeps a number. */
function entry(value: unknown): PriorityEntry | null {
  if (!isRecord(value) || !isText(value.sourceRef)) {
    return null
  }
  const timeout =
    typeof value.timeout === 'string' && /^-?\d+$/.test(value.timeout)
      ? Number(value.timeout)
      : value.timeout
  return typeof timeout === 'number' && Number.isInteger(timeout)
    ? { sourceRef: value.sourceRef, timeout }
    : null
}

function allOrNull<T>(items: unknown[], parse: (item: unknown) => T | null): T[] | null {
  const parsed = items.map(parse)
  return parsed.every((item) => item !== null) ? parsed : null
}

/**
 * Null unless every part has the shape above: a priorities list cut short
 * would replace a server's whole set with less than the master meant.
 */
export function parseSourcePriorities(raw: unknown): SourcePriorities | null {
  if (!isRecord(raw) || !Array.isArray(raw.groups) || !isRecord(raw.overrides)) {
    return null
  }
  const groups = allOrNull(raw.groups as unknown[], group)
  const overrides: Record<string, PriorityEntry[]> = {}
  for (const [path, list] of Object.entries(raw.overrides)) {
    const entries = Array.isArray(list) ? allOrNull(list as unknown[], entry) : null
    if (!entries) {
      return null
    }
    overrides[path] = entries
  }
  const defaults = raw.defaults ?? {}
  if (!groups || !isRecord(defaults)) {
    return null
  }
  const { fallbackMs } = defaults
  if (fallbackMs === undefined) {
    return { groups, overrides, defaults: {} }
  }
  return typeof fallbackMs === 'number' && fallbackMs > 0 && Number.isFinite(fallbackMs)
    ? { groups, overrides, defaults: { fallbackMs } }
    : null
}

/** What this server holds in its settings, read the way `/skServer/priorities` answers. */
export function sourcePrioritiesFromSettings(settings: {
  priorityGroups?: unknown
  priorityOverrides?: unknown
  priorityDefaults?: unknown
}): SourcePriorities | null {
  return parseSourcePriorities({
    groups: settings.priorityGroups ?? [],
    overrides: settings.priorityOverrides ?? {},
    defaults: settings.priorityDefaults ?? {}
  })
}
