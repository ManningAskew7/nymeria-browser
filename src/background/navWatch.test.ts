import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTabNav,
  commitSeq,
  commitSince,
  installNavWatch,
  navigationError,
  navigationPending,
  resetForTests,
  sameDocumentSince,
  waitForNavSignal,
} from './navWatch'

const TAB = 7
const T0 = 0

type NavListener = (details: {
  tabId: number
  url: string
  frameId: number
  error?: string
}) => void

interface Wired {
  beforeNavigate: NavListener
  committed: NavListener
  errorOccurred: NavListener
  fragmentUpdated: NavListener
  historyUpdated: NavListener
}

/**
 * Re-bind the watch onto the freshly installed chrome mock and hand back the
 * listeners, so these tests exercise the real event path (the same pattern
 * networkBuffer.test.ts uses).
 */
function wire(): Wired {
  installNavWatch()
  const last = (fn: unknown): NavListener =>
    (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as NavListener
  return {
    beforeNavigate: last(chrome.webNavigation!.onBeforeNavigate.addListener),
    committed: last(chrome.webNavigation!.onCommitted.addListener),
    errorOccurred: last(chrome.webNavigation!.onErrorOccurred.addListener),
    fragmentUpdated: last(chrome.webNavigation!.onReferenceFragmentUpdated.addListener),
    historyUpdated: last(chrome.webNavigation!.onHistoryStateUpdated.addListener),
  }
}

beforeEach(() => {
  resetForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('commit bookkeeping', () => {
  it('increments the seq per top-frame commit, per tab', () => {
    const w = wire()
    expect(commitSeq(TAB)).toBe(0)
    w.committed({ tabId: TAB, url: 'https://a.example/', frameId: 0 })
    w.committed({ tabId: TAB, url: 'https://b.example/', frameId: 0 })
    w.committed({ tabId: 99, url: 'https://other.example/', frameId: 0 })
    expect(commitSeq(TAB)).toBe(2)
    expect(commitSeq(99)).toBe(1)
  })

  it('ignores subframe events on all five listeners', () => {
    const w = wire()
    w.beforeNavigate({ tabId: TAB, url: 'https://iframe.example/', frameId: 3 })
    w.committed({ tabId: TAB, url: 'https://iframe.example/', frameId: 3 })
    w.errorOccurred({ tabId: TAB, url: 'https://iframe.example/', frameId: 3, error: 'net::ERR_FAILED' })
    w.fragmentUpdated({ tabId: TAB, url: 'https://iframe.example/#x', frameId: 3 })
    w.historyUpdated({ tabId: TAB, url: 'https://iframe.example/spa', frameId: 3 })
    expect(commitSeq(TAB)).toBe(0)
    expect(navigationPending(TAB, T0)).toBeNull()
    expect(navigationError(TAB, T0)).toBeNull()
    expect(sameDocumentSince(TAB, T0)).toBeNull()
  })

  it('commitSince answers only commits newer than the sampled seq', () => {
    const w = wire()
    w.committed({ tabId: TAB, url: 'https://a.example/', frameId: 0 })
    const sampled = commitSeq(TAB)
    expect(commitSince(TAB, sampled)).toBeNull()
    w.committed({ tabId: TAB, url: 'https://b.example/', frameId: 0 })
    expect(commitSince(TAB, sampled)?.url).toBe('https://b.example/')
  })

  it('a double install does not double-count commits', () => {
    wire()
    const w2 = wire()
    w2.committed({ tabId: TAB, url: 'https://a.example/', frameId: 0 })
    expect(commitSeq(TAB)).toBe(1)
  })
})

describe('pending, error, and same-document lifecycle', () => {
  it('a start sets pending; the commit clears it', () => {
    const w = wire()
    w.beforeNavigate({ tabId: TAB, url: 'https://slow.example/', frameId: 0 })
    expect(navigationPending(TAB, T0)?.url).toBe('https://slow.example/')
    w.committed({ tabId: TAB, url: 'https://slow.example/', frameId: 0 })
    expect(navigationPending(TAB, T0)).toBeNull()
  })

  it('pending is attributed by time: a navigation from before the window is not reported', () => {
    const w = wire()
    w.beforeNavigate({ tabId: TAB, url: 'https://older.example/', frameId: 0 })
    expect(navigationPending(TAB, Date.now() + 10_000)).toBeNull()
  })

  it('an error clears pending and is readable with its reason', () => {
    const w = wire()
    const before = Date.now()
    w.beforeNavigate({ tabId: TAB, url: 'https://dl.example/file.pdf', frameId: 0 })
    w.errorOccurred({ tabId: TAB, url: 'https://dl.example/file.pdf', frameId: 0, error: 'net::ERR_ABORTED' })
    expect(navigationPending(TAB, T0)).toBeNull()
    const err = navigationError(TAB, before)
    expect(err?.error).toBe('net::ERR_ABORTED')
    expect(navigationError(TAB, Date.now() + 10_000)).toBeNull()
  })

  it('a later commit clears a recorded error', () => {
    const w = wire()
    const before = Date.now()
    w.errorOccurred({ tabId: TAB, url: 'https://x.example/', frameId: 0, error: 'net::ERR_ABORTED' })
    w.committed({ tabId: TAB, url: 'https://x.example/retry', frameId: 0 })
    expect(navigationError(TAB, before)).toBeNull()
  })

  it('fragment and history-API moves record as same-document, not commits', () => {
    const w = wire()
    w.fragmentUpdated({ tabId: TAB, url: 'https://doc.example/guide#install', frameId: 0 })
    expect(sameDocumentSince(TAB, T0)?.url).toBe('https://doc.example/guide#install')
    expect(commitSeq(TAB)).toBe(0)
    w.historyUpdated({ tabId: TAB, url: 'https://app.example/inbox', frameId: 0 })
    expect(sameDocumentSince(TAB, T0)?.url).toBe('https://app.example/inbox')
    expect(commitSeq(TAB)).toBe(0)
  })

  it('tab teardown drops all state', () => {
    const w = wire()
    w.beforeNavigate({ tabId: TAB, url: 'https://a.example/', frameId: 0 })
    w.committed({ tabId: TAB, url: 'https://a.example/', frameId: 0 })
    clearTabNav(TAB)
    expect(commitSeq(TAB)).toBe(0)
    expect(navigationPending(TAB, T0)).toBeNull()
  })
})

describe('waitForNavSignal', () => {
  it('resolves early when the commit arrives', async () => {
    const w = wire()
    const sampled = commitSeq(TAB)
    const wait = waitForNavSignal(TAB, sampled, Date.now(), 5_000)
    w.committed({ tabId: TAB, url: 'https://landed.example/', frameId: 0 })
    const signal = await wait
    expect(signal).toMatchObject({ kind: 'commit', url: 'https://landed.example/' })
  })

  it('resolves immediately when the commit already landed', async () => {
    const w = wire()
    const sampled = commitSeq(TAB)
    w.committed({ tabId: TAB, url: 'https://fast.example/', frameId: 0 })
    const signal = await waitForNavSignal(TAB, sampled, Date.now() - 1, 5_000)
    expect(signal).toMatchObject({ kind: 'commit', url: 'https://fast.example/' })
  })

  it('wakes on an abort instead of riding the deadline', async () => {
    const w = wire()
    const wait = waitForNavSignal(TAB, 0, Date.now(), 25_000)
    w.errorOccurred({ tabId: TAB, url: 'https://x.example/', frameId: 0, error: 'net::ERR_ABORTED' })
    const signal = await wait
    expect(signal).toMatchObject({ kind: 'error', error: 'net::ERR_ABORTED' })
  })

  it('wakes on a same-document move', async () => {
    const w = wire()
    const wait = waitForNavSignal(TAB, 0, Date.now(), 25_000)
    w.fragmentUpdated({ tabId: TAB, url: 'https://doc.example/#anchor', frameId: 0 })
    const signal = await wait
    expect(signal).toMatchObject({ kind: 'same-document', url: 'https://doc.example/#anchor' })
  })

  it('wakes with removed when the tab is torn down', async () => {
    wire()
    const wait = waitForNavSignal(TAB, 0, Date.now(), 25_000)
    clearTabNav(TAB)
    const signal = await wait
    expect(signal).toMatchObject({ kind: 'removed' })
  })

  it('resolves null at the deadline with nothing to report', async () => {
    vi.useFakeTimers()
    wire()
    const wait = waitForNavSignal(TAB, 0, Date.now(), 1_000)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await wait).toBeNull()
  })

  it('one commit resolves every live waiter', async () => {
    const w = wire()
    const first = waitForNavSignal(TAB, 0, Date.now(), 5_000)
    const second = waitForNavSignal(TAB, 0, Date.now(), 5_000)
    w.committed({ tabId: TAB, url: 'https://both.example/', frameId: 0 })
    expect(await first).toMatchObject({ kind: 'commit' })
    expect(await second).toMatchObject({ kind: 'commit' })
  })

  it('a timed-out waiter does not steal a later signal from a live one', async () => {
    vi.useFakeTimers()
    const w = wire()
    const dead = waitForNavSignal(TAB, 0, Date.now(), 500)
    const live = waitForNavSignal(TAB, 0, Date.now(), 5_000)
    await vi.advanceTimersByTimeAsync(501)
    expect(await dead).toBeNull()
    w.committed({ tabId: TAB, url: 'https://late.example/', frameId: 0 })
    expect(await live).toMatchObject({ kind: 'commit', url: 'https://late.example/' })
  })
})
