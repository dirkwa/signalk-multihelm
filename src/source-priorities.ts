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

function group(value: unknown): PriorityGroup[] {
  if (!isRecord(value) || !isText(value.id) || !Array.isArray(value.sources)) {
    return []
  }
  const sources = (value.sources as unknown[]).filter(isText)
  return [
    typeof value.inactive === 'boolean'
      ? { id: value.id, sources, inactive: value.inactive }
      : { id: value.id, sources }
  ]
}

/** The server takes a timeout as an integer or a string of one, and keeps a number. */
function entry(value: unknown): PriorityEntry[] {
  if (!isRecord(value) || !isText(value.sourceRef)) {
    return []
  }
  const timeout =
    typeof value.timeout === 'string' && /^-?\d+$/.test(value.timeout)
      ? Number(value.timeout)
      : value.timeout
  return typeof timeout === 'number' && Number.isInteger(timeout)
    ? [{ sourceRef: value.sourceRef, timeout }]
    : []
}

/** Kept to the shape above, anything else dropped; null when it is no priorities at all. */
export function parseSourcePriorities(raw: unknown): SourcePriorities | null {
  if (!isRecord(raw) || !Array.isArray(raw.groups) || !isRecord(raw.overrides)) {
    return null
  }
  const overrides: Record<string, PriorityEntry[]> = {}
  for (const [path, list] of Object.entries(raw.overrides)) {
    if (Array.isArray(list)) {
      overrides[path] = (list as unknown[]).flatMap(entry)
    }
  }
  const fallbackMs = isRecord(raw.defaults) ? raw.defaults.fallbackMs : undefined
  return {
    groups: (raw.groups as unknown[]).flatMap(group),
    overrides,
    defaults:
      typeof fallbackMs === 'number' && fallbackMs > 0 && Number.isFinite(fallbackMs)
        ? { fallbackMs }
        : {}
  }
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
