import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  InstallWatch,
  type EventSocket,
  type SocketEvents
} from '../src/configpanel/install-watch.js'

class FakeSocket implements EventSocket {
  closed = false
  constructor(private readonly on: SocketEvents) {}
  close(): void {
    this.closed = true
  }
  drop(): void {
    this.on.close()
  }
  send(installing: unknown[]): void {
    this.on.message(JSON.stringify({ type: 'APP_STORE_CHANGED', data: { installing } }))
  }
}

function watch() {
  const sockets: FakeSocket[] = []
  const states: Record<string, 'pending' | 'done'>[] = []
  const failed: string[][] = []
  const connected: boolean[] = []
  const w = new InstallWatch({
    connect: (on) => {
      const s = new FakeSocket(on)
      sockets.push(s)
      return s
    },
    changed: (s) => states.push(s),
    failed: (names) => failed.push(names),
    connected: (c) => connected.push(c)
  })
  w.start()
  return { w, sockets, states, failed, connected, last: () => states[states.length - 1] }
}

describe('following App Store installs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays pending while the install runs, then reports it done', () => {
    const t = watch()
    t.w.begin('a')
    expect(t.last()).toEqual({ a: 'pending' })
    t.sockets[0]?.send([{ name: 'a', isWaiting: true }])
    t.sockets[0]?.send([{ name: 'a', isInstalling: true }])
    expect(t.last()).toEqual({ a: 'pending' })
    t.sockets[0]?.send([{ name: 'a' }])
    expect(t.last()).toEqual({ a: 'done' })
    expect(t.failed).toEqual([])
  })

  it('counts an end reported before the install route answered', () => {
    const t = watch()
    t.w.begin('a')
    t.sockets[0]?.send([{ name: 'a', installFailed: true }])
    expect(t.last()).toEqual({})
    expect(t.failed).toEqual([['a']])
  })

  it('forgets an install the App Store refused', () => {
    const t = watch()
    t.w.begin('a')
    t.w.cancel('a')
    expect(t.last()).toEqual({})
    t.sockets[0]?.send([{ name: 'a', installFailed: true }])
    expect(t.failed).toEqual([])
  })

  it('opens the socket again after it closed, and settles the install from the replayed event', () => {
    const t = watch()
    t.w.begin('a')
    t.sockets[0]?.drop()
    expect(t.connected).toEqual([false])
    expect(t.last()).toEqual({ a: 'pending' })
    vi.advanceTimersByTime(1_000)
    expect(t.sockets).toHaveLength(2)
    t.sockets[1]?.send([{ name: 'a' }])
    expect(t.connected).toEqual([false, true])
    expect(t.last()).toEqual({ a: 'done' })
    expect(t.failed).toEqual([])
  })

  it('waits longer each time the socket closes without an event', () => {
    const t = watch()
    t.sockets[0]?.drop()
    vi.advanceTimersByTime(1_000)
    t.sockets[1]?.drop()
    vi.advanceTimersByTime(1_999)
    expect(t.sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(t.sockets).toHaveLength(3)
  })

  it('opens nothing once stopped', () => {
    const t = watch()
    t.sockets[0]?.drop()
    t.w.stop()
    vi.advanceTimersByTime(60_000)
    expect(t.sockets).toHaveLength(1)
    const u = watch()
    u.w.stop()
    expect(u.sockets[0]?.closed).toBe(true)
  })
})
