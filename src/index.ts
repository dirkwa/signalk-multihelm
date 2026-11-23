import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  Context,
  Path,
  Plugin,
  ServerAPI,
  SubscribeCallback,
  SubscribeMessage,
  Unsubscribes
} from '@signalk/server-api'

import {
  API_VERSION,
  PROPERTY_NAME,
  type MultihelmProperty,
  type PeerInfo,
  type Role
} from './api.js'
import { MasterAlarms, managedNotifications } from './alarms-from-master.js'
import { MasterAutopilot } from './autopilot-from-master.js'
import { MasterControlAccess } from './master-control.js'
import { MasterCourse } from './course-from-master.js'
import { ServerDiscovery } from './discovery.js'
import { ConfigSchema } from './config.js'
import { MasterFollower } from './follow-master.js'
import { MasterOnlyPlugins, PluginList } from './master-plugins.js'
import { MasterHistory, canWithdrawHistoryProvider } from './history-from-master.js'
import { MASTER_ROUTE, MasterProxy } from './master-proxy.js'
import { Multihelm, ROUND_INTERVAL_MS } from './multihelm.js'
import { ROUTE_PREFIX } from './peer-client.js'
import { registerRoutes } from './routes.js'
import type { OwnAccessState } from './status.js'
import { hasResourcesApi, resourceOfPath, resourcesDataset } from './resources-dataset.js'
import { OwnServerAccess } from './own-access.js'
import { SHARED_PLUGINS_DATASET, SHARED_PLUGINS_KEY, SharedPluginConfig } from './shared-config.js'
import { MultihelmStore } from './store.js'
import { sourcePrioritiesFromSettings } from './source-priorities.js'
import { vesselSettingsFromDeltas, type VesselSettings } from './vessel-settings.js'

const PLUGIN_ID = 'signalk-multihelm'

/** The bundle and the sources both sit one folder below `package.json`. */
function multihelmVersion(): string | undefined {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const { version } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { version?: unknown }
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

type Config = {
  master?: unknown
  syncResources?: unknown
  followVessel?: unknown
  followMetadata?: unknown
  followSourcePriorities?: unknown
  historyFromMaster?: unknown
  autopilotFromMaster?: unknown
  courseFromMaster?: unknown
  alarmsFromMaster?: unknown
}

const APPROVE_HINT =
  "approve Multihelm's request under Security -> Access Requests on this server to take the vessel settings over and switch the plugins that run on the master"

const DENIED_HINT =
  'the access request on this server was denied, so the vessel settings are not taken over and no plugin is switched for the master; restart the plugin to ask again'

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
    version?: string
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

/** Registering is plugin API; withdrawing before the plugin stops is reached on the server's own autopilot API. */
function autopilotWithdrawal(app: ServerAPI): (() => void) | null {
  const api = (app as { autopilotApi?: { unRegister?: unknown } }).autopilotApi
  const unRegister = api?.unRegister
  if (typeof app.registerAutopilotProvider !== 'function' || typeof unRegister !== 'function') {
    return null
  }
  return () => {
    unRegister.call(api, PLUGIN_ID)
  }
}

/** The server takes the source policy of a plugin's subscription as an argument, not from the command. */
interface SourcePolicySubscriptions {
  subscribe: (
    command: SubscribeMessage,
    unsubscribes: Unsubscribes,
    errorCallback: (err: unknown) => void,
    callback: SubscribeCallback,
    user: string | undefined,
    sourcePolicy: 'all'
  ) => void
}

export default function (app: ServerAPI): Plugin {
  const host = app as Host
  let multihelm: Multihelm | null = null
  let discovery: ServerDiscovery | null = null
  let masterProxy: MasterProxy | null = null
  let stopRoleStatus: (() => void) | null = null
  let stopFollowing: (() => void) | null = null
  let ownAccess: OwnServerAccess | null = null
  let masterPluginList: PluginList | null = null
  let sharedPlugins: { list: PluginList; config: SharedPluginConfig } | null = null
  let masterControl: MasterControlAccess | null = null

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

  function ownAccessState(): OwnAccessState {
    if (ownAccess?.waitingForApproval()) {
      return { state: 'waiting-approval', request: ownAccess.requestId() }
    }
    return ownAccess?.denied() ? { state: 'denied' } : null
  }

  /** Deletions are learnt from the server's deltas: only they show that one was stored. */
  function syncResources(mh: Multihelm): () => void {
    const sync = resourcesDataset({
      list: (type) => app.resourcesApi.listResources(type, {}),
      set: (type, id, resource) => app.resourcesApi.setResource(type, id, resource),
      delete: (type, id) => app.resourcesApi.deleteResource(type, id),
      mirrorDir: path.join(app.getDataDirPath(), 'resources'),
      debug: (msg) => {
        app.debug(msg)
      },
      error: (msg) => {
        app.error(msg)
      }
    })
    const handle = mh.registerDataset(sync.dataset)
    const unsubscribes: Unsubscribes = []
    ;(app.subscriptionmanager as SourcePolicySubscriptions).subscribe(
      {
        context: 'vessels.self' as Context,
        subscribe: [{ path: 'resources.*' as Path, policy: 'instant' }]
      },
      unsubscribes,
      (error) => {
        app.error(`Multihelm: following resource deletions: ${String(error)}`)
      },
      (delta) => {
        for (const update of delta.updates) {
          for (const { path: valuePath, value } of 'values' in update ? update.values : []) {
            const resource = resourceOfPath(valuePath)
            if (resource && value !== null) {
              sync.written(resource.type, resource.id)
            } else if (resource) {
              sync.deleted(resource.type, resource.id).then(
                () => {
                  handle.changed()
                },
                (error: unknown) => {
                  app.error(
                    `Multihelm: cannot follow the deletion of ${resource.type}/${resource.id}: ${error instanceof Error ? error.message : String(error)}`
                  )
                }
              )
            }
          }
        }
      },
      undefined,
      'all'
    )
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      handle.unregister()
    }
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
        versions: () => ({ signalk: host.config?.version, multihelm: multihelmVersion() }),
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
      const stopResources =
        settings.syncResources !== false && hasResourcesApi(app) ? syncResources(mh) : null
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
      const access = new OwnServerAccess({
        store,
        serverId: mh.serverId,
        ownUrl,
        debug: (msg) => {
          app.debug(msg)
        }
      })
      ownAccess = access
      const masterPlugins = new MasterOnlyPlugins({
        ids: () => pluginList.ids(),
        // Nothing is switched before the role is known, nor on a server with no master to defer to.
        wanted: () =>
          !mh.roleKnown() ? null : mh.role() === 'master' ? true : mh.master() ? false : null,
        access,
        ownUrl,
        selfId: PLUGIN_ID,
        debug: (msg) => {
          app.debug(msg)
        },
        error: (msg) => {
          app.error(msg)
        }
      })
      const pluginList = new PluginList(path.join(app.getDataDirPath(), 'master-plugins'), () => {
        masterPlugins.apply()
        settingsHandle.changed()
      })
      const settingsHandle = mh.registerDataset(pluginList.dataset)
      masterPluginList = pluginList
      const sharedConfig = new SharedPluginConfig({
        ids: () => sharedList.ids(),
        access,
        ownUrl,
        selfId: PLUGIN_ID,
        dir: path.join(app.getDataDirPath(), 'plugin-config'),
        debug: (msg) => {
          app.debug(msg)
        },
        error: (msg) => {
          app.error(msg)
        }
      })
      const sharedList = new PluginList(
        path.join(app.getDataDirPath(), 'shared-plugins'),
        () => {
          sharedListHandle.changed()
          sharedConfigHandle.changed()
        },
        SHARED_PLUGINS_DATASET,
        SHARED_PLUGINS_KEY
      )
      const sharedListHandle = mh.registerDataset(sharedList.dataset)
      const sharedConfigHandle = mh.registerDataset(sharedConfig.dataset)
      sharedPlugins = { list: sharedList, config: sharedConfig }
      const pluginsTimer = setInterval(() => {
        masterPlugins.apply()
      }, ROUND_INTERVAL_MS)
      const stopRolePlugins = mh.onRoleChanged(() => {
        masterPlugins.apply()
      })
      const follower = new MasterFollower({
        store,
        access,
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
        if (access.waitingForApproval()) {
          app.setPluginStatus(`${text}; ${APPROVE_HINT}`)
        } else if (access.denied()) {
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
      const control = new MasterControlAccess({
        store,
        serverId: mh.serverId,
        currentMaster: () => (mh.role() === 'master' ? null : (mh.master()?.id ?? null)),
        debug: (msg) => {
          app.debug(msg)
        }
      })
      masterControl = control
      const withdrawAutopilot = autopilotWithdrawal(app)
      const autopilot =
        settings.autopilotFromMaster !== false && withdrawAutopilot
          ? new MasterAutopilot({
              control,
              master: () => {
                const access = mh.masterAccess()
                const master = mh.master()
                return access && master ? { id: master.id, access } : null
              },
              isMaster: () => mh.role() === 'master',
              register: (provider, devices) => {
                app.registerAutopilotProvider(provider, devices)
              },
              unregister: withdrawAutopilot,
              update: (device, info) => {
                app.autopilotUpdate(device, info)
              },
              debug: (msg) => {
                app.debug(msg)
              },
              error: (msg) => {
                app.error(msg)
              }
            })
          : null
      autopilot?.start()
      const course =
        settings.courseFromMaster !== false
          ? new MasterCourse({
              master: () => {
                const masterAccess = mh.masterAccess()
                const master = mh.role() === 'master' ? null : mh.master()
                return masterAccess && master ? { id: master.id, access: masterAccess } : null
              },
              control,
              own: access,
              ownUrl,
              debug: (msg) => {
                app.debug(msg)
              }
            })
          : null
      course?.start()
      const notifications = managedNotifications(app.notifications)
      const alarms =
        settings.alarmsFromMaster !== false && notifications
          ? new MasterAlarms({
              master: () => {
                const masterAccess = mh.masterAccess()
                const master = mh.role() === 'master' ? null : mh.master()
                return masterAccess && master ? { id: master.id, access: masterAccess } : null
              },
              control,
              notifications,
              debug: (msg) => {
                app.debug(msg)
              }
            })
          : null
      alarms?.start()
      const stopRoleAutopilot = mh.onRoleChanged(() => {
        autopilot?.roleChanged()
      })
      const historyTimer = setInterval(checkHistory, ROUND_INTERVAL_MS)
      const stopRoleHistory = mh.onRoleChanged(checkHistory)
      checkHistory()
      stopFollowing = () => {
        clearInterval(pluginsTimer)
        stopRolePlugins()
        settingsHandle.unregister()
        stopRoleAutopilot()
        autopilot?.stop()
        course?.stop()
        alarms?.stop()
        clearInterval(followTimer)
        stopRoleFollow()
        clearInterval(historyTimer)
        stopRoleHistory()
        history?.stop()
        stopResources?.()
      }
      stopRoleStatus = mh.onStatusChanged(showRole)
      showRole()
    },

    stop() {
      stopFollowing?.()
      stopFollowing = null
      ownAccess = null
      masterPluginList = null
      sharedPlugins = null
      masterControl = null
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
        () => masterProxy,
        ownAccessState,
        () => masterPluginList,
        () => masterControl?.waitingForApproval(multihelm?.role() === 'master') ?? null,
        () => sharedPlugins
      )
    }
  }
}
