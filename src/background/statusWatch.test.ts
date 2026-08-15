import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test, clearTabStatus, installStatusWatch, resetForTests, statusPayload } from './statusWatch'

const { statusForNavigation, authHintFor } = __test

const TAB = 7

type ResponseListener = (details: {
  tabId: number
  url: string
  statusCode: number
  type: string
  timeStamp?: number
}) => void

/** Install onto the fresh chrome mock and hand back the registered listener. */
function wire(): ResponseListener {
  installStatusWatch()
  const fn = chrome.webRequest!.onResponseStarted.addListener as ReturnType<typeof vi.fn>
  return fn.mock.calls.at(-1)?.[0] as ResponseListener
}

beforeEach(() => {
  resetForTests()
})

describe('statusWatch recording', () => {
  it('records a main-frame response and answers a matching navigation', () => {
    const listener = wire()
    const before = Date.now() - 1

    listener({ tabId: TAB, url: 'https://x.test/page', statusCode: 404, type: 'main_frame' })

    expect(statusForNavigation(TAB, before, ['https://x.test/page'])).toBe(404)
  })

  it('ignores subframe responses: an iframe 500 is not the tab going somewhere', () => {
    const listener = wire()
    const before = Date.now() - 1

    listener({ tabId: TAB, url: 'https://x.test/frame', statusCode: 500, type: 'sub_frame' })

    expect(statusForNavigation(TAB, before, ['https://x.test/frame'])).toBe(null)
  })

  it('registers with the main-frame filter, matching what it may claim', () => {
    // The filter is load-bearing: without it the listener sees every subframe
    // and asset response, and the LAST one wins the record, so a page's late
    // analytics 204 would overwrite the document's own status.
    wire()
    const fn = chrome.webRequest!.onResponseStarted.addListener as ReturnType<typeof vi.fn>
    const filter = fn.mock.calls.at(-1)?.[1] as { urls: string[]; types: string[] }
    expect(filter.types).toEqual(['main_frame'])
    expect(filter.urls).toContain('https://*/*')
  })

  it('installs once: a double install would double-handle every response', () => {
    installStatusWatch()
    installStatusWatch()
    const fn = chrome.webRequest!.onResponseStarted.addListener as ReturnType<typeof vi.fn>
    expect(fn.mock.calls.length).toBe(1)
  })

  it('a throwing addListener does not escape: the worker must boot without the watch', () => {
    // installStatusWatch runs at worker top level; if registration throws on a
    // Chrome without the API, the whole worker dies and takes every OTHER
    // top-level listener with it. The guard converts that into "no records".
    const fn = chrome.webRequest!.onResponseStarted.addListener as ReturnType<typeof vi.fn>
    fn.mockImplementationOnce(() => {
      throw new Error('webRequest unavailable')
    })
    expect(() => installStatusWatch()).not.toThrow()
    expect(statusPayload(TAB, Date.now() - 1, ['https://x.test/page'])).toEqual({})
  })

  it("another tab's record never answers this tab", () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB + 1, url: 'https://x.test/page', statusCode: 404, type: 'main_frame' })

    expect(statusForNavigation(TAB, before, ['https://x.test/page'])).toBe(null)
  })
})

describe('claim rules', () => {
  it('does not claim a record older than the command', () => {
    // An older record describes the PREVIOUS document: claiming it would
    // stamp the old page's status onto the new page's payload.
    const listener = wire()
    listener({
      tabId: TAB,
      url: 'https://x.test/old',
      statusCode: 500,
      type: 'main_frame',
      timeStamp: Date.now() - 60_000,
    })

    expect(statusForNavigation(TAB, Date.now() - 1_000, ['https://x.test/old'])).toBe(null)
  })

  it('does not claim a record for a different url', () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB, url: 'https://other.test/x', statusCode: 200, type: 'main_frame' })

    expect(statusForNavigation(TAB, before, ['https://x.test/page'])).toBe(null)
  })

  it('matches through a fragment difference: the request has no hash, the commit does', () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB, url: 'https://x.test/page', statusCode: 200, type: 'main_frame' })

    expect(statusForNavigation(TAB, before, ['https://x.test/page#section-2'])).toBe(200)
  })

  it('keeps the LAST response, which is the document the tab actually shows', () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB, url: 'https://x.test/a', statusCode: 500, type: 'main_frame' })
    listener({ tabId: TAB, url: 'https://x.test/b', statusCode: 200, type: 'main_frame' })

    expect(statusForNavigation(TAB, before, ['https://x.test/b'])).toBe(200)
    expect(statusForNavigation(TAB, before, ['https://x.test/a'])).toBe(null)
  })

  it('drops the record with the tab', () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB, url: 'https://x.test/page', statusCode: 200, type: 'main_frame' })
    clearTabStatus(TAB)

    expect(statusForNavigation(TAB, before, ['https://x.test/page'])).toBe(null)
  })
})

describe('payload shape', () => {
  it('an ordinary status is the bare number, no hint', () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB, url: 'https://x.test/missing', statusCode: 404, type: 'main_frame' })

    expect(statusPayload(TAB, before, ['https://x.test/missing'])).toEqual({ http_status: 404 })
  })

  it('a 401 carries the auth-suppression hint beside the number', () => {
    const listener = wire()
    const before = Date.now() - 1
    listener({ tabId: TAB, url: 'https://x.test/private', statusCode: 401, type: 'main_frame' })

    const payload = statusPayload(TAB, before, ['https://x.test/private'])
    expect(payload.http_status).toBe(401)
    expect(String(payload.http_status_hint)).toMatch(/suppress/i)
    expect(String(payload.http_status_hint)).toMatch(/navigate/i)
  })

  it('no record means an EMPTY payload: absent is unknown, never a claim', () => {
    wire()
    expect(statusPayload(TAB, Date.now() - 1, ['https://x.test/page'])).toEqual({})
  })

  it('authHintFor covers exactly the auth pair', () => {
    expect(authHintFor(401)).not.toBeNull()
    expect(authHintFor(407)).not.toBeNull()
    expect(authHintFor(404)).toBeNull()
    expect(authHintFor(200)).toBeNull()
  })
})
