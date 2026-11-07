# Multihelm

Keeps several Signal K servers on one boat in step, one per nav station,
without depending on a single one. Every server holds a full copy of what is
replicated and works on its own; when one is off, the others carry on, and it
catches up when it comes back.

![A master server shares vessel data, metadata and services with the other servers, which replicate charts among themselves; each server may have its own NMEA 2000 connection](docs/screenshots/overview.png)

Multihelm owns the membership (finding and pairing the boat's servers) and the
transport. Other plugins register what they want replicated as a _dataset_.
The first one is
[signalk-charts-provider-simple](https://github.com/dirkwa/signalk-charts-provider-simple):
chart files and shared ENC cells.

## Pairing

Install Multihelm on every server. On one of them, open the plugin's page,
pick another server from the list of servers found on the network (or enter
its address) and pair. On a server with security, approve the request once
under **Security → Access Requests** there. Pair each pair of servers once;
every plugin that uses Multihelm shares that pairing.

Needs Signal K server 2.31 or later: peers read the replication routes with a
readonly device token.

Multihelm is enabled when it is installed.

## The master

Set **This server is the boat's master** in the plugin settings of one
server. Plugins that work on one server only (a weather router, rules,
alarms to NMEA 2000) run on the master, and the other servers use them
through it; replicated datasets do not need a master. Every server asks its
paired peers every 30 seconds whether they are set to be the master, apart
from the transfers, and a master that has not answered for two and a half
minutes no longer counts.
When several servers are set, the one with the smallest server id is the
master, and the plugin status says to set one only.

## Vessel data and metadata from the master

The vessel is described once, on the master. The other servers take over its
vessel data from **Server -> Settings** (name, MMSI, call sign, length, beam,
draft, air height, ship type) and the metadata set for paths (display names,
units, zones, alarm limits), and follow every change once a minute. A change
made on another server is replaced by the master's. GPS antenna positions
stay with each server. Each of the two can be turned off per server in the
plugin settings.

To write them so they survive a restart, Multihelm asks its own server once
for admin access: approve it under **Security -> Access Requests** on each
server that is not the master (the plugin status says so while it waits). A
server without security needs nothing. A new MMSI takes effect on that server
at its next restart, as when it is changed by hand.

## Using the master's services

A plugin can let the other servers serve what the master provides, without a
copy of their own: charts, for example. Each server then answers at
`/plugins/signalk-multihelm/master/<path>` with the master's answer, so a
browser at a station only ever talks to its own server, with its own login.

Only GET requests are forwarded, only to the paired master, and only under
the paths a plugin registered; admin and login routes never are. The master
is asked with the readonly pairing token, never with the caller's
credentials, and the route follows this server's own security: whoever may
not read here cannot read through it either. While no other server is the
master, it answers 503.

## How replication works

- Each entry of a dataset carries a counter and the server that last changed
  it. A change takes the counter one past the current one; two servers
  changing the same entry unseen tie, and the higher server id wins. Every
  server reaches the same result without a master and without clocks.
- Deletions are kept as tombstones for 30 days, so a server that was off
  follows them when it comes back.
- Files are checked by size and SHA-256, fetched with resume, and offered
  only once they have not changed for 30 seconds.
- Every server asks each paired peer for changes once a minute, and sooner
  when a plugin reports a change.

## For plugin authors

Multihelm publishes its API as the PropertyValue `multihelm`:
`{ apiVersion: 1, registerDataset, peers, serverId, role, master, onRoleChanged, registerMasterRoute, masterPath, fetchMaster }`
from its start, and
`{ apiVersion: 1 }` after its stop. Follow the last value, register your
datasets whenever the methods appear, and unregister in your own `stop()`.
The types are in [`src/api.ts`](src/api.ts). A plugin that runs on the master
only starts its work when `role()` is `'master'` and follows `onRoleChanged`.
A plugin that serves the master's data on the other servers registers the
path prefix it needs with `registerMasterRoute('/signalk/v1/api/resources/charts/')`,
hands browsers `masterPath(path)` and reads the master itself with
`fetchMaster(path)`.

```ts
app.onPropertyValues('multihelm', (values) => {
  const mh = values.at(-1)?.value
  handle?.unregister()
  handle = mh?.registerDataset?.({
    id: 'my-plugin/things',
    list: async () => [...],     // what this server holds now
    apply: async (entry) => {},  // take over a peer's entry (verified files)
    remove: async (key) => true  // a peer deleted it; false keeps it here
  })
})
```

## License

Apache-2.0
