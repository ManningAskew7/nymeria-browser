import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectBeforeunloadAccept } from '../dialogs'
import { installStatusWatch, resetForTests as resetStatusWatch } from '../statusWatch'
import { execTabs } from './tabs'
import { TAB_LOAD_WAIT_MS } from '../settle'

// Only the close-intent seam is stubbed; everything else stays real.
vi.mock('../dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogs')>()
  return { ...actual, expectBeforeunloadAccept: vi.fn() }
})

const TAB = 42

/**
 * A `chrome.tabs` mock that models the one property these tests are about:
 * `create` and `reload` resolve the instant Chrome ACCEPTS the request, long
 * before the document is there. Measured live 2026-08-12, where a read
 * immediately after a create returned a one-element tree for a page whose
 * buttons were plainly present.
 */
function installTabsMock(
  opts: {
    loadAfterMs?: number | null
    initialStatus?: string
    silentComplete?: boolean
    /** The user's own sticky per-site zoom for this tab, 1.25 = 125%. */
    originZoom?: number
  } = {},
) {
  const {
    loadAfterMs = 500,
    initialStatus = 'loading',
    silentComplete = false,
    originZoom = 1.25,
  } = opts
  // Models the part of Chrome's zoom behaviour the tool turns on: the factor
  // follows the SCOPE, so dropping back to per-origin restores whatever the
  // user themselves had set for the site.
  const zoomState = { factor: originZoom, scope: 'per-origin' as string }
  const listeners: Array<(id: number, info: { status?: string }) => void> = []
  const state = { status: initialStatus, url: 'https://example.com/', title: 'Example' }

  const finishLoad = () => {
    state.status = 'complete'
    state.url = 'https://example.com/loaded'
    state.title = 'Loaded'
    // silentComplete models the load finishing in the window between
    // waitForTabComplete reading the status and attaching its listener: the
    // state moves on, but no event is ever delivered to a listener.
    if (!silentComplete) for (const l of [...listeners]) l(TAB, { status: 'complete' })
  }

  ;(chrome.tabs as unknown) = {
    create: vi.fn(async () => {
      // Chrome hands back the tab as it is NOW: loading, pre-navigation url.
      if (loadAfterMs != null) setTimeout(finishLoad, loadAfterMs)
      return { id: TAB, url: 'about:blank', title: '', status: 'loading', active: true, windowId: 1, index: 0 }
    }),
    reload: vi.fn(async () => {
      if (loadAfterMs != null) setTimeout(finishLoad, loadAfterMs)
    }),
    get: vi.fn(async () => ({
      id: TAB,
      url: state.url,
      title: state.title,
      status: state.status,
      active: true,
      windowId: 1,
      index: 0,
    })),
    query: vi.fn(async () => []),
    update: vi.fn(async () => ({ id: TAB, windowId: 1 })),
    remove: vi.fn(async () => undefined),
    getZoom: vi.fn(async () => zoomState.factor),
    setZoom: vi.fn(async (_id: number, factor: number) => {
      zoomState.factor = factor
    }),
    getZoomSettings: vi.fn(async () => ({ scope: zoomState.scope, mode: 'automatic' })),
    setZoomSettings: vi.fn(async (_id: number, s: { scope?: string }) => {
      if (s.scope) zoomState.scope = s.scope
      // Returning to per-origin hands the tab back to the user's own setting,
      // which is the whole point of the undo.
      if (s.scope === 'per-origin') zoomState.factor = originZoom
    }),
    onUpdated: {
      addListener: (fn: (id: number, info: { status?: string }) => void) => listeners.push(fn),
      removeListener: (fn: (id: number, info: { status?: string }) => void) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      },
    },
  }
  ;(chrome.windows as unknown) = {
    update: vi.fn(async () => undefined),
    getAll: vi.fn(async () => [{ id: 1, focused: true, type: 'normal' }]),
    getLastFocused: vi.fn(async () => ({ id: 1, focused: true, type: 'normal' })),
  }
  return { finishLoad, listenerCount: () => listeners.length }
}

beforeEach(() => {
  vi.useRealTimers()
  resetStatusWatch()
})

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

describe('tabs create', () => {
  it('does not return until the page has actually loaded', async () => {
    // The bug this closes: create returned immediately, so the very next read
    // raced the commit and saw whatever had arrived by then. The kit
    // recommends create-then-read, so most sessions hit it.
    vi.useFakeTimers()
    try {
      installTabsMock({ loadAfterMs: 800 })

      let settled = false
      const pending = execTabs({ action: 'create', url: 'https://example.com/' }).then((r) => {
        settled = true
        return r
      })

      await vi.advanceTimersByTimeAsync(400)
      expect(settled, 'must still be waiting while the tab is loading').toBe(false)

      await vi.advanceTimersByTimeAsync(600)
      const result = await pending
      expect(result.ok).toBe(true)
      expect((result.data as { complete: boolean }).complete).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the loaded url and title, not the ones create handed back', async () => {
    // chrome.tabs.create resolves with the tab AS IT WAS: about:blank, no
    // title. Returning that after waiting would describe a page that no longer
    // exists, which is how an agent ends up reasoning about the wrong document.
    installTabsMock({ loadAfterMs: 10 })

    const result = await execTabs({ action: 'create', url: 'https://example.com/' })

    const tab = (result.data as { tab: { url: string; title: string } }).tab
    expect(tab.url).toBe('https://example.com/loaded')
    expect(tab.title).toBe('Loaded')
  })

  it('says so honestly when the load never finishes, rather than hanging or lying', async () => {
    vi.useFakeTimers()
    try {
      installTabsMock({ loadAfterMs: null })

      let settled = false
      const pending = execTabs({ action: 'create', url: 'https://example.com/' }).then((r) => {
        settled = true
        return r
      })

      // Pinned either side of the bound. Advancing straight past everything
      // would pass with the wait raised to any value, including one past the
      // BACKEND's budget, where the honest `complete: false` never reaches the
      // agent and it gets a bare transport timeout instead.
      await vi.advanceTimersByTimeAsync(TAB_LOAD_WAIT_MS - 1_000)
      expect(settled, 'must still be waiting just under the bound').toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)

      const result = await pending
      expect(settled).toBe(true)
      expect(result.ok).toBe(true)
      expect((result.data as { complete: boolean }).complete).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('trusts the re-read when the completion lands in the listener gap', async () => {
    // waitForTabComplete reads the status and only then attaches its listener,
    // so a completion in between is never delivered and the wait runs to its
    // bound. Without reconciling against the re-read, the payload would say
    // `status: "complete"` and `complete: false` in the same breath.
    vi.useFakeTimers()
    try {
      installTabsMock({ loadAfterMs: 10, silentComplete: true })

      const pending = execTabs({ action: 'create', url: 'https://example.com/' })
      await vi.advanceTimersByTimeAsync(TAB_LOAD_WAIT_MS + 1_000)
      const result = await pending

      const data = result.data as { complete: boolean; tab: { status: string } }
      expect(data.tab.status).toBe('complete')
      expect(data.complete, 'must not contradict the status it just read').toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails honestly when the tab is closed while it loads', async () => {
    // Returning ok:true with the pre-load about:blank tab hands the agent a
    // tab_id that fails on its very next call.
    vi.useFakeTimers()
    try {
      const mock = installTabsMock({ loadAfterMs: null })
      ;(chrome.tabs.get as unknown) = vi.fn(async () => {
        throw new Error('No tab with id: 42')
      })
      void mock

      const pending = execTabs({ action: 'create', url: 'https://example.com/' })
      await vi.advanceTimersByTimeAsync(TAB_LOAD_WAIT_MS + 1_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/closed while it was loading/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('driven tab placement (multi-window)', () => {
  // Creating in the user's focused window rips their view away mid-task
  // (measured 2026-08-16: the operator was watching a stream there and every
  // driven tab landed on top of it). With a second normal window, driven
  // tabs go THERE; with one window there is nowhere politer to go.
  it('creates the tab in a non-focused window when one exists', async () => {
    installTabsMock({ loadAfterMs: 10 })
    ;(chrome.windows.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, focused: true, type: 'normal' },
      { id: 2, focused: false, type: 'normal' },
    ])
    ;(chrome.windows.getLastFocused as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      focused: true,
      type: 'normal',
    })

    await execTabs({ action: 'create', url: 'https://example.com/' })

    const createArgs = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(createArgs).toMatchObject({ url: 'https://example.com/', windowId: 2 })
  })

  it('avoids the last-focused window even when Chrome itself is unfocused', async () => {
    // Alt-tabbed away, every window reports focused: false; getLastFocused
    // still names the one the user considers theirs.
    installTabsMock({ loadAfterMs: 10 })
    ;(chrome.windows.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 7, focused: false, type: 'normal' },
      { id: 9, focused: false, type: 'normal' },
    ])
    ;(chrome.windows.getLastFocused as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 9,
      focused: false,
      type: 'normal',
    })

    await execTabs({ action: 'create', url: 'https://example.com/' })

    const createArgs = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(createArgs).toMatchObject({ windowId: 7 })
  })

  it('skips minimized and incognito windows when picking the driven one', async () => {
    // A minimized window stops compositing, the exact screenshot-hang and
    // auth-cancel state the second window exists to avoid (#165); incognito
    // is not the user's ordinary logged-in session.
    installTabsMock({ loadAfterMs: 10 })
    ;(chrome.windows.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, focused: true, type: 'normal' },
      { id: 2, focused: false, type: 'normal', state: 'minimized' },
      { id: 3, focused: false, type: 'normal', incognito: true },
      { id: 4, focused: false, type: 'normal', state: 'normal' },
    ])
    ;(chrome.windows.getLastFocused as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      focused: true,
      type: 'normal',
    })

    await execTabs({ action: 'create', url: 'https://example.com/' })

    const createArgs = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(createArgs).toMatchObject({ windowId: 4 })
  })

  it('falls back to the current window when the only other window is minimized', async () => {
    installTabsMock({ loadAfterMs: 10 })
    ;(chrome.windows.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, focused: true, type: 'normal' },
      { id: 2, focused: false, type: 'normal', state: 'minimized' },
    ])
    ;(chrome.windows.getLastFocused as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      focused: true,
      type: 'normal',
    })

    await execTabs({ action: 'create', url: 'https://example.com/' })

    const createArgs = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(createArgs).not.toHaveProperty('windowId')
  })

  it('passes no windowId with a single window', async () => {
    installTabsMock({ loadAfterMs: 10 })

    await execTabs({ action: 'create', url: 'https://example.com/' })

    const createArgs = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(createArgs).not.toHaveProperty('windowId')
  })

  it('falls back to the old behavior when the windows query fails', async () => {
    installTabsMock({ loadAfterMs: 10 })
    ;(chrome.windows.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'))

    const result = await execTabs({ action: 'create', url: 'https://example.com/' })

    expect(result.ok).toBe(true)
    const createArgs = (chrome.tabs.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(createArgs).not.toHaveProperty('windowId')
  })
})

describe('HTTP status on create and reload (#175)', () => {
  it('create carries the loaded document status: the kit flow has the same blind spot', async () => {
    installTabsMock({ loadAfterMs: 10 })
    const status = wireStatus()

    const pending = execTabs({ action: 'create', url: 'https://example.com/' })
    // Fired mid-load, after create sampled its clock: the shape a real
    // response event takes.
    status({ tabId: TAB, url: 'https://example.com/loaded', statusCode: 500, type: 'main_frame' })
    const result = await pending

    expect(result.ok).toBe(true)
    expect((result.data as { http_status?: number }).http_status).toBe(500)
  })

  it('create omits status when the recorder never saw the load', async () => {
    installTabsMock({ loadAfterMs: 10 })
    wireStatus()

    const result = await execTabs({ action: 'create', url: 'https://example.com/' })

    expect(result.ok).toBe(true)
    expect('http_status' in (result.data as Record<string, unknown>)).toBe(false)
  })

  it('reload carries the re-fetched document status', async () => {
    installTabsMock({ loadAfterMs: 10, initialStatus: 'complete' })
    const status = wireStatus()

    const pending = execTabs({ action: 'reload', tab_id: TAB })
    status({ tabId: TAB, url: 'https://example.com/loaded', statusCode: 404, type: 'main_frame' })
    const result = await pending

    expect(result.ok).toBe(true)
    expect((result.data as { http_status?: number }).http_status).toBe(404)
  })
})

describe('tabs reload', () => {
  it('waits for the NEW document, not the old one that still reads complete', async () => {
    // The fail-open that makes this verb different from create: at the instant
    // reload() resolves, the tab still reports the OLD document as complete.
    // An already-complete early-out returns true immediately and waits for
    // nothing, which is the same race wearing a passing test.
    vi.useFakeTimers()
    try {
      installTabsMock({ loadAfterMs: 700, initialStatus: 'complete' })

      let settled = false
      const pending = execTabs({ action: 'reload', tab_id: TAB }).then((r) => {
        settled = true
        return r
      })

      await vi.advanceTimersByTimeAsync(300)
      expect(settled, 'the old document reading complete must not end the wait').toBe(false)

      await vi.advanceTimersByTimeAsync(500)
      const result = await pending
      expect((result.data as { complete: boolean }).complete).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tabs cheap actions', () => {
  it('does not make list, switch or close wait on anything', async () => {
    // These are why the tabs command family has a short transport budget. A
    // wait leaking into them would turn a disconnected extension from a 5s
    // answer into a 30s one.
    vi.useFakeTimers()
    try {
      const { listenerCount } = installTabsMock({ loadAfterMs: null })

      const results = await Promise.all([
        execTabs({ action: 'list' }),
        execTabs({ action: 'switch', tab_id: TAB }),
        execTabs({ action: 'close', tab_id: TAB }),
      ])

      for (const r of results) expect(r.ok).toBe(true)
      expect(listenerCount(), 'no load watcher may be left behind').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tabs close and beforeunload (#169)', () => {
  it('registers accept-intent before removing, so close always clears the tab', async () => {
    // Close is the recovery path: a "Leave site?" the close itself raises is
    // auto-accepted rather than held, and the intent must be registered
    // BEFORE the remove goes out or the dialog can open unregistered.
    vi.mocked(expectBeforeunloadAccept).mockClear()
    installTabsMock({ loadAfterMs: null })

    const result = await execTabs({ action: 'close', tab_id: TAB })

    expect(result.ok).toBe(true)
    expect(vi.mocked(expectBeforeunloadAccept)).toHaveBeenCalledWith(TAB)
    const intentOrder = vi.mocked(expectBeforeunloadAccept).mock.invocationCallOrder[0]
    const removeOrder = (chrome.tabs.remove as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(intentOrder).toBeLessThan(removeOrder)
  })
})

describe('tabs zoom (#233)', () => {
  const zoomFn = (name: string) =>
    (chrome.tabs as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

  it('reads the zoom without changing it, which is the only way to spot a zoomed tab', async () => {
    // The motivating case: page zoom is per-site and sticky, so a tab can sit
    // at 125% from something the user did weeks ago. At any zoom but 100% a
    // region capture is aimed at the wrong box (#231) and publishes no
    // [Frame], and before this there was no way to find that out at all.
    installTabsMock({ loadAfterMs: null, originZoom: 1.25 })

    const result = await execTabs({ action: 'zoom', tab_id: TAB })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ zoom: 1.25, percent: 125, scope: 'per-origin' })
    expect(zoomFn('setZoom'), 'a read must not write').not.toHaveBeenCalled()
    expect(zoomFn('setZoomSettings'), 'nor touch the scope').not.toHaveBeenCalled()
  })

  it('confines a set to this tab BEFORE setting it, so it cannot rewrite the user preference', async () => {
    // The order is the whole safety property. Chrome's default scope is
    // per-ORIGIN and permanent: a setZoom that landed before the scope change
    // would rewrite the user's saved preference for that entire site, in
    // every tab, for good, as a side effect of wanting one accurate capture.
    installTabsMock({ loadAfterMs: null, originZoom: 1.25 })

    const result = await execTabs({ action: 'zoom', tab_id: TAB, zoom: 1.0 })

    expect(result.ok).toBe(true)
    expect(zoomFn('setZoomSettings')).toHaveBeenCalledWith(TAB, { scope: 'per-tab' })
    const scopeOrder = zoomFn('setZoomSettings').mock.invocationCallOrder[0]
    const setOrder = zoomFn('setZoom').mock.invocationCallOrder[0]
    expect(scopeOrder, 'scope must be confined first').toBeLessThan(setOrder)
    // And the agent is told the cost of that choice up front, rather than
    // discovering it when a navigation quietly drops the zoom mid-drive.
    expect(result.data).toMatchObject({ zoom: 1, percent: 100, resets_on_navigation: true })
  })

  it('undoes with 0 by restoring the scope, so the user gets their own zoom back', async () => {
    // 0 is a scope restore, not a factor. Zeroing the factor instead would
    // leave the tab pinned per-tab, still ignoring the user's preference and
    // silently diverging from every other tab on the site.
    installTabsMock({ loadAfterMs: null, originZoom: 1.25 })
    await execTabs({ action: 'zoom', tab_id: TAB, zoom: 1.0 })

    const result = await execTabs({ action: 'zoom', tab_id: TAB, zoom: 0 })

    expect(result.ok).toBe(true)
    expect(zoomFn('setZoomSettings')).toHaveBeenLastCalledWith(TAB, { scope: 'per-origin' })
    expect(result.data).toMatchObject({
      zoom: 1.25,
      percent: 125,
      scope: 'per-origin',
      restored_to_user_setting: true,
    })
  })

  it('refuses a factor outside Chrome range without touching the browser', async () => {
    installTabsMock({ loadAfterMs: null })

    const result = await execTabs({ action: 'zoom', tab_id: TAB, zoom: 12 })

    expect(result.ok).toBe(false)
    expect(result.error, 'names the range AND the undo, rather than just refusing').toMatch(
      /between 0\.25 and 5.*0 to restore the user's own setting/,
    )
    expect(zoomFn('setZoom')).not.toHaveBeenCalled()
    expect(zoomFn('setZoomSettings'), 'a refused set leaves the scope alone').not.toHaveBeenCalled()
  })

  it('requires a tab_id', async () => {
    installTabsMock({ loadAfterMs: null })

    const result = await execTabs({ action: 'zoom' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/zoom requires tab_id/)
    expect(zoomFn('getZoom')).not.toHaveBeenCalled()
  })
})
