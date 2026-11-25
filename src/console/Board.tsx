import { useEffect, useState } from 'react'

import type { ServerPlan } from '../plan.js'
import type { Status } from '../status.js'
import {
  attention,
  consoleRoleNotice,
  installedPlugins,
  pluginName,
  serverColumns,
  SETTINGS_URL,
  stateText,
  type Attention,
  type InstalledPlugin,
  type ServerColumn
} from './view.js'
import { ServerSettings } from './ServerSettings.js'

const STATUS_URL = '/plugins/signalk-multihelm/status'
const PLUGINS_URL = '/skServer/plugins'
const STATUS_POLL_MS = 3_000
const PLUGINS_POLL_MS = 30_000

type Load =
  { state: 'loading' } | { state: 'ok' } | { state: 'login' } | { state: 'error'; text: string }

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (res.status === 401 || res.status === 403) {
    throw new LoginNeeded()
  }
  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)}`)
  }
  return res.json()
}

class LoginNeeded extends Error {}

function usePolled<T>(url: string, everyMs: number, parse: (raw: unknown) => T) {
  const [value, setValue] = useState<T | null>(null)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  useEffect(() => {
    let stopped = false
    // A slow answer must not overwrite a later one that came first.
    let issued = 0
    let applied = 0
    const current = (request: number): boolean => {
      if (stopped || request <= applied) {
        return false
      }
      applied = request
      return true
    }
    const read = (): void => {
      const request = ++issued
      getJson(url).then(
        (raw) => {
          if (current(request)) {
            setValue(parse(raw))
            setLoad({ state: 'ok' })
          }
        },
        (e: unknown) => {
          if (current(request)) {
            setLoad(
              e instanceof LoginNeeded
                ? { state: 'login' }
                : { state: 'error', text: e instanceof Error ? e.message : String(e) }
            )
          }
        }
      )
    }
    read()
    const timer = setInterval(read, everyMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [url, everyMs, parse])
  return { value, load }
}

const asStatus = (raw: unknown): Status => raw as Status

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return now
}

export function Board() {
  const status = usePolled(STATUS_URL, STATUS_POLL_MS, asStatus)
  const plugins = usePolled(PLUGINS_URL, PLUGINS_POLL_MS, installedPlugins)
  const now = useNow()
  const [editing, setEditing] = useState<ServerColumn | null>(null)

  if (!status.value) {
    return (
      <main className="board">
        <Header />
        {status.load.state === 'login' ? (
          <p className="message">
            The console shows the boat to admins. <a href="/admin/#/login">Log in</a> and open it
            again.
          </p>
        ) : status.load.state === 'error' ? (
          <p className="message">Cannot read Multihelm's status: {status.load.text}</p>
        ) : (
          <p className="message">Loading…</p>
        )}
      </main>
    )
  }

  const s = status.value
  if (!s.running) {
    return (
      <main className="board">
        <Header />
        <p className="message">
          Multihelm is not running on this server. <a href={SETTINGS_URL}>Enable it</a>.
        </p>
      </main>
    )
  }

  const installed = plugins.value ?? []
  const role = consoleRoleNotice(s, now)
  const items = attention(s, installed)
  if (plugins.load.state === 'error' || plugins.load.state === 'login') {
    items.push({
      tone: 'warning',
      text:
        plugins.value === null
          ? "Cannot read this server's plugins, so the plugins that run on the master only are not checked."
          : "Cannot read this server's plugins just now; what is said about them may be out of date."
    })
  }
  const columns = serverColumns(s)
  const masterKnown = columns.some((c) => c.master)

  return (
    <main className="board">
      <Header />
      {status.load.state !== 'ok' && (
        <p className="banner tone-danger">
          Lost the connection to this server; what follows may be out of date.
        </p>
      )}
      <AttentionList items={[role, ...items]} />
      <section className="servers" aria-label="Servers">
        {columns.map((column) => (
          <ServerCard
            key={column.id || column.name}
            column={column}
            now={now}
            masterPlugins={column.master ? s.masterPlugins : []}
            installed={installed}
            plan={s.plan?.[column.id]}
            edit={() => {
              setEditing(column)
            }}
          />
        ))}
      </section>
      {!masterKnown && s.masterPlugins.length > 0 && (
        <p className="message">
          No master, so the plugins that run on the master only run nowhere:{' '}
          {s.masterPlugins.map((id) => pluginName(id, installed)).join(', ')}.
        </p>
      )}
      <section className="boat" aria-label="The whole boat">
        <BoatCard
          title="Same settings on every server"
          empty="No plugins chosen."
          items={s.sharedPlugins.map((id) => pluginName(id, installed))}
        />
        <BoatCard title="Kept in step" empty="Nothing registered." items={s.datasets} />
      </section>
      {editing && s.plan?.[editing.id] && (
        <ServerSettings
          serverId={editing.id}
          name={editing.name}
          here={editing.here}
          plan={s.plan[editing.id] as ServerPlan}
          close={() => {
            setEditing(null)
          }}
        />
      )}
      <p className="footer">
        <a className="button" href={SETTINGS_URL}>
          Settings
        </a>
      </p>
    </main>
  )
}

function Header() {
  return (
    <header>
      <h1>Multihelm</h1>
    </header>
  )
}

function AttentionList({ items }: { items: Attention[] }) {
  return (
    <section className="attention" aria-label="Needs attention">
      {items.map((item) => (
        <div className={`attention-item tone-${item.tone}`} key={item.text}>
          <span>{item.text}</span>
          {item.link && (
            <a className="button" href={item.link.href} target="_blank" rel="noreferrer">
              {item.link.text}
            </a>
          )}
        </div>
      ))}
    </section>
  )
}

interface ServerCardProps {
  column: ServerColumn
  now: number
  masterPlugins: string[]
  installed: InstalledPlugin[]
  plan: ServerPlan | undefined
  edit: () => void
}

function ServerCard({ column, now, masterPlugins, installed, plan, edit }: ServerCardProps) {
  return (
    <article className={`server state-${column.state}${column.here ? ' here' : ''}`}>
      <div className="server-head">
        <span className="dot" aria-hidden="true" />
        <h2>{column.name}</h2>
        {column.master && <span className="badge">Master</span>}
      </div>
      {plan && plan.location !== '' && <p className="server-location">{plan.location}</p>}
      <p className="server-state">{stateText(column, now)}</p>
      {column.versions !== '' && <p className="server-versions">{column.versions}</p>}
      {column.oneWay && (
        <p className="server-note">Pairs with this server; this server does not pair with it.</p>
      )}
      {masterPlugins.length > 0 && (
        <div className="roles">
          <h3>Runs here for the boat</h3>
          <ul>
            {masterPlugins.map((id) => (
              <li key={id}>{pluginName(id, installed)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="server-actions">
        {plan ? (
          <button type="button" className="button" onClick={edit}>
            Settings
          </button>
        ) : (
          !column.here && (
            <p className="muted">Its settings are made on that server: its Multihelm is older.</p>
          )
        )}
      </div>
    </article>
  )
}

function BoatCard({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <article className="boat-card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </article>
  )
}
