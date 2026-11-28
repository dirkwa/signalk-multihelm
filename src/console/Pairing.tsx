import { useState, type SyntheticEvent } from 'react'

import { unpairedServers } from '../configpanel/view.js'
import type { Status } from '../status.js'
import { BASE, errorText, send } from './http.js'

export function pair(url: string): Promise<unknown> {
  return send(`${BASE}/peers`, 'POST', { url })
}

export function unpair(url: string): Promise<unknown> {
  return send(`${BASE}/peers?url=${encodeURIComponent(url)}`, 'DELETE')
}

export function forget(id: string): Promise<unknown> {
  return send(`${BASE}/paired-by?id=${encodeURIComponent(id)}`, 'DELETE')
}

function alsoAt(addresses: string[]): string[] {
  return addresses.length > 1 ? [`also ${addresses.slice(1).join(', ')}`] : []
}

/** Pairing this server with another: the servers found on the network, or an address. */
export function AddServer({ status }: { status: Status }) {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const unpaired = unpairedServers(status)
  const found = unpaired.filter((server) => server.answers !== false)
  const silent = unpaired.filter((server) => server.answers === false)

  const start = async (url: string): Promise<boolean> => {
    setBusy(url)
    setError(null)
    try {
      await pair(url)
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault()
    const url = address.trim()
    if (url !== '' && (await start(url))) {
      setAddress('')
    }
  }

  return (
    <article className="boat-card">
      <h3>Pair with another server</h3>
      <p className="muted">
        {status.role === 'master'
          ? 'The other servers pair with this one from their own console. Pair this one with another only to keep what that one shares, such as charts, here too.'
          : "This server takes over what the servers it pairs with share. Pair it with the boat's master; the master then asks for your approval."}
      </p>
      {found.length === 0 ? (
        <p className="muted">
          No other Signal K server that is not paired yet was found on the network.
        </p>
      ) : (
        <ul className="found">
          {found.map((server) => (
            <li key={server.url}>
              <span>
                {server.name}
                <small className="help">
                  {[server.vessel, server.url, ...alsoAt(server.addresses)]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
              <button
                type="button"
                className="button"
                disabled={busy !== null}
                onClick={() => void start(server.url)}
              >
                {busy === server.url ? 'Pairing…' : 'Pair'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {silent.length > 0 && (
        <p className="muted">
          Announced, but not answering:{' '}
          {silent.map((server) => `${server.name} (${server.url})`).join(', ')}.
        </p>
      )}
      <form className="address" onSubmit={(e) => void submit(e)}>
        <input
          type="text"
          value={address}
          placeholder="Address, e.g. helm.local:3000"
          aria-label="Address of the other server"
          onChange={(e) => {
            setAddress(e.target.value)
          }}
        />
        <button type="submit" className="button" disabled={busy !== null || address.trim() === ''}>
          {busy !== null && busy === address.trim() ? 'Pairing…' : 'Pair'}
        </button>
      </form>
      {error && <p className="banner tone-danger">{error}</p>}
    </article>
  )
}
