import { installState } from './view.js'

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
export class InstallWatch {
  private readonly installs = new Map<string, 'pending' | 'done'>()
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

  /** Before the install is asked for, so an end reported before its answer counts. */
  begin(name: string): void {
    this.installs.set(name, 'pending')
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
    const failed: string[] = []
    let change = false
    for (const [name, state] of this.installs) {
      const now = state === 'pending' ? installState(event, name) : null
      if (now === 'done') {
        this.installs.set(name, 'done')
        change = true
      } else if (now === 'failed') {
        this.installs.delete(name)
        failed.push(name)
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
    this.host.changed(Object.fromEntries(this.installs))
  }
}
