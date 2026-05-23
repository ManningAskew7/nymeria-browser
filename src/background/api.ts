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

export { nymFetch }
