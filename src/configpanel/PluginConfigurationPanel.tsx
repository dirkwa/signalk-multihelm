import { useCallback, useEffect, useState } from 'react'

import type { Settings } from '../config.js'
import type { Status } from '../status.js'
import { approveAccessUrl, approveErrorText, roleNotice } from './view.js'

const BASE = '/plugins/signalk-multihelm'
const CONSOLE_URL = '/signalk-multihelm/'
const POLL_MS = 3_000

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

export default function PluginConfigurationPanel({ configuration, save }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [allowing, setAllowing] = useState(false)
  const [allowError, setAllowError] = useState<string | null>(null)

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

  const allow = async (request: string): Promise<void> => {
    setAllowing(true)
    setAllowError(null)
    try {
      await call(approveAccessUrl(request), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: 'admin' })
      })
    } catch (error) {
      setAllowError(approveErrorText(errorText(error)))
    } finally {
      setAllowing(false)
      await refresh()
    }
  }

  return (
    <div>
      <div className="alert alert-info">
        <p>
          Pairing, the settings of every server, the plugins that run on the master only or with the
          same settings everywhere, and the apps the other servers have are all in the Multihelm
          console, on every server of the boat.
        </p>
        <a className="btn btn-primary" href={CONSOLE_URL}>
          Open the console
        </a>
      </div>
      {loadError && (
        <div className="alert alert-danger">
          Cannot read Multihelm's status: {loadError}
          {status && '. What is shown below may be out of date.'}
        </div>
      )}
      {status && (
        <StatusNotices
          status={status}
          allowing={allowing}
          allowError={allowError}
          onAllow={(request) => void allow(request)}
        />
      )}
      <MasterCard configuration={configuration} save={save} />
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
          from the master and no plugin is switched for the master. Save below to ask again.
        </div>
      )}
    </>
  )
}

function MasterCard({ configuration, save }: Props) {
  const [master, setMaster] = useState(configuration?.master === true)
  return (
    <div className="card mb-3">
      <div className="card-header">This server</div>
      <div className="card-body">
        <div className="form-check mb-3">
          <input
            className="form-check-input"
            type="checkbox"
            id="multihelm-master"
            checked={master}
            onChange={(e) => {
              setMaster(e.target.checked)
            }}
          />
          <label className="form-check-label" htmlFor="multihelm-master">
            This server is the boat&apos;s master
          </label>
          <div className="form-text">
            Set this on one server only. It stays here, on this server, so the boat keeps its master
            whatever happens to the settings kept in step.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            save({ ...configuration, master })
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}
