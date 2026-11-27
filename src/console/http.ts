export const BASE = '/plugins/signalk-multihelm'

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A request to this server; an answer that is not OK throws the error it gives. */
export async function call(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : `HTTP ${String(res.status)}`)
  }
  return body
}

export function send(
  url: string,
  method: 'PUT' | 'POST' | 'DELETE',
  body?: unknown
): Promise<unknown> {
  return call(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
}
