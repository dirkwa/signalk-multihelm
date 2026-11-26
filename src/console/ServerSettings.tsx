import { useEffect, useState } from 'react'

import { connectionIds } from '../configpanel/view.js'

import { MAX_LOCATION_LENGTH, type PlanSettings, type ServerPlan } from '../plan.js'
import { call, errorText, send } from './http.js'
import { Sheet } from './Sheet.js'
import { linesFromText, planUrl, settingHelp, settingTitle, SWITCHES } from './view.js'

const MAX_TAKE_OVER = 9

interface Props {
  serverId: string
  name: string
  here: boolean
  plan: ServerPlan
  close: () => void
}

export function ServerSettings({ serverId, name, here, plan, close }: Props) {
  const [location, setLocation] = useState(plan.location)
  const [settings, setSettings] = useState<PlanSettings>(plan.settings)
  const [paths, setPaths] = useState(plan.settings.sharePaths.join('\n'))
  const [connections, setConnections] = useState(plan.settings.shareConnections.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // This server's own connections can be ticked; another server's are typed, as only it can list them.
  const [ownConnections, setOwnConnections] = useState<string[] | null>(null)

  useEffect(() => {
    if (!here) {
      return
    }
    call('/skServer/providers').then(
      (raw) => {
        setOwnConnections(connectionIds(raw))
      },
      () => {
        setOwnConnections(null)
      }
    )
  }, [here])
  const typed = linesFromText(connections)
  const listedConnections =
    ownConnections === null
      ? null
      : [...new Set([...ownConnections, ...typed])].sort((a, b) => a.localeCompare(b))

  const set = <K extends keyof PlanSettings>(key: K, value: PlanSettings[K]): void => {
    setSettings({ ...settings, [key]: value })
  }

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await send(planUrl(serverId), 'PUT', {
        location: location.trim(),
        settings: {
          ...settings,
          sharePaths: linesFromText(paths),
          shareConnections: linesFromText(connections)
        }
      })
      close()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet title={name} busy={saving} close={close}>
      <p className="muted">
        {here
          ? 'Saved settings take effect here at once; Multihelm restarts on this server.'
          : 'Saved settings reach that server within a minute, and Multihelm restarts there.'}
      </p>

      <label className="field">
        <span>Where it is on board</span>
        <input
          type="text"
          value={location}
          maxLength={MAX_LOCATION_LENGTH}
          placeholder="Flybridge port, Salon, …"
          onChange={(e) => {
            setLocation(e.target.value)
          }}
        />
      </label>

      <div className="field">
        <span>
          {settingTitle('takeOver')}
          <small className="help">{settingHelp('takeOver')}</small>
        </span>
        <div className="stepper">
          <button
            type="button"
            className="button"
            disabled={settings.takeOver === 0}
            onClick={() => {
              set('takeOver', settings.takeOver - 1)
            }}
          >
            −
          </button>
          <span className="stepper-value">
            {settings.takeOver === 0 ? 'Never' : `${String(settings.takeOver)}.`}
          </span>
          <button
            type="button"
            className="button"
            disabled={settings.takeOver === MAX_TAKE_OVER}
            onClick={() => {
              set('takeOver', settings.takeOver + 1)
            }}
          >
            +
          </button>
        </div>
      </div>

      {SWITCHES.map((key) => (
        <label className="switch-row" key={key}>
          <span>
            {settingTitle(key)}
            <small className="help">{settingHelp(key)}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings[key]}
            onChange={(e) => {
              set(key, e.target.checked)
            }}
          />
        </label>
      ))}

      <label className="field">
        <span>
          {settingTitle('sharePaths')}
          <small className="help">{settingHelp('sharePaths')}</small>
        </span>
        <textarea
          rows={3}
          value={paths}
          placeholder="propulsion.*"
          onChange={(e) => {
            setPaths(e.target.value)
          }}
        />
      </label>
      {listedConnections === null ? (
        <label className="field">
          <span>
            {settingTitle('shareConnections')}
            <small className="help">{settingHelp('shareConnections')}</small>
          </span>
          <textarea
            rows={2}
            value={connections}
            onChange={(e) => {
              setConnections(e.target.value)
            }}
          />
        </label>
      ) : (
        <div className="field">
          <span>
            {settingTitle('shareConnections')}
            <small className="help">{settingHelp('shareConnections')}</small>
          </span>
          {listedConnections.length === 0 && (
            <p className="muted">This server has no connections.</p>
          )}
          {listedConnections.map((id) => (
            <label className="switch-row" key={id}>
              <span>{id}</span>
              <input
                type="checkbox"
                role="switch"
                checked={typed.includes(id)}
                onChange={(e) => {
                  setConnections(
                    (e.target.checked ? [...typed, id] : typed.filter((c) => c !== id)).join('\n')
                  )
                }}
              />
            </label>
          ))}
        </div>
      )}

      {error && <p className="banner tone-danger">{error}</p>}
      <div className="sheet-actions">
        <button
          type="button"
          className="button primary"
          disabled={saving}
          onClick={() => {
            void submit()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Sheet>
  )
}
