import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installCdpEventRouter, resetForTests as resetDebugger } from './debuggerSession'
import {
  failuresSince,
  installCdpNetworkCapture,
  read,
  resetForTests as resetNetwork,
} from './networkBuffer'

const TAB = 1

type CdpListener = (source: { tabId: number }, method: string, params: unknown) => void

/**
 * Re-bind the CDP router onto the freshly installed chrome mock and hand back
 * the listener, so these tests exercise the real event path rather than
 * poking the buffer directly.
 */
function wireCapture(): CdpListener {
  installCdpEventRouter()
  installCdpNetworkCapture()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const call = addListener.mock.calls.at(-1)
  return call?.[0] as CdpListener
}

function request(emit: CdpListener, id: string, url: string, method = 'GET'): void {
  emit({ tabId: TAB }, 'Network.requestWillBeSent', {
    requestId: id,
    request: { url, method },
    type: 'XHR',
  })
}

beforeEach(() => {
  resetDebugger()
  resetNetwork()
})

describe('network capture', () => {
  it('records a request and fills in the status when the response arrives', () => {
    const emit = wireCapture()
    request(emit, 'r1', 'https://example.com/api/cart', 'POST')
    emit({ tabId: TAB }, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 201, mimeType: 'application/json' },
    })

    const entries = read(TAB)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      url: 'https://example.com/api/cart',
      method: 'POST',
      status: 201,
      mime_type: 'application/json',
    })
  })

  it('records an outright failure with its reason', () => {
    const emit = wireCapture()
    request(emit, 'r1', 'https://example.com/api/pay')
    emit({ tabId: TAB }, 'Network.loadingFailed', {
      requestId: 'r1',
      errorText: 'net::ERR_CONNECTION_REFUSED',
    })

    expect(read(TAB)[0].error).toBe('net::ERR_CONNECTION_REFUSED')
  })

  it('labels a cancelled request as cancelled rather than as an error text', () => {
    const emit = wireCapture()
    request(emit, 'r1', 'https://example.com/api/slow')
    emit({ tabId: TAB }, 'Network.loadingFailed', { requestId: 'r1', canceled: true })

    expect(read(TAB)[0].error).toBe('canceled')
  })

  it('counts a 4xx/5xx response as a failure, not just transport errors', () => {
    const emit = wireCapture()
    request(emit, 'ok', 'https://example.com/api/fine')
    emit({ tabId: TAB }, 'Network.responseReceived', { requestId: 'ok', response: { status: 200 } })
    request(emit, 'bad', 'https://example.com/api/checkout')
    emit({ tabId: TAB }, 'Network.responseReceived', { requestId: 'bad', response: { status: 500 } })

    const failures = read(TAB, { only_failures: true })
    expect(failures.map((f) => f.url)).toEqual(['https://example.com/api/checkout'])
  })

  it('filters by url substring', () => {
    const emit = wireCapture()
    request(emit, 'a', 'https://example.com/api/cart')
    request(emit, 'b', 'https://cdn.example.com/logo.png')

    expect(read(TAB, { url_pattern: '/api/' }).map((e) => e.url)).toEqual([
      'https://example.com/api/cart',
    ])
  })

  it('keeps requests separated per tab', () => {
    const emit = wireCapture()
    request(emit, 'a', 'https://example.com/one')
    emit({ tabId: 2 }, 'Network.requestWillBeSent', {
      requestId: 'b',
      request: { url: 'https://example.com/two', method: 'GET' },
    })

    expect(read(TAB)).toHaveLength(1)
    expect(read(2)).toHaveLength(1)
  })

  it('failuresSince ignores failures from before the action started', async () => {
    const emit = wireCapture()
    request(emit, 'old', 'https://example.com/api/old')
    emit({ tabId: TAB }, 'Network.loadingFailed', { requestId: 'old', errorText: 'earlier' })

    await new Promise((r) => setTimeout(r, 5))
    const actionStart = Date.now()
    await new Promise((r) => setTimeout(r, 5))

    request(emit, 'new', 'https://example.com/api/new')
    emit({ tabId: TAB }, 'Network.loadingFailed', { requestId: 'new', errorText: 'during' })

    const since = failuresSince(TAB, actionStart)
    expect(since.map((e) => e.error)).toEqual(['during'])
  })

  it('preserves request order when a later request responds first', () => {
    const emit = wireCapture()
    request(emit, 'first', 'https://example.com/slow')
    request(emit, 'second', 'https://example.com/fast')
    emit({ tabId: TAB }, 'Network.responseReceived', {
      requestId: 'second',
      response: { status: 200 },
    })
    emit({ tabId: TAB }, 'Network.responseReceived', {
      requestId: 'first',
      response: { status: 200 },
    })

    expect(read(TAB).map((e) => e.url)).toEqual([
      'https://example.com/slow',
      'https://example.com/fast',
    ])
  })

  it('ignores a response for a request it never saw', () => {
    const emit = wireCapture()
    emit({ tabId: TAB }, 'Network.responseReceived', {
      requestId: 'ghost',
      response: { status: 200 },
    })
    expect(read(TAB)).toHaveLength(0)
  })
})
