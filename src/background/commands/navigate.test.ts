import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { raceStandingDialog, standingDialog } from '../dialogs'
import { clearTabNav, installNavWatch, resetForTests as resetNavWatch } from '../navWatch'
import { installStatusWatch, resetForTests as resetStatusWatch } from '../statusWatch'
import { execNavigate } from './navigate'

// The dialogs seam is mocked so a test can INJECT a dialog opening mid-load;
// the event plumbing has its own tests in dialogs.test.ts.
vi.mock('../dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogs')>()
  return {
    ...actual,
    raceStandingDialog: vi.fn(actual.raceStandingDialog),
    standingDialog: vi.fn(actual.standingDialog),
  }
})

const TAB = 1
const START = 'https://example.com/'
const TARGET = 'https://example.org/'

type NavListener = (details: { tabId: number; url: string; frameId: number; error?: string }) => void

/** Re-bind navWatch onto the fresh chrome mock and hand back its listeners. */
function wireNav() {
  installNavWatch()
  const last = (fn: unknown): NavListener =>
    (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as NavListener
  return {
    beforeNavigate: last(chrome.webNavigation!.onBeforeNavigate.addListener),
    committed: last(chrome.webNavigation!.onCommitted.addListener),
    errorOccurred: last(chrome.webNavigation!.onErrorOccurred.addListener),
    fragmentUpdated: last(chrome.webNavigation!.onReferenceFragmentUpdated.addListener),
  }
}

type ResponseListener = (details: {
  tabId: number
  url: string
  statusCode: number
  type: string
  timeStamp?: number
}) => void

/** Re-bind statusWatch onto the fresh chrome mock, handing back its listener. */
function wireStatus(): ResponseListener {
  installStatusWatch()
  const fn = chrome.webRequest!.onResponseStarted.addListener as ReturnType<typeof vi.fn>
  return fn.mock.calls.at(-1)?.[0] as ResponseListener
}

/**
 * `chrome.tabs` as this command uses it. `get` is read by `waitForTabComplete`
 * (committed path only) and by the final re-read; the FIRST call answers the
 * starting state, later ones where the tab landed.
 *
 * `onUpdate` fires inside the `tabs.update` mock: the place a test injects
 * what the navigation DID (started, committed, aborted) via the navWatch
 * listeners, which is the browser-process timeline the executor now reads.
 * The outcome is driven by events, never by url comparison, so `landsOn` only
 * feeds what `tabs.get` reports back.
 */
function installTabsMock(opts: { landsOn: string; status?: string; startUrl?: string; onUpdate?: () => void }) {
  const { landsOn, status = 'complete', startUrl = START, onUpdate } = opts
  const title = 'Example Domain'
  let asked = false
  const get = vi.fn(async () => {
    const url = asked ? landsOn : startUrl
    asked = true
    return { id: TAB, url, title, status }
  })
  const update = vi.fn(async (_id: number, props: { url: string }) => {
    onUpdate?.()
    return { id: TAB, url: landsOn, title, status, pendingUrl: props.url }
  })
  ;(chrome.tabs.get as unknown) = get
  ;(chrome.tabs.update as unknown) = update
  return { get, update }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetNavWatch()
  resetStatusWatch()
  // Restored to no-op above; the default must be "no dialog ever opens",
  // i.e. the raced work simply resolves.
  vi.mocked(raceStandingDialog).mockImplementation(async (_tabId, work) => ({
    kind: 'work' as const,
    value: await work,
  }))
  vi.mocked(standingDialog).mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('execNavigate', () => {
  it('rejects a scheme that is not http or https', async () => {
    // file: and javascript: would turn a navigation into a local-file read or
    // script injection on whatever origin the tab is sitting on.
    const result = await execNavigate({ tab_id: TAB, url: 'javascript:alert(1)' })

    expect(result.ok).toBe(false)
  })

  it('reports success when the navigation commits and the load completes', async () => {
    const nav = wireNav()
    installTabsMock({
      landsOn: TARGET,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(true)
    const data = result.data as { url?: string; complete?: boolean }
    expect(data.url).toBe(TARGET)
    expect(data.complete).toBe(true)
  })

  it('does not fail a redirect, where the landing url legitimately differs', async () => {
    // The commit record is what the outcome reads; no url comparison against
    // the requested url exists, so a shortened link or login bounce stays a
    // success by construction.
    const nav = wireNav()
    installTabsMock({
      landsOn: 'https://example.org/landing',
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: 'https://example.org/landing', frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(true)
  })

  it('reports an honest incomplete when the commit lands but the load does not finish', async () => {
    vi.useFakeTimers()
    const nav = wireNav()
    installTabsMock({
      landsOn: TARGET,
      status: 'loading',
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    await vi.advanceTimersByTimeAsync(25_100)
    const result = await pending

    expect(result.ok).toBe(true)
    const data = result.data as { url?: string; complete?: boolean }
    expect(data.url).toBe(TARGET)
    expect(data.complete).toBe(false)
  })
})

describe('same-document navigation (finding F1)', () => {
  it('a fragment move is an arrival, never a never-started failure', async () => {
    // A hash-router SPA or a doc anchor fires NO commit at all
    // (onReferenceFragmentUpdated instead); a commit-only watcher read this
    // as "Chrome refused or swallowed the navigation", false on every
    // clause, and it aborted the rest of a batch.
    const nav = wireNav()
    const target = 'https://docs.example/guide#install'
    // A fragment move commits its url synchronously, so every tabs.get after
    // the update already reads the new url (the first-get-is-the-start
    // convention models a document LOAD, which this path never does).
    installTabsMock({
      landsOn: target,
      startUrl: target,
      onUpdate: () => {
        nav.fragmentUpdated({ tabId: TAB, url: target, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: target })

    expect(result.ok).toBe(true)
    const data = result.data as { url?: string; complete?: boolean; same_document?: boolean }
    expect(data.url).toBe(target)
    expect(data.complete).toBe(true)
    expect(data.same_document).toBe(true)
  })
})

describe('HTTP status on the committed document (#175)', () => {
  it('carries the status when the recorder saw the main-frame response', async () => {
    // The lie-by-omission this closes, measured 2026-08-12: an error page
    // COMMITS like any other page, so a 404 returned ok:true with the error
    // page's title and no status anywhere.
    const nav = wireNav()
    const status = wireStatus()
    installTabsMock({
      landsOn: TARGET,
      onUpdate: () => {
        status({ tabId: TAB, url: TARGET, statusCode: 404, type: 'main_frame' })
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(true)
    const data = result.data as { http_status?: number; http_status_hint?: string }
    expect(data.http_status).toBe(404)
    expect('http_status_hint' in data, 'only the auth pair carries a hint').toBe(false)
  })

  it('a 401 carries the auth hint: input to this tab is about to be dead', async () => {
    // The original incident: a navigate onto a Basic-auth 401 returned
    // ok:true, complete:true while Chrome was already discarding every input
    // event sent to the tab.
    const nav = wireNav()
    const status = wireStatus()
    installTabsMock({
      landsOn: TARGET,
      onUpdate: () => {
        status({ tabId: TAB, url: TARGET, statusCode: 401, type: 'main_frame' })
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    const data = result.data as { http_status?: number; http_status_hint?: string }
    expect(data.http_status).toBe(401)
    expect(String(data.http_status_hint)).toMatch(/suppress/i)
  })

  it('omits status entirely when no record exists (grant absent)', async () => {
    // The graceful-degradation contract: without the webRequest host grant
    // the listener never fires, and an absent field is the honest shape.
    // Claiming 200 here would be inventing data.
    const nav = wireNav()
    wireStatus()
    installTabsMock({
      landsOn: TARGET,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect('http_status' in data).toBe(false)
    expect('http_status_hint' in data).toBe(false)
  })

  it('does not claim a status recorded for some other load', async () => {
    const nav = wireNav()
    const status = wireStatus()
    installTabsMock({
      landsOn: TARGET,
      onUpdate: () => {
        status({ tabId: TAB, url: 'https://unrelated.example/x', statusCode: 500, type: 'main_frame' })
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.committed({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect('http_status' in (result.data as Record<string, unknown>)).toBe(false)
  })

  it('never claims a status on a same-document move: no request happened', async () => {
    const nav = wireNav()
    const status = wireStatus()
    const target = 'https://docs.example/guide#install'
    installTabsMock({
      landsOn: target,
      startUrl: target,
      onUpdate: () => {
        // Even with a fresh matching record standing (say, from the load
        // moments earlier), a fragment move fetched nothing.
        status({ tabId: TAB, url: 'https://docs.example/guide', statusCode: 200, type: 'main_frame' })
        nav.fragmentUpdated({ tabId: TAB, url: target, frameId: 0 })
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: target })

    const data = result.data as Record<string, unknown>
    expect(data.same_document).toBe(true)
    expect('http_status' in data).toBe(false)
  })
})

describe('the tab never leaves (no dialog)', () => {
  it('fails fast and honestly when no navigation ever starts', async () => {
    // The old shape here was the measured lie: ride the full 25s load wait,
    // then ok:true with the starting url sitting quietly in the payload.
    vi.useFakeTimers()
    wireNav()
    installTabsMock({ landsOn: START })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    // The start deadline is 2s; well under the old 25s ride.
    await vi.advanceTimersByTimeAsync(2_100)
    const result = await pending

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/never started/)
    const data = result.data as { url?: string; requested_url?: string }
    expect(data.url, 'the tab has NOT moved and the payload must say so').toBe(START)
    expect(data.requested_url).toBe(TARGET)
  })

  it('fails naming the abort when the navigation starts and dies (download class)', async () => {
    vi.useFakeTimers()
    const nav = wireNav()
    installTabsMock({
      landsOn: START,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        nav.errorOccurred({ tabId: TAB, url: TARGET, frameId: 0, error: 'net::ERR_ABORTED' })
      },
    })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    await vi.advanceTimersByTimeAsync(2_100)
    const result = await pending

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/started but never arrived/)
    expect(error).toMatch(/net::ERR_ABORTED/)
    expect(error, 'the download candidate is the useful hint').toMatch(/download/)
    expect((result.data as { url?: string }).url).toBe(START)
  })

  it('a late abort fails at the abort, not at the 25s deadline (finding F2)', async () => {
    // A download URL whose ERR_ABORTED arrives only after headers (slow
    // TTFB): the browser hands us the verdict at t=3s and the old wait
    // slept on it until t=25s.
    vi.useFakeTimers()
    const nav = wireNav()
    installTabsMock({
      landsOn: START,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        setTimeout(
          () => nav.errorOccurred({ tabId: TAB, url: TARGET, frameId: 0, error: 'net::ERR_ABORTED' }),
          3_000,
        )
      },
    })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    // Enough for the abort (3s) plus the replacement-settle beat (300ms),
    // nowhere near the 25s deadline: awaiting the result here proves the
    // wake happened.
    await vi.advanceTimersByTimeAsync(3_400)
    const result = await pending

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/net::ERR_ABORTED/)
  })

  it('an abort followed by a replacement navigation is judged by the replacement', async () => {
    // The page redirecting the navigation we started aborts ours and starts
    // its own moments later; failing at the abort instant would false-fail
    // the ordinary redirect-after-cancel shape.
    vi.useFakeTimers()
    const nav = wireNav()
    const replacement = 'https://example.org/replacement'
    installTabsMock({
      landsOn: replacement,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        setTimeout(() => {
          nav.errorOccurred({ tabId: TAB, url: TARGET, frameId: 0, error: 'net::ERR_ABORTED' })
          nav.beforeNavigate({ tabId: TAB, url: replacement, frameId: 0 })
        }, 500)
        setTimeout(() => nav.committed({ tabId: TAB, url: replacement, frameId: 0 }), 1_200)
      },
    })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    await vi.advanceTimersByTimeAsync(1_500)
    const result = await pending

    expect(result.ok).toBe(true)
    expect((result.data as { url?: string }).url).toBe(replacement)
  })

  it('a tab closed mid-navigation fails fast and says so', async () => {
    vi.useFakeTimers()
    const nav = wireNav()
    installTabsMock({
      landsOn: START,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
        setTimeout(() => clearTabNav(TAB), 1_000)
      },
    })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    await vi.advanceTimersByTimeAsync(1_100)
    const result = await pending

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/tab was closed/)
  })

  it('stays a success with navigation_pending when a slow site has not committed', async () => {
    // A false failure aborts the rest of a batch, so slow-but-started must
    // never fail; it reports what is still pending instead.
    vi.useFakeTimers()
    const nav = wireNav()
    installTabsMock({
      landsOn: START,
      onUpdate: () => {
        nav.beforeNavigate({ tabId: TAB, url: TARGET, frameId: 0 })
      },
    })

    const pending = execNavigate({ tab_id: TAB, url: TARGET })
    await vi.advanceTimersByTimeAsync(25_100)
    const result = await pending

    expect(result.ok).toBe(true)
    const data = result.data as {
      url?: string
      complete?: boolean
      navigation_pending?: string
      requested_url?: string
    }
    expect(data.complete).toBe(false)
    expect(data.navigation_pending).toBe(TARGET)
    expect(data.url, 'nothing asserted as arrived').toBe(START)
    expect(data.requested_url).toBe(TARGET)
  })
})

describe('beforeunload holds the navigation (#169)', () => {
  it('fails fast, names the dialog, and stays honest about where the tab is', async () => {
    // Before ownership this was the documented lie: ok:true with the tab
    // still on its old page. The dialog signal now wins the race against the
    // load wait, and the answer route is real.
    installTabsMock({ landsOn: START, status: 'loading' })
    vi.mocked(raceStandingDialog).mockResolvedValue({
      kind: 'dialog',
      dialog: {
        type: 'beforeunload' as const,
        message: '',
        url: START,
        openedAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
      },
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/asked to confirm leaving/)
    expect(error).toMatch(/chrome_dialog\(tab_id=1, action="accept"\)/)
    expect(error, 'unsaved state is the user cue').toMatch(/unsaved/)
    const data = result.data as { url?: string; requested_url?: string; dialog?: unknown }
    expect(data.url, 'the tab has NOT moved and the payload must say so').toBe(START)
    expect(data.requested_url).toBe(TARGET)
    expect(data.dialog).toBeDefined()
  })

  it('catches a dialog even when a stale complete-read wins the race', async () => {
    // waitForTabComplete can win by reading the OLD page's status:"complete"
    // before the load it just triggered starts (settle.ts documents exactly
    // this trap), and a beforeunload standing at that instant would ride the
    // early-out back to the pre-#169 dishonest success. Whichever way the
    // race goes, a dialog standing NOW is the story.
    installTabsMock({ landsOn: START })
    vi.mocked(standingDialog).mockReturnValue({
      type: 'beforeunload' as const,
      message: '',
      url: START,
      openedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    })

    const result = await execNavigate({ tab_id: TAB, url: TARGET })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/asked to confirm leaving/)
    expect((result.data as { url?: string }).url).toBe(START)
  })
})
