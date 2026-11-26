import { useState } from 'react'

import { BASE, errorText, send } from './http.js'
import { Sheet } from './Sheet.js'
import { pluginChoices, pluginName, type InstalledPlugin } from './view.js'

export type ListName = 'master-plugins' | 'shared-plugins'

const LISTS: Record<ListName, { title: string; help: string; empty: string }> = {
  'master-plugins': {
    title: 'Run on the master only',
    help: "These plugins run on the boat's master and are stopped on the other servers, for example an autopilot provider, so only one server sends its commands. When another server becomes the master, they move there.",
    empty: 'No plugins chosen.'
  },
  'shared-plugins': {
    title: 'Same settings on every server',
    help: "The settings of these plugins, such as a buddy list, are kept the same on every server; whether a plugin runs stays each server's own. Add a plugin on the server that has the settings you want: the others take them over. After that, a change on any server goes to all.",
    empty: 'No plugins chosen.'
  }
}

interface CardProps {
  name: ListName
  current: string[]
  installed: InstalledPlugin[]
  edit: () => void
}

export function PluginListCard({ name, current, installed, edit }: CardProps) {
  const list = LISTS[name]
  return (
    <article className="boat-card">
      <h3>{list.title}</h3>
      {current.length === 0 ? (
        <p className="muted">{list.empty}</p>
      ) : (
        <ul>
          {current.map((id) => (
            <li key={id}>{pluginName(id, installed)}</li>
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
  name: ListName
  current: string[]
  installed: InstalledPlugin[]
  close: () => void
}

export function PluginListEditor({ name, current, installed, close }: EditorProps) {
  const list = LISTS[name]
  const [chosen, setChosen] = useState(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choices = pluginChoices(installed, current)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await send(`${BASE}/${name}`, 'PUT', { plugins: chosen })
      close()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet title={list.title} busy={saving} close={close}>
      <p className="muted">{list.help} The list is the same on every server.</p>
      {installed.length === 0 && <p className="muted">Reading this server's plugins…</p>}
      {choices.map((plugin) => (
        <label className="switch-row" key={plugin.id}>
          <span>
            {plugin.name}
            {!plugin.installed && <small className="help">Not installed on this server</small>}
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={chosen.includes(plugin.id)}
            disabled={saving}
            onChange={(e) => {
              setChosen(
                e.target.checked ? [...chosen, plugin.id] : chosen.filter((id) => id !== plugin.id)
              )
            }}
          />
        </label>
      ))}
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
