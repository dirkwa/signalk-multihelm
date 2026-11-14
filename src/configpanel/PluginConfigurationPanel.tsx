import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'

import type { PeerInfo } from '../api.js'
import type { Settings } from '../config.js'
import type { PairedByInfo, Status } from '../status.js'
import {
  accessRequestsUrl,
  ago,
  approveAccessUrl,
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
    followVessel: configuration?.followVessel !== false,
    followMetadata: configuration?.followMetadata !== false,
    followSourcePriorities: configuration?.followSourcePriorities !== false,
    historyFromMaster: configuration?.historyFromMaster !== false
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
            master's vessel data, path metadata and source priorities here.
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
            This approves the request “Multihelm: take the vessel settings over from the master”
            under <a href="#/security/access/requests">Security → Access Requests</a>.
          </div>
          {allowError && <div className="text-danger mt-2">{allowError}</div>}
        </div>
      )}
      {own?.state === 'denied' && (
        <div className="alert alert-danger">
          The access request on this server was denied, so the vessel settings are not taken over
          from the master. Save the settings below to ask again.
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

function SettingsCard({ configuration, save }: Props) {
  const [settings, setSettings] = useState(() => withDefaults(configuration))
  const set = (key: keyof Settings, value: boolean): void => {
    setSettings((s) => ({ ...s, [key]: value }))
  }
  const option = (key: keyof Settings, title: string, help: string, disabled = false) => (
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
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            save({ ...configuration, ...settings })
          }}
        >
          Save settings
        </button>
      </div>
    </div>
  )
}
