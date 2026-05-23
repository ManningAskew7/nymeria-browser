import { backgroundLogger as logger } from '../utils/logger'
import type { MeResponse } from '../shared/types'

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

export { nymFetch }
