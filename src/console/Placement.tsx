import { useState } from 'react'

import { MAX_PLACED_SERVERS, type Placement } from '../placement.js'
import { BASE, errorText, send } from './http.js'
import { Sheet } from './Sheet.js'
import {
  orderText,
  pluginChoices,
  pluginName,
  type InstalledPlugin,
  type ServerColumn
} from './view.js'

const TITLE = 'Run on chosen servers'

interface CardProps {
  placement: Placement
  columns: ServerColumn[]
  installed: InstalledPlugin[]
  edit: () => void
}

export function PlacementCard({ placement, columns, installed, edit }: CardProps) {
  const entries = Object.entries(placement)
  return (
    <article className="boat-card">
      <h3>{TITLE}</h3>
      {entries.length === 0 ? (
        <p className="muted">No plugins placed.</p>
      ) : (
        <ul>
          {entries.map(([id, order]) => (
            <li key={id}>
              {pluginName(id, installed)}
              <small className="help">{orderText(order, columns)}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="card-actions">
        <button type="button" className="button" onClick={edit}>
          Change
        </button>
      </div>
    </article>
  )
}

interface EditorProps {
  placement: Placement
  masterPlugins: string[]
  columns: ServerColumn[]
  installed: InstalledPlugin[]
  saved: (placement: Placement) => void
  close: () => void
}

export function PlacementEditor({
  placement,
  masterPlugins,
  columns,
  installed,
  saved,
  close
}: EditorProps) {
  const [draft, setDraft] = useState<Placement>(placement)
  const [adding, setAdding] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const servers = columns.filter((c) => c.id !== '')
  const addable = pluginChoices(installed, []).filter(
    (p) => !masterPlugins.includes(p.id) && draft[p.id] === undefined
  )

  const toggle = (id: string, server: string): void => {
    const order = draft[id] ?? []
    const next = order.includes(server)
      ? order.filter((s) => s !== server)
      : [...order, server].slice(0, MAX_PLACED_SERVERS)
    setDraft({ ...draft, [id]: next })
  }

  const remove = (id: string): void => {
    const rest = { ...draft }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete rest[id]
    setDraft(rest)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const plugins = Object.fromEntries(
        Object.entries(draft).filter(([, order]) => order.length > 0)
      )
      await send(`${BASE}/placement`, 'PUT', { plugins })
      saved(plugins)
      close()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet title={TITLE} busy={saving} close={close}>
      <p className="muted">
        Each plugin runs on the first server of its list that is there, and is stopped on the
        others. When that server is gone for about three minutes, the next one starts it; once the
        first is back for two minutes, it takes it back. For services such as a database: while the
        network is split, two servers may run it, so a plugin that sends to the boat&apos;s bus,
        such as an autopilot, belongs on the master only. Tap the servers in the order they should
        take it.
      </p>
      {Object.entries(draft).map(([id, order]) => (
        <section className="placement" key={id}>
          <header className="placement-head">
            <h4>{pluginName(id, installed)}</h4>
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => {
                remove(id)
              }}
            >
              Remove
            </button>
          </header>
          <div className="chips">
            {servers.map((server) => {
              const place = order.indexOf(server.id)
              return (
                <button
                  type="button"
                  key={server.id}
                  className={`chip${place === -1 ? '' : ' on'}`}
                  aria-pressed={place !== -1}
                  disabled={saving}
                  onClick={() => {
                    toggle(id, server.id)
                  }}
                >
                  {place === -1 ? '' : `${String(place + 1)}. `}
                  {server.name}
                </button>
              )
            })}
          </div>
          {order.length === 0 && <p className="muted">Runs nowhere until a server is chosen.</p>}
        </section>
      ))}
      <div className="address">
        <select
          value={adding}
          aria-label="Plugin to place"
          disabled={saving || addable.length === 0}
          onChange={(e) => {
            setAdding(e.target.value)
          }}
        >
          <option value="">{addable.length === 0 ? 'No other plugins' : 'Add a plugin…'}</option>
          {addable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={saving || adding === ''}
          onClick={() => {
            setDraft({ ...draft, [adding]: [] })
            setAdding('')
          }}
        >
          Add
        </button>
      </div>
      {error && <p className="banner tone-danger">{error}</p>}
      <div className="sheet-actions">
        <button
          type="button"
          className="button primary"
          disabled={saving}
          onClick={() => {
            void save()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  )
}
