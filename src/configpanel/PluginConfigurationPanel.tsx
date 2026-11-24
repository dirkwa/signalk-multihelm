import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'

import type { PeerInfo } from '../api.js'
import type { Settings } from '../config.js'
import type { AppElsewhere, AppsReport } from '../installed-apps.js'
import { InstallWatch, type WatchedState } from './install-watch.js'
import type { PairedByInfo, Status } from '../status.js'
import {
  accessRequestsUrl,
  ago,
  appInstallUrl,
  installErrorText,
  newestVersion,
  serversText,
  approveAccessUrl,
  approveErrorText,
  connectionIds,
  pathsFromText,
  peerName,
  roleNotice,
  unpairedServers,
  versionText
} from './view.js'

const BASE = '/plugins/signalk-multihelm'
const POLL_MS = 3_000
const OWN_ACCESS = 'own-access'

interface Props {
  configuration?: Settings
  save: (configuration: Settings) => void
}

async function call(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  const body = (await res.json().catch(() => ({}))) as { error?: unknown }
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(res.status)}`)
  }
  return body
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withDefaults(configuration: Settings | undefined): Required<Settings> {
  return {
    master: configuration?.master === true,
    takeOver:
      typeof configuration?.takeOver === 'number' && configuration.takeOver > 0
        ? configuration.takeOver
        : 0,
    syncResources: configuration?.syncResources !== false,
    followVessel: configuration?.followVessel !== false,
    followMetadata: configuration?.followMetadata !== false,
    followSourcePriorities: configuration?.followSourcePriorities !== false,
    historyFromMaster: configuration?.historyFromMaster !== false,
    autopilotFromMaster: configuration?.autopilotFromMaster !== false,
    courseFromMaster: configuration?.courseFromMaster !== false,
    alarmsFromMaster: configuration?.alarmsFromMaster !== false,
    sharePaths: configuration?.sharePaths ?? [],
    shareConnections: configuration?.shareConnections ?? [],
    takeSharedData: configuration?.takeSharedData !== false
  }
}

export default function PluginConfigurationPanel({ configuration, save }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ key: string; text: string } | null>(null)
  const [address, setAddress] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus((await call(`${BASE}/status`)) as Status)
      setLoadError(null)
    } catch (error) {
      setLoadError(errorText(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [refresh])

  const act = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key)
    setActionError(null)
    try {
      await action()
      return true
    } catch (error) {
      setActionError({ key, text: errorText(error) })
      return false
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const pair = (url: string): Promise<boolean> =>
    act(url, () =>
      call(`${BASE}/peers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
    )

  const unpair = (peer: PeerInfo, name: string): void => {
    if (!window.confirm(`Stop keeping this server in step with ${name}?`)) {
      return
    }
    void act(peer.url, () =>
      call(`${BASE}/peers?url=${encodeURIComponent(peer.url)}`, { method: 'DELETE' })
    )
  }

  const forget = (server: PairedByInfo): void => {
    if (
      !window.confirm(
        `Take ${server.name} off this list? It comes back once it asks this server again.`
      )
    ) {
      return
    }
    void act(server.id, () =>
      call(`${BASE}/paired-by?id=${encodeURIComponent(server.id)}`, { method: 'DELETE' })
    )
  }

  const allow = (request: string): void => {
    void act(OWN_ACCESS, () =>
      call(approveAccessUrl(request), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: 'admin' })
      }).catch((error: unknown) => {
        throw new Error(approveErrorText(errorText(error)))
      })
    )
  }

  const pairAddress = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault()
    if (address.trim() !== '' && (await pair(address.trim()))) {
      setAddress('')
    }
  }

  return (
    <div>
      {loadError && (
        <div className="alert alert-danger">
          Cannot read Multihelm's status: {loadError}
          {status && '. What is shown below may be out of date.'}
        </div>
      )}
      {status && (
        <StatusNotices
          status={status}
          allowing={busy === OWN_ACCESS}
          allowError={actionError?.key === OWN_ACCESS ? actionError.text : null}
          onAllow={allow}
        />
      )}
      {status?.running && (
        <>
          {status.role === 'master' && (
            <PairedByCard status={status} busy={busy} onForget={forget} />
          )}
          <PeersCard status={status} busy={busy} onPair={pair} onUnpair={unpair} />
          {status.role !== 'master' && status.pairedBy.length > 0 && (
            <PairedByCard status={status} busy={busy} onForget={forget} />
          )}
          <AppsCard />
          <PluginListCard
            title="Plugins that run on the master only"
            description="These plugins run on the boat's master and are stopped on the other servers, for example an autopilot provider, so only one server sends its commands. The list is the same on every server; when another server becomes the master, they move there."
            name="master-plugins"
            current={status.masterPlugins}
            onSaved={refresh}
          />
          <PluginListCard
            title="Plugins with the same settings on every server"
            description="The settings of these plugins, such as a buddy list, are kept the same on every server; whether a plugin runs stays each server's own. Add a plugin on the server that has the settings you want: the others take them over. After that, a change on any server goes to all."
            name="shared-plugins"
            current={status.sharedPlugins}
            onSaved={refresh}
          />
          <div className="card mb-3">
            <div className="card-header">Pair with another server</div>
            <div className="card-body">
              <p className="small text-body-secondary">
                {status.role === 'master'
                  ? 'The other servers pair with this one in their own Multihelm settings. Pair this one with another only to replicate charts both ways.'
                  : "Each server takes over what the servers it is paired with share. Pair this one with the boat's master; to replicate charts both ways, pair the other server with this one too."}
              </p>
              <FoundServers status={status} busy={busy} onPair={pair} />
              <form className="row g-2 mt-1" onSubmit={(e) => void pairAddress(e)}>
                <div className="col-sm">
                  <input
                    className="form-control"
                    value={address}
                    onChange={(e) => {
                      setAddress(e.target.value)
                    }}
                    placeholder="Or enter its address, e.g. 192.168.1.10 or helm.local:3000"
                    aria-label="Address of the other server"
                  />
                </div>
                <div className="col-sm-auto">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy !== null || address.trim() === ''}
                  >
                    {busy === address.trim() ? 'Pairing…' : 'Pair'}
                  </button>
                </div>
              </form>
              {actionError && actionError.key !== OWN_ACCESS && (
                <div className="alert alert-danger mt-3 mb-0">{actionError.text}</div>
              )}
            </div>
          </div>
        </>
      )}
      <SettingsCard configuration={configuration} save={save} />
    </div>
  )
}

function StatusNotices({
  status,
  allowing,
  allowError,
  onAllow
}: {
  status: Status
  allowing: boolean
  allowError: string | null
  onAllow: (request: string) => void
}) {
  const notice = roleNotice(status, Date.now())
  const own = status.ownAccess
  return (
    <>
      <div className={`alert alert-${notice.tone}`}>{notice.text}</div>
      {!status.available && (
        <div className="alert alert-danger">
          This Signal K server is older than 2.31, so the other servers cannot read from it. Update
          it.
        </div>
      )}
      {own?.state === 'waiting-approval' && (
        <div className="alert alert-warning">
          <p>
            <strong>One more step:</strong> Multihelm needs admin access to this server to write the
            master's vessel data, path metadata and source priorities here, and to start and stop
            the plugins that run on the master only.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={allowing}
            onClick={() => {
              onAllow(own.request)
            }}
          >
            {allowing ? 'Allowing…' : 'Allow'}
          </button>
          <div className="small mt-2">
            This approves Multihelm's own request under{' '}
            <a href="#/security/access/requests">Security → Access Requests</a>.
          </div>
          {allowError && <div className="text-danger mt-2">{allowError}</div>}
        </div>
      )}
      {status.controlAccess && (
        <div className="alert alert-warning">
          To operate the autopilot, set the course and acknowledge alarms from this station, approve
          Multihelm&apos;s request <code>{status.controlAccess.request}</code> under Security →
          Access Requests on the master, {status.master?.name ?? 'the master'}.
        </div>
      )}
      {own?.state === 'denied' && (
        <div className="alert alert-danger">
          The access request on this server was denied, so the vessel settings are not taken over
          from the master and no plugin is switched for the master. Save the settings below to ask
          again.
        </div>
      )}
    </>
  )
}

interface PeerActions {
  status: Status
  busy: string | null
  onPair: (url: string) => Promise<boolean>
}

function PeersCard({
  status,
  busy,
  onPair,
  onUnpair
}: PeerActions & { onUnpair: (peer: PeerInfo, name: string) => void }) {
  const now = Date.now()
  return (
    <div className="card mb-3">
      <div className="card-header">Paired servers</div>
      <div className="card-body">
        {status.peers.length === 0 ? (
          <p className="text-body-secondary mb-0">
            {status.role === 'master'
              ? 'This server takes nothing over from another.'
              : 'This server is not paired with another yet.'}
          </p>
        ) : (
          <table className="table table-sm align-middle mb-0">
            <tbody>
              {status.peers.map((peer) => {
                const name = peerName(peer, status.discovered)
                return (
                  <tr key={peer.url}>
                    <td>
                      <strong>{name}</strong>
                      {peer.master && <span className="badge text-bg-primary ms-2">master</span>}
                      <div className="small text-body-secondary">{peer.url}</div>
                      {versionText(peer) && (
                        <div className="small text-body-secondary">{versionText(peer)}</div>
                      )}
                    </td>
                    <td>
                      <PeerState peer={peer} name={name} status={status} now={now} />
                    </td>
                    <td className="text-end text-nowrap">
                      {peer.state === 'needs-pairing' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary me-2"
                          disabled={busy !== null}
                          onClick={() => void onPair(peer.url)}
                        >
                          Pair again
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        disabled={busy !== null}
                        onClick={() => {
                          onUnpair(peer, name)
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function PeerState({
  peer,
  name,
  status,
  now
}: {
  peer: PeerInfo
  name: string
  status: Status
  now: number
}) {
  return (
    <>
      {peer.state === 'paired' && (
        <>
          <OnlineBadge online={peer.online === true} />
          <span className="small text-body-secondary ms-2">seen {ago(peer.lastSeen, now)}</span>
        </>
      )}
      {peer.state === 'waiting-approval' && (
        <>
          <span className="badge text-bg-warning">Waiting for approval</span>
          <div className="small mt-1">
            On {name}, approve “Multihelm on {status.name}” under{' '}
            <a href={accessRequestsUrl(peer.url)} target="_blank" rel="noreferrer">
              Security → Access Requests
            </a>
            .
          </div>
        </>
      )}
      {peer.state === 'needs-pairing' && <span className="badge text-bg-danger">Not paired</span>}
      {peer.lastError && <div className="small text-danger mt-1">{peer.lastError}</div>}
    </>
  )
}

function OnlineBadge({ online }: { online: boolean }) {
  return online ? (
    <span className="badge text-bg-success">Online</span>
  ) : (
    <span className="badge text-bg-secondary">Offline</span>
  )
}

function PairedByCard({
  status,
  busy,
  onForget
}: {
  status: Status
  busy: string | null
  onForget: (server: PairedByInfo) => void
}) {
  const now = Date.now()
  return (
    <div className="card mb-3">
      <div className="card-header">Servers paired with this one</div>
      <div className="card-body">
        {status.pairedBy.length === 0 ? (
          <p className="text-body-secondary mb-0">
            No other server is paired with this one yet. Pair the others with it in their Multihelm
            settings.
          </p>
        ) : (
          <table className="table table-sm align-middle mb-0">
            <tbody>
              {status.pairedBy.map((server) => (
                <tr key={server.id}>
                  <td>
                    <strong>{server.name}</strong>
                    {versionText(server) && (
                      <div className="small text-body-secondary">{versionText(server)}</div>
                    )}
                  </td>
                  <td>
                    <OnlineBadge online={server.online} />
                    <span className="small text-body-secondary ms-2">
                      seen {ago(server.lastSeen, now)}
                    </span>
                  </td>
                  <td className="text-end">
                    {!server.online && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        disabled={busy !== null}
                        onClick={() => {
                          onForget(server)
                        }}
                      >
                        Forget
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function FoundServers({ status, busy, onPair }: PeerActions) {
  const servers = unpairedServers(status)
  if (servers.length === 0) {
    return (
      <p className="text-body-secondary">
        No other Signal K server that is not paired yet was found on the network.
      </p>
    )
  }
  return (
    <table className="table table-sm align-middle">
      <tbody>
        {servers.map((server) => (
          <tr key={server.url}>
            <td>
              <strong>{server.name}</strong>
              {server.vessel && (
                <span className="text-body-secondary ms-2">vessel {server.vessel}</span>
              )}
              <div className="small text-body-secondary">{server.url}</div>
            </td>
            <td className="text-end">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={() => void onPair(server.url)}
              >
                {busy === server.url ? 'Pairing…' : 'Pair'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface InstalledPlugin {
  id: string
  name: string
}

function installedPlugins(raw: unknown): InstalledPlugin[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .filter(
      (p): p is { id: string; name?: unknown } =>
        typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string'
    )
    .filter((p) => p.id !== 'signalk-multihelm')
    .map((p) => ({ id: p.id, name: typeof p.name === 'string' && p.name !== '' ? p.name : p.id }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

interface PluginListProps {
  title: string
  description: string
  /** The route that saves the list, and the prefix of the checkboxes' ids. */
  name: 'master-plugins' | 'shared-plugins'
  current: string[]
  onSaved: () => Promise<void>
}

function PluginListCard({ title, description, name, current, onSaved }: PluginListProps) {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null)
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [unticked, setUnticked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    call('/skServer/plugins').then(
      (raw) => {
        setPlugins(installedPlugins(raw))
      },
      (e: unknown) => {
        setError(`Cannot list the plugins: ${errorText(e)}`)
      }
    )
  }, [])

  const selected = chosen ?? current
  const unchanged = chosen === null || [...chosen].sort().join() === [...current].sort().join()
  const missing = [...new Set([...current, ...selected, ...unticked])].filter(
    (id) => !plugins?.some((p) => p.id === id)
  )

  const toggle = (id: string, on: boolean): void => {
    setChosen(on ? [...selected, id] : selected.filter((x) => x !== id))
    if (!on) {
      setUnticked([...unticked, id])
    }
  }

  const saveList = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await call(`${BASE}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugins: selected })
      })
      setChosen(null)
      setUnticked([])
      await onSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card mb-3">
      <div className="card-header">{title}</div>
      <div className="card-body">
        <p className="small text-body-secondary">{description}</p>
        {plugins === null && !error && <p className="text-body-secondary">Loading the plugins…</p>}
        {plugins?.map((plugin) => (
          <div className="form-check" key={plugin.id}>
            <input
              className="form-check-input"
              type="checkbox"
              id={`multihelm-${name}-${plugin.id}`}
              checked={selected.includes(plugin.id)}
              disabled={saving}
              onChange={(e) => {
                toggle(plugin.id, e.target.checked)
              }}
            />
            <label className="form-check-label" htmlFor={`multihelm-${name}-${plugin.id}`}>
              {plugin.name}
            </label>
          </div>
        ))}
        {plugins !== null &&
          missing.map((id) => (
            <div className="form-check" key={id}>
              <input
                className="form-check-input"
                type="checkbox"
                id={`multihelm-${name}-${id}`}
                checked={selected.includes(id)}
                disabled={saving}
                onChange={(e) => {
                  toggle(id, e.target.checked)
                }}
              />
              <label className="form-check-label" htmlFor={`multihelm-${name}-${id}`}>
                {id} <span className="text-body-secondary">(not installed here)</span>
              </label>
            </div>
          ))}
        <button
          type="button"
          className="btn btn-primary mt-3"
          disabled={saving || unchanged}
          onClick={() => void saveList()}
        >
          {saving ? 'Saving…' : 'Save list'}
        </button>
        {error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}
      </div>
    </div>
  )
}

function AppsCard() {
  const [report, setReport] = useState<AppsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [installs, setInstalls] = useState<Record<string, WatchedState>>({})
  const [watching, setWatching] = useState(true)
  const watcher = useRef<InstallWatch | null>(null)

  // Only the latest answer counts: an earlier one may still list an app set aside since.
  const loads = useRef(0)
  const load = useCallback(async () => {
    const generation = ++loads.current
    try {
      const answer = (await call(`${BASE}/apps`)) as AppsReport
      if (generation === loads.current) {
        setReport(answer)
        setError(null)
      }
    } catch (e) {
      if (generation === loads.current) {
        setError(`Cannot compare the apps: ${errorText(e)}`)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Open from the start, so the event the server replays on connecting predates every install made here.
  useEffect(() => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const watch = new InstallWatch({
      connect: (on) => {
        const socket = new WebSocket(
          `${scheme}://${window.location.host}/signalk/v1/stream?subscribe=none&serverevents=all`
        )
        socket.onmessage = (message: MessageEvent<unknown>) => {
          on.message(message.data)
        }
        socket.onclose = () => {
          on.close()
        }
        return socket
      },
      changed: setInstalls,
      failed: (names) => {
        setError(`Installing ${names.join(', ')} failed; the server log says why.`)
      },
      connected: setWatching
    })
    watch.start()
    watcher.current = watch
    return () => {
      watcher.current = null
      watch.stop()
    }
  }, [])

  const act = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(name)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const install = (app: AppElsewhere): Promise<void> =>
    act(app.name, async () => {
      const version = newestVersion(app.servers.map((s) => s.version))
      const url = appInstallUrl(app.name, version)
      if (!url) {
        throw new Error(`${app.name} ${version} is not a package the App Store installs`)
      }
      watcher.current?.begin(app.name)
      await call(url, { method: 'POST' }).catch((e: unknown) => {
        watcher.current?.cancel(app.name)
        throw new Error(installErrorText(errorText(e)))
      })
    })

  const setHidden = (name: string, hidden: boolean): Promise<void> =>
    act(name, async () => {
      await call(`${BASE}/apps/hidden`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, hidden })
      })
      await load()
    })

  const row = (app: AppElsewhere, detail: string, actions: boolean) => (
    <li key={app.name} className="list-group-item d-flex flex-wrap align-items-center gap-2">
      <div className="me-auto">
        <div>{app.title}</div>
        <div className="small text-body-secondary">
          {app.name} · {detail}
        </div>
      </div>
      {actions && installs[app.name] && (
        <span className="small text-body-secondary">
          {installs[app.name] === 'done'
            ? 'Installed; restart the server to start it.'
            : installs[app.name] === 'unknown'
              ? 'Whether the install went through is not known here; see the App Store.'
              : watching
                ? 'Installing…'
                : 'Installing; see the App Store for when it is done.'}
        </span>
      )}
      {actions && (!installs[app.name] || installs[app.name] === 'unknown') && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy !== null}
          onClick={() => void install(app)}
        >
          {busy === app.name ? 'Installing…' : 'Install'}
        </button>
      )}
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        disabled={busy !== null}
        onClick={() => void setHidden(app.name, true)}
      >
        Not wanted here
      </button>
    </li>
  )

  const empty =
    report !== null &&
    report.missing.length === 0 &&
    report.versions.length === 0 &&
    report.disabled.length === 0

  return (
    <div className="card mb-3">
      <div className="card-header d-flex align-items-center">
        <span className="me-auto">Apps on the other servers</span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          disabled={busy !== null}
          onClick={() => void load()}
        >
          Check again
        </button>
      </div>
      <div className="card-body">
        <p className="small text-body-secondary">
          The plugins and webapps the servers paired with this one have and this one does not, or
          has in another version. Install installs the other server's version from the App Store;
          what this server should not have, set aside with Not wanted here.
        </p>
        {error && <div className="alert alert-danger">{error}</div>}
        {report === null && !error && <div className="small">Asking the other servers…</div>}
        {report?.here && <div className="alert alert-warning">{report.here}</div>}
        {report?.unreadable.map((s) => (
          <div key={s.name} className="small text-body-secondary">
            Cannot read the apps on {s.name}: {s.error}
          </div>
        ))}
        {empty && !report.here && report.unreadable.length === 0 && (
          <div className="small">This server has every app the others have.</div>
        )}
        {report && report.missing.length > 0 && (
          <>
            <h6 className="mt-3">Missing here</h6>
            <ul className="list-group mb-3">
              {report.missing.map((app) => row(app, `on ${serversText(app.servers)}`, true))}
            </ul>
          </>
        )}
        {report && report.versions.length > 0 && (
          <>
            <h6 className="mt-3">Another version here</h6>
            <ul className="list-group mb-3">
              {report.versions.map((app) =>
                row(
                  app,
                  `${app.version} here, ${serversText(app.servers)}`,
                  newestVersion([app.version, ...app.servers.map((s) => s.version)]) !== app.version
                )
              )}
            </ul>
          </>
        )}
        {report && report.disabled.length > 0 && (
          <>
            <h6 className="mt-3">Off here, on elsewhere</h6>
            <ul className="list-group mb-3">
              {report.disabled.map((app) =>
                row(app, `on at ${app.servers.map((s) => s.name).join(', ')}`, false)
              )}
            </ul>
          </>
        )}
        {report && report.hidden.length > 0 && (
          <div className="small mt-2">
            Not wanted here:{' '}
            {report.hidden.map((name) => (
              <button
                key={name}
                type="button"
                className="btn btn-sm btn-link p-0 me-2"
                disabled={busy !== null}
                onClick={() => void setHidden(name, false)}
              >
                {name} (show again)
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type Switch = Exclude<keyof Settings, 'takeOver' | 'sharePaths' | 'shareConnections'>

function SettingsCard({ configuration, save }: Props) {
  const [settings, setSettings] = useState(() => withDefaults(configuration))
  const [pathsText, setPathsText] = useState(() => settings.sharePaths.join('\n'))
  const [connections, setConnections] = useState<string[] | null>(null)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const loadConnections = useCallback(() => {
    setConnectionsError(null)
    call('/skServer/providers').then(
      (raw) => {
        setConnections(connectionIds(raw))
      },
      (error: unknown) => {
        setConnectionsError(errorText(error))
      }
    )
  }, [])
  useEffect(() => {
    loadConnections()
  }, [loadConnections])
  const listedConnections = [
    ...new Set([...(connections ?? []), ...settings.shareConnections])
  ].sort((a, b) => a.localeCompare(b))
  const set = (key: Switch, value: boolean): void => {
    setSettings((s) => ({ ...s, [key]: value }))
  }
  const option = (key: Switch, title: string, help: string, disabled = false) => (
    <div className="form-check mb-3">
      <input
        className="form-check-input"
        type="checkbox"
        id={`multihelm-${key}`}
        checked={settings[key]}
        disabled={disabled}
        onChange={(e) => {
          set(key, e.target.checked)
        }}
      />
      <label className="form-check-label" htmlFor={`multihelm-${key}`}>
        {title}
      </label>
      <div className="form-text">{help}</div>
    </div>
  )
  const onMaster = settings.master
  return (
    <div className="card mb-3">
      <div className="card-header">Settings</div>
      <div className="card-body">
        {option(
          'master',
          "This server is the boat's master",
          'Set this on one server only. Plugins that run on the master alone run here, and the other servers use them through this one.'
        )}
        <div className="mb-3">
          <label className="form-label" htmlFor="multihelm-takeOver">
            Take over as master when the master is gone
          </label>
          <select
            className="form-select w-auto"
            id="multihelm-takeOver"
            value={settings.takeOver}
            disabled={onMaster}
            onChange={(e) => {
              setSettings((s) => ({ ...s, takeOver: Number(e.target.value) }))
            }}
          >
            <option value={0}>Never</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? 'First' : `${String(n)}.`}
              </option>
            ))}
          </select>
          <div className="form-text">
            When the server set to be the master has been gone for three and a half minutes, the
            server with the lowest place here takes over, while it reaches most of the boat&apos;s
            servers. Give each server that may take over a place of its own.
          </div>
        </div>
        {option(
          'syncResources',
          'Keep routes and waypoints in step',
          'Routes, waypoints, regions and notes, kept the same on every server of the boat: a change on one reaches the others, with no master.'
        )}
        {onMaster && (
          <p className="small text-body-secondary">
            The options below apply to the servers that are not the master.
          </p>
        )}
        {option(
          'followVessel',
          'Take the vessel data over from the master',
          "Name, MMSI, call sign, dimensions and ship type from Server → Settings. Changes made here are replaced by the master's.",
          onMaster
        )}
        {option(
          'followMetadata',
          'Take the path metadata over from the master',
          "Display names, units, zones and alarm limits set for paths. Changes made here are replaced by the master's.",
          onMaster
        )}
        {option(
          'followSourcePriorities',
          'Take the source priorities over from the master',
          "Which source wins for a path, from Data → Source Priorities. They name sources by connection, so give the NMEA 2000 bus the same connection name on every server. Changes made here are replaced by the master's.",
          onMaster
        )}
        {option(
          'historyFromMaster',
          "Answer this server's History API from the master",
          "While the master has a history provider (signalk-questdb, for example), history graphs on this server show the master's history, so it is kept once on the boat. Needs Signal K 2.32.0 or later.",
          onMaster
        )}
        {option(
          'autopilotFromMaster',
          "Operate the master's autopilot from this server",
          "A chartplotter here operates the master's autopilot, while only the master sends to it. Put the autopilot provider plugin on the list of plugins that run on the master only.",
          onMaster
        )}
        {option(
          'courseFromMaster',
          'Keep the course the same as on the master',
          'The active destination or route set at any station is taken over by all the others.',
          onMaster
        )}
        {option(
          'alarmsFromMaster',
          "Show the master's alarms here",
          'Silencing or acknowledging an alarm at any station does it at all the others. An alarm this server raises itself is not shown twice.',
          onMaster
        )}
        <h6 className="mt-4">Data only this server sees</h6>
        <div className="mb-3">
          <label className="form-label" htmlFor="multihelm-sharePaths">
            Share these paths with the other servers
          </label>
          <textarea
            className="form-control font-monospace"
            id="multihelm-sharePaths"
            rows={3}
            placeholder="propulsion.*"
            value={pathsText}
            onChange={(e) => {
              setPathsText(e.target.value)
            }}
          />
          <div className="form-text">
            One path per line, <code>*</code> for any part, such as <code>propulsion.*</code> from
            an engine bus of this server&apos;s own.
          </div>
        </div>
        <div className="mb-3">
          <div className="form-label">Share everything from these connections</div>
          {connectionsError !== null ? (
            <div className="text-danger mb-2">
              Cannot read this server&apos;s connections: {connectionsError}{' '}
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={loadConnections}
              >
                Try again
              </button>
            </div>
          ) : (
            connections === null && <div className="form-text">Loading the connections…</div>
          )}
          {listedConnections.map((id) => (
            <div className="form-check" key={id}>
              <input
                className="form-check-input"
                type="checkbox"
                id={`multihelm-share-${id}`}
                checked={settings.shareConnections.includes(id)}
                onChange={(e) => {
                  setSettings((s) => ({
                    ...s,
                    shareConnections: e.target.checked
                      ? [...s.shareConnections, id]
                      : s.shareConnections.filter((c) => c !== id)
                  }))
                }}
              />
              <label className="form-check-label" htmlFor={`multihelm-share-${id}`}>
                {id}
              </label>
            </div>
          ))}
          <div className="form-text">
            Every value that comes in over a connection ticked here goes to the other servers, such
            as from an NMEA 2000 bus only this server is on. Only values: devices on it are still
            operated from this server alone.
          </div>
        </div>
        {option(
          'takeSharedData',
          'Take the data the other servers share',
          'Values another server shares show here under the source multihelm.<that server>.<source>, wherever this server has no source of its own for them.'
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            save({ ...configuration, ...settings, sharePaths: pathsFromText(pathsText) })
          }}
        >
          Save settings
        </button>
      </div>
    </div>
  )
}
