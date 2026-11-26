import { useCallback, useEffect, useRef, useState } from 'react'

import { InstallWatch, type WatchedState } from '../configpanel/install-watch.js'
import { appInstallUrl, installErrorText, newestVersion, serversText } from '../configpanel/view.js'
import type { AppElsewhere, AppsReport } from '../installed-apps.js'
import { BASE, call, errorText, send } from './http.js'

function installText(state: WatchedState, watching: boolean): string {
  switch (state) {
    case 'done':
      return 'Installed; restart this server to start it.'
    case 'unknown':
      return 'Whether the install went through is not known here; see the App Store.'
    default:
      return watching ? 'Installing…' : 'Installing; see the App Store for when it is done.'
  }
}

/** The plugins and webapps the other servers have and this one lacks, or has in another version. */
export function Apps() {
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
      await send(`${BASE}/apps/hidden`, 'PUT', { name, hidden })
      await load()
    })

  const row = (app: AppElsewhere, detail: string, installable: boolean) => {
    const state = installs[app.name]
    return (
      <li key={app.name}>
        <span>
          {app.title}
          <small className="help">
            {app.name} · {detail}
          </small>
          {installable && state && <small className="help">{installText(state, watching)}</small>}
        </span>
        <span className="row-actions">
          {installable && (!state || state === 'unknown') && (
            <button
              type="button"
              className="button"
              disabled={busy !== null}
              onClick={() => void install(app)}
            >
              {busy === app.name ? 'Installing…' : 'Install'}
            </button>
          )}
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => void setHidden(app.name, true)}
          >
            Not wanted here
          </button>
        </span>
      </li>
    )
  }

  const empty =
    report !== null &&
    report.missing.length === 0 &&
    report.versions.length === 0 &&
    report.disabled.length === 0

  return (
    <article className="boat-card wide">
      <h3>Apps on the other servers</h3>
      <p className="muted">
        What the servers this one pairs with have and this one does not, or has in another version.
        Install takes the other server&apos;s version from the App Store.
      </p>
      {error && <p className="banner tone-danger">{error}</p>}
      {report === null && !error && <p className="muted">Asking the other servers…</p>}
      {report?.here && <p className="banner tone-warning">{report.here}</p>}
      {report?.unreadable.map((s) => (
        <p key={s.name} className="muted">
          Cannot read the apps on {s.name}: {s.error}
        </p>
      ))}
      {empty && !report.here && report.unreadable.length === 0 && (
        <p className="muted">This server has every app the others have.</p>
      )}
      {report && report.missing.length > 0 && (
        <>
          <h4>Missing here</h4>
          <ul className="found">
            {report.missing.map((app) => row(app, `on ${serversText(app.servers)}`, true))}
          </ul>
        </>
      )}
      {report && report.versions.length > 0 && (
        <>
          <h4>Another version here</h4>
          <ul className="found">
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
          <h4>Off here, on elsewhere</h4>
          <ul className="found">
            {report.disabled.map((app) =>
              row(app, `on at ${app.servers.map((s) => s.name).join(', ')}`, false)
            )}
          </ul>
        </>
      )}
      {report && report.hidden.length > 0 && (
        <p className="muted">
          Not wanted here:{' '}
          {report.hidden.map((name) => (
            <button
              key={name}
              type="button"
              className="link-button"
              disabled={busy !== null}
              onClick={() => void setHidden(name, false)}
            >
              {name} (show again)
            </button>
          ))}
        </p>
      )}
      <div className="card-actions">
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => void load()}
        >
          Check again
        </button>
      </div>
    </article>
  )
}
