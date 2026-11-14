# Signal K Multihelm

Signal K server plugin that keeps the servers of one boat in step: it finds
and pairs them, replicates the datasets other plugins register (with no
master), and tells plugins which server is the boat's master, which the user
sets by hand on one server (see `README.md`).

## Module map (`src/`)

- `index.ts` — plugin lifecycle; publishes the `multihelm` PropertyValue.
- `api.ts` — the API other plugins use. Additive changes only; `apiVersion`
  changes only with a change consumers must know about.
- `multihelm.ts` — `Multihelm`: datasets, rounds with each peer, serving,
  pairing. All work goes through one queue.
- `library.ts` — pure version rules: listing → versions and tombstones,
  manifests, recording a peer's entry.
- `store.ts` — state in the data dir: server id, peers (mode 0600, they hold
  tokens), one library per dataset.
- `peer-client.ts` — HTTP to peers: hello, manifest, file with `Range`
  resume, device access requests.
- `routes.ts` — readonly `hello`/`manifest`/`file` and `master/*` via
  `router.access`; admin `status`, `peers`, `run`.
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
- `follow-master.ts` — `MasterFollower`: on a member, takes those over from
  the master and writes what differs through this server's own REST API
  (`/skServer/vessel`, meta PUT/DELETE, `/skServer/priorities`) with an
  admin device token on itself.

## Contracts other software depends on

- **The `multihelm` PropertyValue and `api.ts` types.** Consumers act on the
  last value; `{ apiVersion: 1 }` without methods means stopped.
- **Peer routes and their JSON** (`hello`, `manifest`, `file`,
  `vessel-settings`) between
  servers that may run different Multihelm versions: grow by addition and
  bump `PROTOCOL` only for a breaking change.
- **The master** is the server set to be it with the smallest server id,
  among this one and the paired peers whose `hello` said `master: true`
  within `MASTER_STALE_MS`. Every server must reach the same answer.
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
- `npm run typecheck` — tsc over `src/` and `test/`
- `npm run build` — Vite → `plugin/index.js`; type errors fail it
- `npm test` — vitest
- `npm run build:all` — all of the above, run before every commit

## Workflow

- Conventional commits and PR titles: `<type>(<scope>): <subject>`.
- One logical change per PR. Never bump the version by hand; release-please.
- Branch names use hyphens, no `/`.
- No AI attribution in commits or PRs.
