import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execNetwork } from './network'
import {
  installCdpEventRouter,
  installDetachHandler,
  resetForTests as resetDebugger,
  sendCommand,
} from '../debuggerSession'
import { installCdpNetworkCapture, resetForTests as resetNetwork } from '../networkBuffer'

const TAB = 1

type CdpListener = (
  source: { tabId: number; sessionId?: string },
  method: string,
  params: unknown,
) => void

function wireCapture(): CdpListener {
  installCdpEventRouter()
  installCdpNetworkCapture()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  return addListener.mock.calls.at(-1)?.[0] as CdpListener
}

function request(
  emit: CdpListener,
  id: string,
  url: string,
  outcome: { status?: number; error?: string } = {},
): void {
  emit({ tabId: TAB }, 'Network.requestWillBeSent', {
    requestId: id,
    request: { url, method: 'GET' },
    type: 'XHR',
  })
  if (outcome.status !== undefined) {
    emit({ tabId: TAB }, 'Network.responseReceived', {
      requestId: id,
      response: { status: outcome.status, mimeType: 'application/json' },
    })
  }
  if (outcome.error !== undefined) {
    emit({ tabId: TAB }, 'Network.loadingFailed', { requestId: id, errorText: outcome.error })
  }
}

/** Attach the tab the way any earlier command would have. */
async function attach(): Promise<void> {
  await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
}

/**
 * End the session while leaving the buffer alone: what the idle detach linger
 * does between commands, and what a Chrome-side detach does immediately. Only
 * closing the tab clears captured history.
 */
function detachTab(): void {
  installDetachHandler()
  const addListener = chrome.debugger.onDetach.addListener as unknown as ReturnType<typeof vi.fn>
  const listener = addListener.mock.calls.at(-1)?.[0] as (
    source: { tabId: number },
    reason: string,
  ) => void
  listener({ tabId: TAB }, 'canceled_by_user')
}

function payload(result: { data?: unknown }) {
  return result.data as {
    requests: { url: string; status?: number; error?: string }[]
    count: number
    filtered: boolean
    matched_total?: number
    capture_started_now?: boolean
    capture_resumed?: boolean
  }
}

beforeEach(() => {
  resetDebugger()
  resetNetwork()
})

describe('execNetwork', () => {
  it('refuses without a tab_id before touching the browser', async () => {
    const result = await execNetwork({})

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/tab_id/)
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('says capture just started when the read is what attached the tab', async () => {
    // Capture begins at ATTACH, so a first-ever read of a tab is necessarily
    // empty. A bare "count: 0" reads as "this page made no requests", which is
    // a claim about the page rather than about the buffer (#162 class).
    wireCapture()

    const data = payload(await execNetwork({ tab_id: TAB }))

    expect(chrome.debugger.attach).toHaveBeenCalled()
    expect(data.count).toBe(0)
    expect(data.capture_started_now, 'a cold read must not pass as an empty history').toBe(true)
    expect(data.capture_resumed).toBeUndefined()
  })

  it('says capture had lapsed when the tab was captured before but is detached now', async () => {
    // Capture is NOT continuous: the debugger is released after a short idle
    // linger, so a read that follows a pause re-attaches. Claiming capture
    // "started now" there would be a lie next to entries the answer still
    // carries, and it would tell the agent to disregard data it can see.
    const emit = wireCapture()
    await attach()
    request(emit, 'r1', 'https://example.com/api/cart', { status: 200 })
    detachTab()

    const data = payload(await execNetwork({ tab_id: TAB }))

    expect(data.count).toBe(1)
    expect(data.capture_resumed, 'a gap in capture is its own fact').toBe(true)
    expect(data.capture_started_now, 'the history is real, so this is not a cold start').toBeUndefined()
  })

  it('says nothing of the kind on a warm read, which reports real history', async () => {
    const emit = wireCapture()
    await attach()
    request(emit, 'r1', 'https://example.com/api/cart', { status: 200 })

    const data = payload(await execNetwork({ tab_id: TAB }))

    expect(data.count).toBe(1)
    expect(data.requests[0].status).toBe(200)
    expect(
      data.capture_started_now,
      'a warm read has the whole history and must not hedge',
    ).toBeUndefined()
  })

  it('filters by url substring and by failure, and flags that it filtered', async () => {
    const emit = wireCapture()
    await attach()
    request(emit, 'a', 'https://example.com/api/cart', { status: 200 })
    request(emit, 'b', 'https://cdn.example.com/logo.png', { status: 200 })
    request(emit, 'c', 'https://example.com/api/pay', { status: 500 })

    const all = payload(await execNetwork({ tab_id: TAB }))
    const matched = payload(await execNetwork({ tab_id: TAB, url_pattern: '/api/' }))
    const failed = payload(await execNetwork({ tab_id: TAB, only_failures: true }))

    expect(all.count).toBe(3)
    expect(all.filtered).toBe(false)
    expect(matched.requests.map((r) => r.url)).toEqual([
      'https://example.com/api/cart',
      'https://example.com/api/pay',
    ])
    expect(matched.filtered).toBe(true)
    expect(failed.requests.map((r) => r.url)).toEqual(['https://example.com/api/pay'])
    expect(failed.filtered).toBe(true)
  })

  it('takes limit 0 for none, not for everything', async () => {
    // `limit: 0` used to fall through a `> 0` guard and return the WHOLE
    // buffer: the one spelling that unambiguously asks for nothing returned
    // the most the tool can give.
    const emit = wireCapture()
    await attach()
    request(emit, 'a', 'https://example.com/one')
    request(emit, 'b', 'https://example.com/two')

    const none = payload(await execNetwork({ tab_id: TAB, limit: 0 }))
    const newest = payload(await execNetwork({ tab_id: TAB, limit: 1 }))

    expect(none.count).toBe(0)
    expect(none.requests).toEqual([])
    expect(newest.requests.map((r) => r.url)).toEqual(['https://example.com/two'])
    // And a cut answer says how much it cut: measured live 2026-08-17,
    // `count: 0` with 8 entries in the buffer was indistinguishable from a
    // buffer that captured nothing, which is the very read this tool is
    // being taught out of.
    expect(none.matched_total).toBe(2)
    expect(newest.matched_total).toBe(2)
  })

  it('says nothing about a total when the limit cut nothing', async () => {
    const emit = wireCapture()
    await attach()
    request(emit, 'a', 'https://example.com/one')

    const all = payload(await execNetwork({ tab_id: TAB }))

    expect(all.count).toBe(1)
    expect(all.matched_total, 'an untruncated answer must not grow furniture').toBeUndefined()
  })

  it('counts the total AFTER the filters, not the whole buffer', async () => {
    // A total that ignored url_pattern would tell the agent rows were cut
    // that never matched in the first place.
    const emit = wireCapture()
    await attach()
    request(emit, 'a', 'https://example.com/api/one')
    request(emit, 'b', 'https://cdn.example.com/logo.png')
    request(emit, 'c', 'https://example.com/api/two')

    const data = payload(await execNetwork({ tab_id: TAB, url_pattern: '/api/', limit: 1 }))

    expect(data.count).toBe(1)
    expect(data.matched_total).toBe(2)
  })

  it('clear empties the buffer only after handing back what it held', async () => {
    const emit = wireCapture()
    await attach()
    request(emit, 'a', 'https://example.com/one')

    const first = payload(await execNetwork({ tab_id: TAB, clear: true }))
    const second = payload(await execNetwork({ tab_id: TAB }))

    expect(first.requests.map((r) => r.url)).toEqual(['https://example.com/one'])
    expect(second.count).toBe(0)
    // The tab is still attached, so the empty second read is genuine silence,
    // not a cold start.
    expect(second.capture_started_now).toBeUndefined()
  })

  it('does not call a cleared or silent tab a cold start once the session lapses', async () => {
    // An emptied buffer is not an unwatched tab. Answering "has anything been
    // captured" from the buffer made a cleared tab, and a driven tab that
    // simply made no requests, both claim nothing had ever watched them.
    const emit = wireCapture()
    await attach()
    request(emit, 'a', 'https://example.com/one')
    await execNetwork({ tab_id: TAB, clear: true })
    detachTab()

    const afterClear = payload(await execNetwork({ tab_id: TAB }))

    expect(afterClear.count).toBe(0)
    expect(afterClear.capture_started_now, 'this tab has been watched').toBeUndefined()
    expect(afterClear.capture_resumed).toBe(true)

    // Same for a tab that was driven but never made a request.
    resetDebugger()
    resetNetwork()
    wireCapture()
    await attach()
    detachTab()

    const silent = payload(await execNetwork({ tab_id: TAB }))

    expect(silent.count).toBe(0)
    expect(silent.capture_started_now).toBeUndefined()
    expect(silent.capture_resumed).toBe(true)
  })
})
