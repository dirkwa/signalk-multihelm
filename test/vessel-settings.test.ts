import { describe, expect, it } from 'vitest'

import { parseVesselSettings, vesselSettingsFromDeltas } from '../src/vessel-settings.js'

describe('vesselSettingsFromDeltas', () => {
  it('collects the vessel data and path metadata the server keeps as base deltas', () => {
    const deltas = [
      {
        context: 'vessels.self',
        updates: [
          {
            values: [
              { path: '', value: { name: 'Pelican', mmsi: '503123456' } },
              { path: 'design.length', value: { overall: 14.2 } },
              { path: 'design.draft', value: { maximum: 1.9 } },
              { path: 'design.beam', value: 4.4 },
              { path: 'design.airHeight', value: 21 },
              { path: 'design.aisShipType', value: { id: 36, name: 'Sailing' } },
              { path: 'communication', value: { callsignVhf: 'V3AB' } },
              { path: 'sensors.gps.fromBow', value: 6.1 }
            ]
          }
        ]
      },
      {
        context: 'vessels.self',
        updates: [
          {
            meta: [{ path: 'environment.depth.belowTransducer', value: { displayName: 'Depth' } }]
          }
        ]
      },
      {
        context: 'vessels.urn:mrn:imo:mmsi:111',
        updates: [{ values: [{ path: '', value: { name: 'x' } }] }]
      }
    ]
    expect(vesselSettingsFromDeltas(deltas)).toEqual({
      vessel: {
        name: 'Pelican',
        mmsi: '503123456',
        length: 14.2,
        draft: 1.9,
        beam: 4.4,
        height: 21,
        aisShipType: 36,
        callsignVhf: 'V3AB'
      },
      meta: { 'environment.depth.belowTransducer': { displayName: 'Depth' } }
    })
  })

  it('leaves out metadata under a path that cannot be written', () => {
    const deltas = [
      { context: 'vessels.self', updates: [{ meta: [{ path: '', value: { units: 'm' } }] }] }
    ]
    expect(vesselSettingsFromDeltas(deltas).meta).toEqual({})
  })

  it('skips what is not a delta', () => {
    expect(vesselSettingsFromDeltas([null, 3, { context: 'vessels.self', updates: [7] }])).toEqual({
      vessel: {},
      meta: {}
    })
    expect(vesselSettingsFromDeltas('nope')).toEqual({ vessel: {}, meta: {} })
  })
})

describe('parseVesselSettings', () => {
  it('keeps the known fields of a peer answer and drops the rest', () => {
    expect(
      parseVesselSettings({
        vessel: { name: 'Pelican', beam: 4.4, length: 'long', extra: 1 },
        meta: {
          'a.b': { units: 'm' },
          'electrical.batteries.house-bank.voltage': { units: 'V' },
          '../x': { units: 'm' },
          '': { units: 'm' },
          'c.d': 5
        }
      })
    ).toEqual({
      vessel: { name: 'Pelican', beam: 4.4 },
      meta: { 'a.b': { units: 'm' }, 'electrical.batteries.house-bank.voltage': { units: 'V' } }
    })
    expect(parseVesselSettings({ vessel: {} })).toBeNull()
  })
})
