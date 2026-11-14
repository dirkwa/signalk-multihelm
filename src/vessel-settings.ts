/**
 * What the user set for this vessel on the server: the vessel data from
 * Server -> Settings and the metadata set for paths (display names, units,
 * zones). The server keeps both as its base deltas, sent again at every
 * start; they are the self vessel's part of those deltas.
 */

import { parseSourcePriorities, type SourcePriorities } from './source-priorities.js'

/** The fields of the server's `/skServer/vessel` that follow the master. */
export interface VesselData {
  name?: string
  mmsi?: string
  uuid?: string
  draft?: number
  length?: number
  beam?: number
  height?: number
  aisShipType?: number
  callsignVhf?: string
}

export const VESSEL_FIELDS = [
  'name',
  'mmsi',
  'uuid',
  'draft',
  'length',
  'beam',
  'height',
  'aisShipType',
  'callsignVhf'
] as const satisfies readonly (keyof VesselData)[]

export interface VesselSettings {
  vessel: VesselData
  /** Signal K path -> its metadata. */
  meta: Record<string, unknown>
  /** Absent from a server that does not send them, such as an older Multihelm. */
  priorities?: SourcePriorities
}

const SELF = 'vessels.self'

/** A path whose metadata can be read and written: dot-separated segments, none empty. */
export function isMetaPath(path: string): boolean {
  return /^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/.test(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathValues(list: unknown): { path: string; value: unknown }[] {
  if (!Array.isArray(list)) {
    return []
  }
  return (list as unknown[]).flatMap((pv) =>
    isRecord(pv) && typeof pv.path === 'string' ? [{ path: pv.path, value: pv.value }] : []
  )
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function vesselData(values: Map<string, unknown>): VesselData {
  const length = values.get('design.length')
  const data: VesselData = {
    name: text(values.get('name')),
    mmsi: text(values.get('mmsi')),
    uuid: text(values.get('uuid')),
    draft: num(field(values.get('design.draft'), 'maximum')),
    length: num(length) ?? num(field(length, 'overall')),
    beam: num(values.get('design.beam')),
    height: num(values.get('design.airHeight')),
    aisShipType: num(field(values.get('design.aisShipType'), 'id')),
    callsignVhf: text(field(values.get('communication'), 'callsignVhf'))
  }
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))
}

export function vesselSettingsFromDeltas(deltas: unknown): VesselSettings {
  const values = new Map<string, unknown>()
  const meta: Record<string, unknown> = {}
  if (Array.isArray(deltas)) {
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
            for (const [k, v] of Object.entries(value)) {
              values.set(k, v)
            }
          } else if (path !== '') {
            values.set(path, value)
          }
        }
        for (const { path, value } of pathValues(update.meta)) {
          if (isMetaPath(path)) {
            meta[path] = value
          }
        }
      }
    }
  }
  return { vessel: vesselData(values), meta }
}

/** A peer's answer, kept to the shape above; anything else is dropped. */
export function parseVesselSettings(raw: unknown): VesselSettings | null {
  if (!isRecord(raw) || !isRecord(raw.vessel) || !isRecord(raw.meta)) {
    return null
  }
  const v = raw.vessel
  const vessel: VesselData = {}
  for (const key of ['name', 'mmsi', 'uuid', 'callsignVhf'] as const) {
    const t = text(v[key])
    if (t !== undefined) {
      vessel[key] = t
    }
  }
  for (const key of ['draft', 'length', 'beam', 'height', 'aisShipType'] as const) {
    const n = num(v[key])
    if (n !== undefined) {
      vessel[key] = n
    }
  }
  const meta: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(raw.meta)) {
    if (isMetaPath(path) && isRecord(value)) {
      meta[path] = value
    }
  }
  const priorities = parseSourcePriorities(raw.priorities)
  return priorities ? { vessel, meta, priorities } : { vessel, meta }
}
