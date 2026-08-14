import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectBeforeunloadAccept } from '../dialogs'
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
  opts: { loadAfterMs?: number | null; initialStatus?: string; silentComplete?: boolean } = {},
) {
  const { loadAfterMs = 500, initialStatus = 'loading', silentComplete = false } = opts
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
    onUpdated: {
      addListener: (fn: (id: number, info: { status?: string }) => void) => listeners.push(fn),
      removeListener: (fn: (id: number, info: { status?: string }) => void) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      },
    },
  }
  ;(chrome.windows as unknown) = { update: vi.fn(async () => undefined) }
  return { finishLoad, listenerCount: () => listeners.length }
}

beforeEach(() => {
  vi.useRealTimers()
})

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
