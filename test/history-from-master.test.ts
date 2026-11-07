import type { HistoryProvider, ValuesRequest } from '@signalk/server-api/history'
import { describe, expect, it } from 'vitest'

import type { MasterResponse } from '../src/api.js'
import { HISTORY_PREFIX, MasterHistory, valuesQuery } from '../src/history-from-master.js'

/** Temporal values reach the provider as objects that print as ISO 8601. */
const iso = (text: string): never => ({ toString: () => text }) as never

function answer(status: number, body: unknown): MasterResponse {
  return { status, headers: {}, body: Buffer.from(JSON.stringify(body)) }
}

function fakeHost(providers: unknown) {
  const state = {
    hasMaster: true,
    providers,
    fail: false,
    requested: [] as string[],
    routes: [] as string[],
    provider: null as HistoryProvider | null,
    registrations: 0
  }
  const history = new MasterHistory({
    registerMasterRoute: (prefix) => {
      state.routes.push(prefix)
      return {
        unregister: () => {
          state.routes = state.routes.filter((r) => r !== prefix)
        }
      }
    },
    fetchMaster: (path) => {
      state.requested.push(path)
      if (state.fail) {
        return Promise.reject(new Error('unreachable'))
      }
      if (path === `${HISTORY_PREFIX}_providers`) {
        return Promise.resolve(answer(200, state.providers))
      }
      return Promise.resolve(answer(200, { path }))
    },
    hasMaster: () => state.hasMaster,
    register: (provider) => {
      state.provider = provider
      state.registrations++
    },
    unregister: () => {
      state.provider = null
    },
    debug: () => undefined
  })
  return { state, history }
}

describe('valuesQuery', () => {
  it('writes the request back as the History API query the master parses', () => {
    const request = {
      duration: iso('PT24H'),
      context: 'vessels.self',
      resolution: 60,
      pathSpecs: [
        { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
        { path: 'environment.wind.speedApparent', aggregate: 'sma', parameter: ['5'] },
        {
          path: 'environment.depth.belowTransducer',
          aggregate: 'min',
          parameter: [],
          sourceRef: 'can0.115'
        }
      ]
    } as unknown as ValuesRequest
    const params = new URLSearchParams(valuesQuery(request))

    expect(params.get('duration')).toBe('PT24H')
    expect(params.get('context')).toBe('vessels.self')
    expect(params.get('resolution')).toBe('60')
    expect(params.get('paths')).toBe(
      'navigation.speedOverGround:average,environment.wind.speedApparent:sma:5,environment.depth.belowTransducer:min|can0.115'
    )
  })

  it('carries from and to as ISO instants', () => {
    const request = {
      from: iso('2026-11-07T08:00:00Z'),
      to: iso('2026-11-07T09:00:00Z'),
      pathSpecs: []
    } as unknown as ValuesRequest
    const params = new URLSearchParams(valuesQuery(request))

    expect(params.get('from')).toBe('2026-11-07T08:00:00Z')
    expect(params.get('to')).toBe('2026-11-07T09:00:00Z')
  })
})

describe('MasterHistory', () => {
  it('serves the history while the master has a provider, read from the master', async () => {
    const { state, history } = fakeHost({ 'signalk-questdb': { isDefault: true } })
    await history.check()

    expect(state.routes).toEqual([HISTORY_PREFIX])
    expect(state.provider).not.toBeNull()
    const paths = await state.provider?.getPaths({
      duration: iso('PT1H')
    })
    expect(paths).toEqual({ path: `${HISTORY_PREFIX}paths?duration=PT1H` })
  })

  it('stays out while the master has no history provider', async () => {
    const { state, history } = fakeHost({})
    await history.check()

    expect(state.provider).toBeNull()
  })

  it('withdraws when the master is gone and comes back with it', async () => {
    const { state, history } = fakeHost({ 'signalk-questdb': { isDefault: true } })
    await history.check()
    state.hasMaster = false
    await history.check()
    expect(state.provider).toBeNull()

    state.hasMaster = true
    await history.check()
    expect(state.provider).not.toBeNull()
    expect(state.registrations).toBe(2)
  })

  it('keeps serving while the master misses one answer', async () => {
    const { state, history } = fakeHost({ 'signalk-questdb': { isDefault: true } })
    await history.check()
    state.fail = true
    await history.check()

    expect(state.provider).not.toBeNull()
    expect(state.registrations).toBe(1)
  })

  it('passes a failed answer from the master on as an error', async () => {
    const { state, history } = fakeHost({ 'signalk-questdb': { isDefault: true } })
    await history.check()
    state.fail = true

    await expect(state.provider?.getContexts({ duration: iso('PT1H') })).rejects.toThrow(
      'unreachable'
    )
  })

  it('withdraws and releases its route at stop', async () => {
    const { state, history } = fakeHost({ 'signalk-questdb': { isDefault: true } })
    await history.check()
    history.stop()

    expect(state.provider).toBeNull()
    expect(state.routes).toEqual([])
  })
})
