import { Type, type Static } from 'typebox'

export const ConfigSchema = Type.Object({
  master: Type.Boolean({
    title: "This server is the boat's master",
    description:
      'Set this on one server only. Plugins that run on the master alone run here, and the other servers use them through this one.',
    default: false
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
  })
})

/** The settings as stored; any of them may be missing (see `start()`). */
export type Settings = Partial<Static<typeof ConfigSchema>>
