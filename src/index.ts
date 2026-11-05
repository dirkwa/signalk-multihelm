import os from 'node:os'

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { Type } from 'typebox'

import { API_VERSION, PROPERTY_NAME, type MultihelmProperty } from './api.js'
import { ServerDiscovery } from './discovery.js'
import { Multihelm } from './multihelm.js'
import { registerRoutes } from './routes.js'
import { MultihelmStore } from './store.js'

const PLUGIN_ID = 'signalk-multihelm'

/** The parts of the server the typed API leaves out. */
type Host = ServerAPI & {
  config?: { getExternalPort?: () => number }
}

export default function (app: ServerAPI): Plugin {
  const host = app as Host
  let multihelm: Multihelm | null = null
  let discovery: ServerDiscovery | null = null

  function publish(value: MultihelmProperty): void {
    app.emitPropertyValue(PROPERTY_NAME, value)
  }

  return {
    id: PLUGIN_ID,
    name: 'Multihelm',
    description: 'Keeps the Signal K servers of one boat in step, without a master',
    schema: () => Type.Object({}),

    start() {
      const mh = new Multihelm(new MultihelmStore(app.getDataDirPath()), {
        serverName: () => os.hostname(),
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
        serverId: () => mh.serverId
      })
      app.setPluginStatus('Running')
    },

    stop() {
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
