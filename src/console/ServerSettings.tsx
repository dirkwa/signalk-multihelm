import { useEffect, useRef, useState } from 'react'

import { MAX_LOCATION_LENGTH, type PlanSettings, type ServerPlan } from '../plan.js'
import { linesFromText, planUrl, settingTitle, SWITCHES } from './view.js'

const MAX_TAKE_OVER = 9

interface Props {
  serverId: string
  name: string
  here: boolean
  plan: ServerPlan
  close: () => void
}

async function save(serverId: string, plan: ServerPlan): Promise<void> {
  const res = await fetch(planUrl(serverId), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan)
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown }
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(res.status)}`)
  }
}

export function ServerSettings({ serverId, name, here, plan, close }: Props) {
  const [location, setLocation] = useState(plan.location)
  const [settings, setSettings] = useState<PlanSettings>(plan.settings)
  const [paths, setPaths] = useState(plan.settings.sharePaths.join('\n'))
  const [connections, setConnections] = useState(plan.settings.shareConnections.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    return () => {
      element?.close()
    }
  }, [])

  // While a save runs the sheet stays open, so its answer reaches the sheet that sent it.
  const dismiss = (): void => {
    if (!saving) {
      close()
    }
  }

  const set = <K extends keyof PlanSettings>(key: K, value: PlanSettings[K]): void => {
    setSettings({ ...settings, [key]: value })
  }

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await save(serverId, {
        location: location.trim(),
        settings: {
          ...settings,
          sharePaths: linesFromText(paths),
          shareConnections: linesFromText(connections)
        }
      })
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label={`Settings of ${name}`}
      onCancel={(e) => {
        e.preventDefault()
        dismiss()
      }}
      onClick={(e) => {
        if (e.target === dialog.current) {
          dismiss()
        }
      }}
    >
      <div className="sheet-body">
        <header className="sheet-head">
          <h2>{name}</h2>
          <button type="button" className="button" disabled={saving} onClick={dismiss}>
            Close
          </button>
        </header>
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
          <span>{settingTitle('takeOver')}</span>
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
            <span>{settingTitle(key)}</span>
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
          <span>{settingTitle('sharePaths')}</span>
          <textarea
            rows={3}
            value={paths}
            placeholder="propulsion.*"
            onChange={(e) => {
              setPaths(e.target.value)
            }}
          />
        </label>
        <label className="field">
          <span>{settingTitle('shareConnections')}</span>
          <textarea
            rows={2}
            value={connections}
            onChange={(e) => {
              setConnections(e.target.value)
            }}
          />
        </label>

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
      </div>
    </dialog>
  )
}
