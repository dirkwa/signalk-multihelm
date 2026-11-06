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
import { Multihelm } from './multihelm.js'
import { registerRoutes } from './routes.js'
import { MultihelmStore } from './store.js'

const PLUGIN_ID = 'signalk-multihelm'

const ConfigSchema = Type.Object({
  master: Type.Boolean({
    title: "This server is the boat's master",
    description:
      'Set this on one server only. Plugins that run on the master alone run here, and the other servers use them through this one.',
    default: false
  })
})

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
  config?: { getExternalPort?: () => number }
}

export default function (app: ServerAPI): Plugin {
  const host = app as Host
  let multihelm: Multihelm | null = null
  let discovery: ServerDiscovery | null = null
  let stopRoleStatus: (() => void) | null = null

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
      const isMaster = (config as { master?: unknown }).master === true
      const mh = new Multihelm(new MultihelmStore(app.getDataDirPath()), {
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
        onRoleChanged: (cb) => mh.onRoleChanged(cb)
      })
      const showRole = (role: Role, master: PeerInfo | null): void => {
        app.setPluginStatus(statusText(role, master, mh.masterConflict()))
      }
      stopRoleStatus = mh.onRoleChanged(showRole)
      showRole(mh.role(), mh.master())
    },

    stop() {
      stopRoleStatus?.()
      stopRoleStatus = null
      if (multihelm) {
        publish({ apiVersion: API_VERSION })
      }
      multihelm?.stop()
      multihelm = null
      discovery?.stop()
      discovery = null
    },

    registerWithRouter(router) {
      registerRoutes(
        router,
        () => multihelm,
        () => discovery?.list() ?? []
      )
    }
  }
}
