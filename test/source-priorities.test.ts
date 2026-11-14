import { describe, expect, it } from 'vitest'

import { parseSourcePriorities, sourcePrioritiesFromSettings } from '../src/source-priorities.js'

describe('source priorities', () => {
  it('reads them from the settings the way the server answers them', () => {
    expect(sourcePrioritiesFromSettings({})).toEqual({ groups: [], overrides: {}, defaults: {} })
    expect(
      sourcePrioritiesFromSettings({
        priorityGroups: [{ id: 'gps', sources: ['can0.a', 'can0.b'], inactive: false }],
        priorityOverrides: { 'navigation.position': [{ sourceRef: 'can0.a', timeout: 5000 }] },
        priorityDefaults: { fallbackMs: 15000 }
      })
    ).toEqual({
      groups: [{ id: 'gps', sources: ['can0.a', 'can0.b'], inactive: false }],
      overrides: { 'navigation.position': [{ sourceRef: 'can0.a', timeout: 5000 }] },
      defaults: { fallbackMs: 15000 }
    })
  })

  it('keeps timeouts given as strings as numbers and drops what does not fit', () => {
    expect(
      parseSourcePriorities({
        groups: [{ id: 'gps', sources: ['can0.a', 7] }, { sources: [] }, 'x'],
        overrides: {
          'navigation.position': [
            { sourceRef: 'can0.a', timeout: '-1' },
            { sourceRef: 'can0.b', timeout: 'soon' },
            { timeout: 1 }
          ],
          'navigation.speedOverGround': 'x'
        },
        defaults: { fallbackMs: -5 }
      })
    ).toEqual({
      groups: [{ id: 'gps', sources: ['can0.a'] }],
      overrides: { 'navigation.position': [{ sourceRef: 'can0.a', timeout: -1 }] },
      defaults: {}
    })
    expect(parseSourcePriorities(undefined)).toBeNull()
    expect(parseSourcePriorities({ groups: {}, overrides: {} })).toBeNull()
  })
})
