import { describe, expect, it } from 'vitest'

import { vesselSettingsFromDeltas } from '../src/vessel-settings.js'

describe('vesselSettingsFromDeltas', () => {
  it('collects the self vessel values and metadata the server keeps as base deltas', () => {
    const deltas = [
      {
        context: 'vessels.self',
        updates: [
          {
            values: [
              { path: '', value: { name: 'Pelican', mmsi: '503123456' } },
              { path: 'design.length', value: { overall: 14.2 } },
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
      { context: 'vessels.urn:mrn:imo:mmsi:111', updates: [{ values: [{ path: 'x', value: 1 }] }] }
    ]
    expect(vesselSettingsFromDeltas(deltas)).toEqual({
      values: {
        name: 'Pelican',
        mmsi: '503123456',
        'design.length': { overall: 14.2 },
        'sensors.gps.fromBow': 6.1
      },
      meta: { 'environment.depth.belowTransducer': { displayName: 'Depth' } }
    })
  })

  it('skips what is not a delta', () => {
    expect(vesselSettingsFromDeltas([null, 3, { context: 'vessels.self', updates: [7] }])).toEqual({
      values: {},
      meta: {}
    })
    expect(vesselSettingsFromDeltas('nope')).toEqual({ values: {}, meta: {} })
  })
})
