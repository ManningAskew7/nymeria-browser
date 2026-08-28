import { backgroundLogger as logger } from '../utils/logger'
import { getConfig } from '../utils/storage'
import type { CommandResult, MeResponse } from '../shared/types'

export class HttpError extends Error {
  readonly status: number
  readonly bodyText: string

  constructor(status: number, bodyText: string) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.bodyText = bodyText
  }
}

function joinUrl(baseUrl: string, path: string): URL {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return new URL(`${trimmed}${path}`)
}

interface FetchArgs {
  baseUrl: string
  token?: string
  clientId?: string
  path: string
  init?: RequestInit
}

async function nymFetch({ baseUrl, token, clientId, path, init = {} }: FetchArgs): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (clientId) headers.set('X-Nymeria-Client-Id', clientId)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')

  return fetch(joinUrl(baseUrl, path), {
    ...init,
    credentials: 'omit',
    headers,
  })
}

export async function ping(baseUrl: string): Promise<void> {
  const resp = await nymFetch({ baseUrl, path: '/health' })
  if (!resp.ok) {
    throw new HttpError(resp.status, await resp.text().catch(() => ''))
  }
  logger.log('ping ok')
}

export async function whoami(args: { baseUrl: string; token: string; clientId: string }): Promise<MeResponse> {
  const resp = await nymFetch({ ...args, path: '/me' })
  if (!resp.ok) {
    throw new HttpError(resp.status, await resp.text().catch(() => ''))
  }
  return (await resp.json()) as MeResponse
}

/**
 * POST the outcome of a browser_command back to the Nymeria API. The
 * backend resolves the awaiting tool's future and emits a
 * browser_command_result observability event.
 *
 * delivered=false in the response means the agent already moved on (the
 * command had been resolved by timeout, sweep, or a previous POST).
 */
export async function postCommandResult(commandId: string, result: CommandResult): Promise<{ delivered: boolean }> {
  const { baseUrl, token, clientId } = await getConfig()
  if (!baseUrl || !token) {
    throw new Error('postCommandResult called without configured baseUrl/token')
  }
  const resp = await nymFetch({
    baseUrl,
    token,
    clientId,
    path: `/browser-commands/${encodeURIComponent(commandId)}/result`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new HttpError(resp.status, text)
  }
  const body = (await resp.json().catch(() => ({}))) as { delivered?: boolean }
  return { delivered: body.delivered !== false }
}

/**
 * POST a batch of login screencast frames to the backend.
 *
 * Deliberately its own endpoint rather than a command result or an event:
 * frames must not ride the command channel (they answer no command) and
 * must not ride the event bus (which would fan a picture of the user's
 * password out to every other subscriber). The backend buffers them for
 * the desktop viewer alone.
 *
 * `sessionActive: false` means the session ended without this extension
 * hearing about it (the operator clicked Done, the time limit passed, the
 * thread was aborted). It is the ONLY downward signal for that, so callers
 * must treat it as "stop capturing", not as a soft warning.
 */
export async function postLoginFrames(
  sessionId: string,
  frames: { data: string; metadata?: Record<string, unknown> }[],
): Promise<{ accepted: number; sessionActive: boolean }> {
  const { baseUrl, token, clientId } = await getConfig()
  if (!baseUrl || !token) {
    throw new Error('postLoginFrames called without configured baseUrl/token')
  }
  const resp = await nymFetch({
    baseUrl,
    token,
    clientId,
    path: `/browser-login/${encodeURIComponent(sessionId)}/frame`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames }),
    },
  })
  if (!resp.ok) {
    // A 404 is the session being gone entirely, which is also "stop".
    if (resp.status === 404) return { accepted: 0, sessionActive: false }
    throw new HttpError(resp.status, await resp.text().catch(() => ''))
  }
  const body = (await resp.json().catch(() => ({}))) as {
    accepted?: number
    session_active?: boolean
  }
  return { accepted: body.accepted ?? 0, sessionActive: body.session_active !== false }
}

export { nymFetch }
