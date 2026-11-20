import { Type, type Static } from 'typebox'

export const ConfigSchema = Type.Object({
  master: Type.Boolean({
    title: "This server is the boat's master",
    description:
      'Set this on one server only. Plugins that run on the master alone run here, and the other servers use them through this one.',
    default: false
  }),
  takeOver: Type.Integer({
    title: 'Take over as master when the master is gone (order, 0 = never)',
    description:
      "While no server set to be the master has been reachable for three and a half minutes, the server with the lowest number here takes over, as long as it reaches most of the boat's servers. Give the servers that may take over different numbers.",
    minimum: 0,
    maximum: 9,
    default: 0
  }),
  syncResources: Type.Boolean({
    title: 'Keep routes and waypoints in step',
    description:
      'Routes, waypoints, regions and notes, kept the same on every server of the boat: a change on one reaches the others, with no master.',
    default: true
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
  }),
  autopilotFromMaster: Type.Boolean({
    title: "Operate the master's autopilot from this server",
    description:
      "This server's Autopilot API serves the master's autopilot, so a chartplotter here operates it, while only the master sends to it. Put the autopilot provider plugin on the list of plugins that run on the master only. Does nothing on the master.",
    default: true
  }),
  courseFromMaster: Type.Boolean({
    title: 'Keep the course the same as on the master',
    description:
      "This server takes the master's active destination or route over, and a destination or route set here is sent to the master, so every station follows the same course. Does nothing on the master.",
    default: true
  }),
  alarmsFromMaster: Type.Boolean({
    title: "Show the master's alarms here",
    description:
      'Every active alarm on the master also sounds here, and silencing or acknowledging an alarm here does it on the master and every other station. An alarm this server raises itself on the same path is not shown twice. Does nothing on the master, or on a server without the Notifications API or with notification management off.',
    default: true
  })
})

/** The settings as stored; any of them may be missing (see `start()`). */
export type Settings = Partial<Static<typeof ConfigSchema>>
