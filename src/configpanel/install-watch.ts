import { installStates } from './view.js'

export interface SocketEvents {
  message: (data: unknown) => void
  close: () => void
}

export interface EventSocket {
  close: () => void
}

export interface InstallWatchHost {
  connect: (on: SocketEvents) => EventSocket
  /** The apps whose install is under way, and those installed since. */
  changed: (installs: Record<string, WatchedState>) => void
  failed: (names: string[]) => void
  /** Whether the App Store's events reach this page; while not, an install's end goes unseen. */
  connected?: (connected: boolean) => void
}

const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 30_000

/**
 * `unknown`: this attempt was not seen under way while connected, so its
 * result cannot be told from an earlier one's, or another client's, until it is.
 */
export type WatchedState = 'pending' | 'done' | 'unknown'

interface Install {
  state: WatchedState
  /** Whether a result now is this attempt's: none was listed before it, or it was seen under way. */
  current: boolean
  seen: boolean
}

/**
 * Follows App Store installs through its `APP_STORE_CHANGED` server events:
 * the install route answers once an install is queued. A closed socket is
 * opened again, and the event the server replays on connecting settles an
 * install seen under way that ended meanwhile; a lost connection never
 * counts as a failure.
 */
export class InstallWatch {
  private readonly installs = new Map<string, Install>()
  /** The packages the last App Store event on the open socket listed; null before its first. */
  private listed: Set<string> | null = null
  private socket: EventSocket | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryMs = RETRY_FIRST_MS
  private stopped = false

  constructor(private readonly host: InstallWatchHost) {}

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retry !== null) {
      clearTimeout(this.retry)
      this.retry = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  /**
   * Before the install is asked for, so an end reported before its answer
   * counts. A package the App Store already lists keeps an earlier attempt's
   * result there, and without a listing from the open socket another client's
   * may be there, so then a result counts only once this attempt was seen under way.
   */
  begin(name: string): void {
    this.installs.set(name, {
      state: this.listed === null ? 'unknown' : 'pending',
      current: this.listed !== null && !this.listed.has(name),
      seen: false
    })
    this.report()
  }

  /** The App Store refused the install. */
  cancel(name: string): void {
    if (this.installs.delete(name)) {
      this.report()
    }
  }

  private open(): void {
    this.listed = null
    const socket = this.host.connect({
      message: (data) => {
        if (this.socket !== socket) {
          return
        }
        this.retryMs = RETRY_FIRST_MS
        this.host.connected?.(true)
        this.handle(data)
      },
      close: () => {
        if (this.socket !== socket || this.stopped) {
          return
        }
        this.socket = null
        this.host.connected?.(false)
        this.giveUpUnseen()
        this.retry = setTimeout(() => {
          this.retry = null
          if (!this.stopped) {
            this.open()
          }
        }, this.retryMs)
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS)
      }
    })
    this.socket = socket
  }

  private giveUpUnseen(): void {
    this.listed = null
    let change = false
    for (const install of this.installs.values()) {
      if (install.state === 'pending' && !install.seen) {
        install.state = 'unknown'
        install.current = false
        change = true
      }
    }
    if (change) {
      this.report()
    }
  }

  private handle(data: unknown): void {
    let event: unknown
    try {
      event = typeof data === 'string' ? JSON.parse(data) : null
    } catch {
      return
    }
    const states = installStates(event)
    if (states === null) {
      return
    }
    this.listed = new Set(states.keys())
    const failed: string[] = []
    let change = false
    for (const [name, install] of this.installs) {
      const now = install.state === 'done' ? undefined : states.get(name)
      if (now === 'pending') {
        install.current = true
        install.seen = true
        if (install.state === 'unknown') {
          install.state = 'pending'
          change = true
        }
      } else if (now !== undefined && install.current) {
        if (now === 'done') {
          install.state = 'done'
        } else {
          this.installs.delete(name)
          failed.push(name)
        }
        change = true
      }
    }
    if (change) {
      this.report()
    }
    if (failed.length > 0) {
      this.host.failed(failed)
    }
  }

  private report(): void {
    this.host.changed(
      Object.fromEntries([...this.installs].map(([name, install]) => [name, install.state]))
    )
  }
}
