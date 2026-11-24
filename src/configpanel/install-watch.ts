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
  changed: (installs: Record<string, 'pending' | 'done'>) => void
  failed: (names: string[]) => void
  /** Whether the App Store's events reach this page; while not, an install's end goes unseen. */
  connected?: (connected: boolean) => void
}

const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 30_000

/**
 * Follows App Store installs through its `APP_STORE_CHANGED` server events:
 * the install route answers once an install is queued. A closed socket is
 * opened again, and the event the server replays on connecting settles any
 * install that ended meanwhile; a lost connection never counts as a failure.
 */
interface Install {
  state: 'pending' | 'done'
  /** Whether a result now is this attempt's: none was listed before it, or it was seen under way. */
  current: boolean
}

export class InstallWatch {
  private readonly installs = new Map<string, Install>()
  /** The packages the last App Store event listed; null before the first. */
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
   * result there, so its result counts only once this attempt was seen under way.
   */
  begin(name: string): void {
    this.installs.set(name, {
      state: 'pending',
      current: this.listed !== null && !this.listed.has(name)
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
      const now = install.state === 'pending' ? states.get(name) : undefined
      if (now === 'pending') {
        install.current = true
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
