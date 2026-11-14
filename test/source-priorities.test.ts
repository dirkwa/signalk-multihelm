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

  it('keeps timeouts given as strings as numbers', () => {
    expect(
      parseSourcePriorities({
        groups: [],
        overrides: { 'navigation.position': [{ sourceRef: 'can0.a', timeout: '-1' }] }
      })
    ).toEqual({
      groups: [],
      overrides: { 'navigation.position': [{ sourceRef: 'can0.a', timeout: -1 }] },
      defaults: {}
    })
  })

  it('takes nothing when any part does not fit', () => {
    const valid = {
      groups: [{ id: 'gps', sources: ['can0.a'] }],
      overrides: { 'navigation.position': [{ sourceRef: 'can0.a', timeout: 5000 }] },
      defaults: { fallbackMs: 15000 }
    }
    expect(parseSourcePriorities(valid)).toEqual(valid)
    for (const broken of [
      { ...valid, groups: [{ id: 'gps', sources: ['can0.a', 7] }] },
      { ...valid, groups: [{ id: 'gps', sources: [], inactive: 'no' }] },
      { ...valid, groups: [...valid.groups, { sources: [] }] },
      {
        ...valid,
        overrides: { 'navigation.position': [{ sourceRef: 'can0.b', timeout: 'soon' }] }
      },
      { ...valid, overrides: { 'navigation.position': 'x' } },
      { ...valid, defaults: { fallbackMs: -5 } },
      { ...valid, defaults: 'x' },
      { groups: {}, overrides: {} },
      undefined
    ]) {
      expect(parseSourcePriorities(broken)).toBeNull()
    }
  })
})
