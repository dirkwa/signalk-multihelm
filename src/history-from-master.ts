/**
 * On a server that is not the master, answers this server's History API
 * from the master's, so the history is kept once on the boat. It registers
 * as a history provider only while the master has one itself.
 */

import type {
  ContextsRequest,
  ContextsResponse,
  HistoryProvider,
  PathSpec,
  PathsRequest,
  PathsResponse,
  ValuesRequest,
  ValuesResponse
} from '@signalk/server-api/history'

import type { MasterResponse, MasterRouteHandle } from './api.js'

export const HISTORY_PREFIX = '/signalk/v2/api/history/'
const HTTP_OK = 200
const HTTP_NOT_FOUND = 404

export interface MasterHistoryHost {
  registerMasterRoute: (prefix: string) => MasterRouteHandle
  fetchMaster: (path: string) => Promise<MasterResponse>
  /** This server is a member and another server is the master. */
  hasMaster: () => boolean
  register: (provider: HistoryProvider) => void
  unregister: () => void
  debug: (msg: string) => void
}

type RangeRequest = ContextsRequest & { context?: string }

function rangeParams(request: RangeRequest): URLSearchParams {
  const params = new URLSearchParams()
  if (request.from !== undefined) {
    params.set('from', request.from.toString())
  }
  if (request.to !== undefined) {
    params.set('to', request.to.toString())
  }
  if (request.duration !== undefined) {
    params.set('duration', request.duration.toString())
  }
  if (request.context !== undefined) {
    params.set('context', request.context)
  }
  return params
}

export function pathExpression(spec: PathSpec): string {
  const parameters = spec.parameter.map((p) => `:${p}`).join('')
  const source = spec.sourceRef ? `|${spec.sourceRef}` : ''
  return `${spec.path}:${spec.aggregate}${parameters}${source}`
}

export function valuesQuery(request: ValuesRequest): string {
  const params = rangeParams(request)
  params.set('paths', request.pathSpecs.map(pathExpression).join(','))
  if (request.resolution !== undefined) {
    params.set('resolution', String(request.resolution))
  }
  if (request.sourcePolicy !== undefined) {
    params.set('sourcePolicy', request.sourcePolicy)
  }
  return params.toString()
}

/** Before Signal K 2.32.0 a plugin cannot withdraw its history provider, so it must not register one. */
export function canWithdrawHistoryProvider(app: object): boolean {
  return (
    typeof (app as { unregisterHistoryApiProvider?: unknown }).unregisterHistoryApiProvider ===
    'function'
  )
}

export class MasterHistory {
  private registered = false
  /** Only the latest check may act on its answer; stop() outdates every check in flight. */
  private latestCheck = 0
  private route: MasterRouteHandle | null = null
  private readonly provider: HistoryProvider = {
    getValues: (request: ValuesRequest) =>
      this.read<ValuesResponse>(`values?${valuesQuery(request)}`),
    getPaths: (request: PathsRequest) =>
      this.read<PathsResponse>(`paths?${rangeParams(request).toString()}`),
    getContexts: (request: ContextsRequest) =>
      this.read<ContextsResponse>(`contexts?${rangeParams(request).toString()}`)
  }

  constructor(private readonly host: MasterHistoryHost) {}

  /** Registers while the master has a history provider, and withdraws otherwise. */
  async check(): Promise<void> {
    const thisCheck = ++this.latestCheck
    if (!this.host.hasMaster()) {
      this.withdraw()
      return
    }
    this.route ??= this.host.registerMasterRoute(HISTORY_PREFIX)
    let providers: unknown
    try {
      providers = await this.masterProviders()
    } catch (error) {
      // A master that answers again soon keeps serving the history meanwhile.
      this.host.debug(
        `Multihelm: cannot ask the master for its history providers: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    if (thisCheck !== this.latestCheck) {
      return
    }
    const masterHasHistory =
      typeof providers === 'object' && providers !== null && Object.keys(providers).length > 0
    if (masterHasHistory && this.host.hasMaster()) {
      if (!this.registered) {
        this.host.register(this.provider)
        this.registered = true
        this.host.debug("Multihelm: serving the master's history")
      }
    } else {
      this.withdraw()
    }
  }

  stop(): void {
    this.latestCheck++
    this.withdraw()
    this.route?.unregister()
    this.route = null
  }

  private withdraw(): void {
    if (this.registered) {
      this.host.unregister()
      this.registered = false
      this.host.debug("Multihelm: no longer serving the master's history")
    }
  }

  /** A master without the History API has no providers; any other failure says nothing. */
  private async masterProviders(): Promise<unknown> {
    const answer = await this.host.fetchMaster(`${HISTORY_PREFIX}_providers`)
    if (answer.status === HTTP_NOT_FOUND) {
      return {}
    }
    if (answer.status !== HTTP_OK) {
      throw new Error(`HTTP ${String(answer.status)}`)
    }
    return JSON.parse(answer.body.toString('utf-8')) as unknown
  }

  private async read<T>(query: string): Promise<T> {
    const answer = await this.host.fetchMaster(`${HISTORY_PREFIX}${query}`)
    if (answer.status !== HTTP_OK) {
      throw new Error(`the master's History API answered HTTP ${String(answer.status)}`)
    }
    return JSON.parse(answer.body.toString('utf-8')) as T
  }
}
