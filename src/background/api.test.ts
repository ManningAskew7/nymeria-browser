import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, nymFetch, ping, whoami } from './api'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  const resp = {
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response
  const spy = vi.fn().mockResolvedValue(resp)
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

describe('nymFetch', () => {
  it('strips a trailing slash from baseUrl and joins the path', async () => {
    const spy = mockFetch({ ok: true })
    await nymFetch({ baseUrl: 'http://localhost:8000/', path: '/health' })
    const url = spy.mock.calls[0][0] as URL
    expect(url.toString()).toBe('http://localhost:8000/health')
  })

  it('adds Bearer auth and client-id headers when supplied', async () => {
    const spy = mockFetch({ ok: true })
    await nymFetch({
      baseUrl: 'http://localhost:8000',
      token: 'nym_test',
      clientId: 'nymeria-browser-abc',
      path: '/me',
    })
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer nym_test')
    expect(headers.get('X-Nymeria-Client-Id')).toBe('nymeria-browser-abc')
    expect(init.credentials).toBe('omit')
  })

  it('does not send Authorization when no token is supplied', async () => {
    const spy = mockFetch({ ok: true })
    await nymFetch({ baseUrl: 'http://localhost:8000', path: '/health' })
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.has('Authorization')).toBe(false)
  })
})

describe('ping', () => {
  it('resolves on 2xx', async () => {
    mockFetch({ ok: true, status: 200 })
    await expect(ping('http://localhost:8000')).resolves.toBeUndefined()
  })

  it('throws HttpError on non-2xx', async () => {
    mockFetch({ ok: false, status: 503, textBody: 'down' })
    await expect(ping('http://localhost:8000')).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
      bodyText: 'down',
    })
  })
})

describe('whoami', () => {
  it('returns the parsed identity payload on 200', async () => {
    mockFetch({
      ok: true,
      status: 200,
      jsonBody: { id: 'u1', email: 'm@x', display_name: 'Manning', role: 'admin' },
    })
    const me = await whoami({ baseUrl: 'http://localhost:8000', token: 'nym_t', clientId: 'c' })
    expect(me.email).toBe('m@x')
    expect(me.role).toBe('admin')
  })

  it('throws HttpError(401) when the token is rejected', async () => {
    mockFetch({ ok: false, status: 401, textBody: 'unauthorized' })
    await expect(
      whoami({ baseUrl: 'http://localhost:8000', token: 'bad', clientId: 'c' }),
    ).rejects.toBeInstanceOf(HttpError)
  })
})
