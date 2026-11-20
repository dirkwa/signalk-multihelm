# Signal K Multihelm

Signal K server plugin that keeps the servers of one boat in step: it finds
and pairs them, replicates the datasets other plugins register (with no
master), and tells plugins which server is the boat's master, which the user
sets by hand on one server (see `README.md`).

## Module map (`src/`)

- `index.ts` — plugin lifecycle; publishes the `multihelm` PropertyValue.
- `config.ts` — the settings schema; the panel uses its type.
- `status.ts` — the `status` route's JSON, which the panel reads.
- `api.ts` — the API other plugins use. Additive changes only; `apiVersion`
  changes only with a change consumers must know about.
- `multihelm.ts` — `Multihelm`: datasets, rounds with each peer, serving,
  pairing. All work goes through one queue.
- `library.ts` — pure version rules: listing → versions and tombstones,
  manifests, recording a peer's entry.
- `store.ts` — state in the data dir: server id, peers (mode 0600, they hold
  tokens), one library per dataset, the paths whose metadata follows the
  master, the servers paired with this one.
- `peer-client.ts` — HTTP to peers: hello, manifest, file with `Range`
  resume, device access requests. `locatePeer()` works out, when pairing,
  the HTTPS address an HTTP one leads to and the certificate to trust a
  server by that no known CA vouches for; peers keep it as `ca`.
- `routes.ts` — readonly `hello`/`manifest`/`file` and `master/*` via
  `router.access`; admin `status`, `peers`, `paired-by`, `run`, `master-plugins`, `shared-plugins`. `hello`
  notes the server asking, from its query.
- `master-proxy.ts` — `MasterProxy`: on a member, serves the master's GET
  answers under the prefixes plugins registered, with the pairing token.
- `history-from-master.ts` — `MasterHistory`: on a member, a History API
  provider that reads the master's, registered only while the master has
  one.
- `discovery.ts` — mDNS browse for `_signalk-http(s)._tcp`.
- `vessel-settings.ts` — the vessel data and path metadata the user set,
  read from the server's base deltas (`app.config.baseDeltaEditor`).
- `source-priorities.ts` — the source priorities the user set, in the shape
  of `/skServer/priorities`, read from `app.config.settings`; peers get them
  in `vessel-settings`.
- `resources-dataset.ts` — the `signalk-multihelm/resources` dataset:
  routes, waypoints, regions and notes through `app.resourcesApi`, one
  mirror file each under the data dir; waits for a write to be stored. A
  listing only adds and updates: the Resources API drops failing providers
  from it, so deletions come from the server's null deltas on
  `resources.<type>.<id>`.
- `follow-master.ts` — `MasterFollower`: on a member, takes those over from
  the master and writes what differs through this server's own REST API
  (`/skServer/vessel`, meta PUT/DELETE, `/skServer/priorities`) with an
  admin device token on itself.
- `own-access.ts` — `OwnServerAccess`: the admin device token on this
  server itself, asked for once, for what Multihelm writes through its REST
  API.
- `master-plugins.ts` — the plugins that run on the master only: the list
  (`PluginList`), kept in step as the `signalk-multihelm/settings` dataset, and
  `MasterOnlyPlugins`, which switches them through `/plugins/<id>/config`
  once the role is known, and not at all while no master is found.
- `shared-config.ts` — `SharedPluginConfig`: the
  `signalk-multihelm/plugin-config` dataset, one entry per plugin on the
  `signalk-multihelm/shared-plugins` list (a `PluginList`), its file the
  plugin's `configuration`, read and written through `/plugins/<id>/config`
  with the own admin token. Only the server where a plugin was added offers
  it at first (`seed`); the others wait for a peer's copy.
- `master-control.ts` — `MasterControlAccess`: this server's readwrite
  device token on the master, for the commands a station sends there; one
  request at a time, kept per master.
- `autopilot-from-master.ts` — `MasterAutopilot`: on a member, registers
  as the autopilot provider for the master's devices and sends every command
  to the master's Autopilot API with the control token there (asked
  for when an autopilot is first found); publishes the master's state each
  second. Steps aside (`autopilotApi.unRegister`) the moment this server
  becomes the master, before its own provider starts.
- `course-from-master.ts` — `MasterCourse`: on a member, keeps the course
  (destination or route with its point, arrival circle, arrival time) the
  same as the master's through both Course APIs each second: a change made
  here alone goes to the master with the control token, anything else takes
  the master's over with the own admin token. The setting is compared and
  written, never the action, so arrivals do not advance twice.
- `alarms-from-master.ts` — `MasterAlarms`: on a member, raises each active
  alarm of the master through `app.notifications`, marked with
  `data.multihelmMaster`, unless this server has an alarm of its own on the
  path; silence and acknowledge go both ways, the master's with the control
  token. Matched by path, since notification ids are per server.
- `configpanel/` — the settings panel the admin UI shows in place of the
  schema form (Module Federation, `vite.panel.config.ts`): pairing, peers,
  the role, the settings. It uses the admin UI's React through
  `host-shim/`, never a copy of its own, and reaches the server modules by
  type imports only. `view.ts` holds what can be tested without a browser.

## Contracts other software depends on

- **The `multihelm` PropertyValue and `api.ts` types.** Consumers act on the
  last value; `{ apiVersion: 1 }` without methods means stopped.
- **Peer routes and their JSON** (`hello`, `manifest`, `file`,
  `vessel-settings`) between
  servers that may run different Multihelm versions: grow by addition and
  bump `PROTOCOL` only for a breaking change. A server asking for `hello`
  says who it is in the query (`from`, `name`, `signalk`, `multihelm`),
  which older peers ignore.
- **The master** is the server set to be it with the smallest server id,
  among this one and the paired peers whose `hello` said `master: true`
  within `MASTER_STALE_MS`. While none has said so within `TAKEOVER_MS`,
  it is the server with the lowest `standby` place. Once any server may take
  over, a server counts a master only while it sees most of the paired
  servers (a tie goes to the side with the one set by hand), and it acts as
  the master only once no peer's `hello` says `acting` (older peers: `master`).
  A server acts until its master-only plugins have stopped. Taking over needs
  `TAKEOVER_MS` without a master answer since this server's start, every
  paired peer saying `acting`, and most servers' `elects` votes; a peer's
  `standby` is kept in the peers file so a restart still knows.
  Every server must reach the same answer.
- **A file is served only if its dataset lists it**, and only while it still
  has the size and time that were hashed.
- **`master/*` forwards only** GET, only to the paired master, only under a
  registered prefix, with the pairing token and none of the caller's
  credentials; admin and access routes are never registrable. It sits
  behind this server's own security, so it gives no one more than they may
  read here.

## Gotchas

- **Schema defaults are not applied at runtime**: `start()` gets `{}` for a
  plugin never configured, so `master` counts only when it is `true`.
- **No install scripts.** Runtime dependencies stay pure JS (`typebox`,
  `multicast-dns`).
- **ESM.** Relative imports carry the `.js` extension; the entry is
  `export default function (app)`.
- **Files a round just received are new**, so an entry whose files changed
  waits the settle time before it goes out again; a change of meta alone
  does not wait.

## Code style

- **Code explains itself.** Names and small functions carry the meaning;
  a comment says why, never what, and only where the code cannot. No
  docstrings for their own sake, no long or echo comments.

## Commands

- `npm run format` — prettier + eslint --fix
- `npm run ci-lint` — read-only lint + format check (what CI runs)
- `npm run typecheck` — tsc over `src/` and `test/`, and over the panel
- `npm run build` — Vite → `plugin/index.js` and the panel → `public/`; type
  errors fail it
- `npm test` — vitest
- `npm run build:all` — all of the above, run before every commit

## Workflow

- Conventional commits and PR titles: `<type>(<scope>): <subject>`.
- One logical change per PR. Never bump the version by hand; release-please.
- Branch names use hyphens, no `/`.
- No AI attribution in commits or PRs.
