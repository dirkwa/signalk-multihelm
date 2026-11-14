import os from 'node:os'

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { Type } from 'typebox'

import {
  API_VERSION,
  PROPERTY_NAME,
  type MultihelmProperty,
  type PeerInfo,
  type Role
} from './api.js'
import { ServerDiscovery } from './discovery.js'
import { MasterFollower } from './follow-master.js'
import { MasterHistory, canWithdrawHistoryProvider } from './history-from-master.js'
import { MASTER_ROUTE, MasterProxy } from './master-proxy.js'
import { Multihelm, ROUND_INTERVAL_MS } from './multihelm.js'
import { ROUTE_PREFIX } from './peer-client.js'
import { registerRoutes } from './routes.js'
import { MultihelmStore } from './store.js'
import { sourcePrioritiesFromSettings } from './source-priorities.js'
import { vesselSettingsFromDeltas, type VesselSettings } from './vessel-settings.js'

const PLUGIN_ID = 'signalk-multihelm'

const ConfigSchema = Type.Object({
  master: Type.Boolean({
    title: "This server is the boat's master",
    description:
      'Set this on one server only. Plugins that run on the master alone run here, and the other servers use them through this one.',
    default: false
  }),
  followVessel: Type.Boolean({
    title: 'Take the vessel data over from the master',
    description:
      "Name, MMSI, call sign, dimensions and ship type from Server -> Settings. Changes made here are replaced by the master's.",
    default: true
  }),
  followMetadata: Type.Boolean({
    title: 'Take the path metadata over from the master',
    description:
      "Display names, units, zones and alarm limits set for paths. Changes made here are replaced by the master's.",
    default: true
  }),
  followSourcePriorities: Type.Boolean({
    title: 'Take the source priorities over from the master',
    description:
      "Which source wins for a path, from Data -> Source Priorities. They name sources by connection, so give the NMEA 2000 bus the same connection name on every server. Changes made here are replaced by the master's.",
    default: true
  }),
  historyFromMaster: Type.Boolean({
    title: "Answer this server's History API from the master",
    description:
      "While the master has a history provider (signalk-questdb, for example), history graphs on this server show the master's history, so it is kept once on the boat. Does nothing on the master, while the master has no history, or before Signal K 2.32.0.",
    default: true
  })
})

type Config = {
  master?: unknown
  followVessel?: unknown
  followMetadata?: unknown
  followSourcePriorities?: unknown
  historyFromMaster?: unknown
}

const APPROVE_HINT =
  "approve Multihelm's request under Security -> Access Requests on this server to take the vessel settings over"

const DENIED_HINT =
  'the access request on this server was denied, so the vessel settings are not taken over; restart the plugin to ask again'

function statusText(role: Role, master: PeerInfo | null, conflict: boolean): string {
  if (conflict) {
    return `${role === 'master' ? 'Master' : `Member, master: ${master?.name ?? '?'}`}. More than one server is set to be the master: set one only`
  }
  if (role === 'master') {
    return "Master of the boat's servers"
  }
  return master ? `Member, master: ${master.name}` : 'Member, no master found'
}

/** The parts of the server the typed API leaves out. */
type Host = ServerAPI & {
  config?: {
    getExternalPort?: () => number
    baseDeltaEditor?: { deltas?: unknown }
    settings?: {
      ssl?: boolean
      port?: number
      sslport?: number
      priorityGroups?: unknown
      priorityOverrides?: unknown
      priorityDefaults?: unknown
    }
  }
}

export default function (app: ServerAPI): Plugin {
  const host = app as Host
  let multihelm: Multihelm | null = null
  let discovery: ServerDiscovery | null = null
  let masterProxy: MasterProxy | null = null
  let stopRoleStatus: (() => void) | null = null
  let stopFollowing: (() => void) | null = null

  function localVesselSettings(): VesselSettings | null {
    const deltas = host.config?.baseDeltaEditor?.deltas
    if (deltas === undefined) {
      return null
    }
    const settings = vesselSettingsFromDeltas(deltas)
    const priorities = host.config?.settings
      ? sourcePrioritiesFromSettings(host.config.settings)
      : null
    return priorities ? { ...settings, priorities } : settings
  }

  /** The port this server listens on, as the server itself works it out. */
  function ownUrl(): string {
    const settings = host.config?.settings
    if (settings?.ssl) {
      return `https://127.0.0.1:${String(Number(process.env.SSLPORT) || settings.sslport || 3443)}`
    }
    return `http://127.0.0.1:${String(Number(process.env.PORT) || settings?.port || 3000)}`
  }

  function publish(value: MultihelmProperty): void {
    app.emitPropertyValue(PROPERTY_NAME, value)
  }

  return {
    id: PLUGIN_ID,
    name: 'Multihelm',
    description:
      "Keeps the Signal K servers of one boat in step, and knows which one is the boat's master",
    schema: () => ConfigSchema,

    start(config: object) {
      // Schema defaults are not applied at runtime: a never configured plugin gets {}.
      const settings = config as Config
      const isMaster = settings.master === true
      const store = new MultihelmStore(app.getDataDirPath())
      const mh = new Multihelm(store, {
        serverName: () => os.hostname(),
        isMaster: () => isMaster,
        debug: (msg) => {
          app.debug(msg)
        },
        error: (msg) => {
          app.error(msg)
        }
      })
      multihelm = mh
      const proxy = new MasterProxy(() => mh.masterAccess())
      masterProxy = proxy
      discovery = new ServerDiscovery(() => host.config?.getExternalPort?.())
      discovery.start()
      mh.start()
      publish({
        apiVersion: API_VERSION,
        registerDataset: (definition) => mh.registerDataset(definition),
        peers: () => mh.peerInfo(),
        serverId: () => mh.serverId,
        role: () => mh.role(),
        master: () => mh.master(),
        onRoleChanged: (cb) => mh.onRoleChanged(cb),
        registerMasterRoute: (prefix) => proxy.register(prefix),
        masterPath: (target) => `${ROUTE_PREFIX}${MASTER_ROUTE}${target}`,
        fetchMaster: (target) => proxy.fetch(target)
      })
      const follower = new MasterFollower({
        store,
        serverId: mh.serverId,
        ownUrl,
        localSettings: localVesselSettings,
        master: () => mh.masterAccess(),
        followVessel: settings.followVessel !== false,
        followMeta: settings.followMetadata !== false,
        followPriorities: settings.followSourcePriorities !== false,
        debug: (msg) => {
          app.debug(msg)
        },
        error: (msg) => {
          app.error(msg)
        }
      })
      const showRole = (): void => {
        const text = statusText(mh.role(), mh.master(), mh.masterConflict())
        if (follower.waitingForApproval()) {
          app.setPluginStatus(`${text}; ${APPROVE_HINT}`)
        } else if (follower.denied()) {
          app.setPluginStatus(`${text}; ${DENIED_HINT}`)
        } else {
          app.setPluginStatus(text)
        }
      }
      let following = false
      const follow = (): void => {
        if (following) {
          return
        }
        following = true
        void follower
          .run()
          .catch((error: unknown) => {
            app.error(
              `Multihelm: taking over the master's vessel settings: ${error instanceof Error ? error.message : String(error)}`
            )
          })
          .finally(() => {
            following = false
            showRole()
          })
      }
      const followTimer = setInterval(follow, ROUND_INTERVAL_MS)
      const stopRoleFollow = mh.onRoleChanged(follow)
      const history =
        settings.historyFromMaster !== false && canWithdrawHistoryProvider(app)
          ? new MasterHistory({
              registerMasterRoute: (prefix) => proxy.register(prefix),
              fetchMaster: (target) => proxy.fetch(target),
              hasMaster: () => mh.masterAccess() !== null,
              register: (provider) => {
                app.registerHistoryApiProvider(provider)
              },
              unregister: () => {
                app.unregisterHistoryApiProvider()
              },
              debug: (msg) => {
                app.debug(msg)
              }
            })
          : null
      const checkHistory = (): void => {
        history?.check().catch((error: unknown) => {
          app.error(
            `Multihelm: serving the master's history: ${error instanceof Error ? error.message : String(error)}`
          )
        })
      }
      const historyTimer = setInterval(checkHistory, ROUND_INTERVAL_MS)
      const stopRoleHistory = mh.onRoleChanged(checkHistory)
      checkHistory()
      stopFollowing = () => {
        clearInterval(followTimer)
        stopRoleFollow()
        clearInterval(historyTimer)
        stopRoleHistory()
        history?.stop()
      }
      stopRoleStatus = mh.onStatusChanged(showRole)
      showRole()
    },

    stop() {
      stopFollowing?.()
      stopFollowing = null
      stopRoleStatus?.()
      stopRoleStatus = null
      if (multihelm) {
        publish({ apiVersion: API_VERSION })
      }
      multihelm?.stop()
      multihelm = null
      masterProxy?.stop()
      masterProxy = null
      discovery?.stop()
      discovery = null
    },

    registerWithRouter(router) {
      registerRoutes(
        router,
        () => multihelm,
        () => discovery?.list() ?? [],
        localVesselSettings,
        () => masterProxy
      )
    }
  }
}
