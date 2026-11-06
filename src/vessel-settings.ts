/**
 * What the user set for this vessel on the server: the values from Server →
 * Settings (name, MMSI, dimensions, GPS position) and the metadata set for
 * paths (display names, units, zones). The server keeps both as its base
 * deltas, sent again at every start; they are the self vessel's part of
 * those deltas.
 */

export interface VesselSettings {
  /** Path below the vessel → value; `name`, `mmsi` and `uuid` sit at the top. */
  values: Record<string, unknown>
  /** Signal K path → its metadata. */
  meta: Record<string, unknown>
}

const SELF = 'vessels.self'

interface PathValue {
  path?: unknown
  value?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathValues(list: unknown): { path: string; value: unknown }[] {
  if (!Array.isArray(list)) {
    return []
  }
  return (list as PathValue[]).flatMap((pv) =>
    isRecord(pv) && typeof pv.path === 'string' ? [{ path: pv.path, value: pv.value }] : []
  )
}

export function vesselSettingsFromDeltas(deltas: unknown): VesselSettings {
  const settings: VesselSettings = { values: {}, meta: {} }
  if (!Array.isArray(deltas)) {
    return settings
  }
  for (const delta of deltas as unknown[]) {
    if (!isRecord(delta) || delta.context !== SELF || !Array.isArray(delta.updates)) {
      continue
    }
    for (const update of delta.updates as unknown[]) {
      if (!isRecord(update)) {
        continue
      }
      for (const { path, value } of pathValues(update.values)) {
        if (path === '' && isRecord(value)) {
          Object.assign(settings.values, value)
        } else if (path !== '') {
          settings.values[path] = value
        }
      }
      for (const { path, value } of pathValues(update.meta)) {
        settings.meta[path] = value
      }
    }
  }
  return settings
}
