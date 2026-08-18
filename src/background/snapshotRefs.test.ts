import { beforeEach, describe, expect, it } from 'vitest'
import {
  clear,
  dropTab,
  fingerprintNameKey,
  nextCounter,
  normalizeAxName,
  refsReady,
  resetForTests,
  resolve,
  set,
  size,
  withMintLock,
  type RefTarget,
} from './snapshotRefs'

const TAB = 1
const URL_A = 'https://example.com/page'
const URL_B = 'https://example.com/other'

/** The slice of node's process the rejection-audit test needs. */
interface NodeProcessEvents {
  on(event: 'unhandledRejection', cb: (reason: unknown) => void): void
  off(event: 'unhandledRejection', cb: (reason: unknown) => void): void
}

beforeEach(() => {
  resetForTests()
})

function refs(entries: [string, number][]): Map<string, RefTarget> {
  return new Map(entries.map(([ref, id]) => [ref, { backendNodeId: id, role: 'button', name: 'Pay' }]))
}

describe('monotonic numbering + merge (#160)', () => {
  it('a second read of the same document merges: refs from BOTH reads resolve', () => {
    set(TAB, refs([['e1', 100], ['e2', 101]]), URL_A, 2)
    set(TAB, refs([['e3', 200]]), URL_A, 3)

    expect(resolve(TAB, '@e1', URL_A)).toMatchObject({ ok: true, backendNodeId: 100 })
    expect(resolve(TAB, '@e3', URL_A)).toMatchObject({ ok: true, backendNodeId: 200 })
    expect(size(TAB)).toBe(3)
  })

  it('a read of a DIFFERENT document replaces, and the old numbers refuse as a stale read', () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)
    clear(TAB) // the navigation-commit hook
    set(TAB, refs([['e2', 200]]), URL_B, 2)

    const stale = resolve(TAB, '@e1', URL_B)
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.reason).toBe('stale-read')
      expect(stale.detail).toMatch(/from before the last navigation/)
    }
    expect(resolve(TAB, '@e2', URL_B)).toMatchObject({ ok: true, backendNodeId: 200 })
  })

  it('the cross-document silent re-point is dead: numbers never collide across reads', () => {
    // Read A mints e1..e2; navigate; read B mints e3.. (monotonic). The held
    // A-ref @e1 must NOT resolve into B's map, which is exactly what the old
    // renumber-from-e1 scheme did.
    set(TAB, refs([['e1', 100], ['e2', 101]]), URL_A, 2)
    clear(TAB)
    set(TAB, refs([['e3', 500]]), URL_B, 3)

    const held = resolve(TAB, '@e1', URL_B)
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('stale-read')
  })

  it('a number the tab never minted refuses with the distinct unknown copy', () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)

    const unknown = resolve(TAB, '@e99', URL_A)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.reason).toBe('unknown-ref')
      expect(unknown.detail).toMatch(/never minted/)
    }
  })
})

describe('merge and replace', () => {
  it('a different URL replaces even WITHOUT clear(): old numbers refuse as a stale read', () => {
    // The navigation-commit hook normally clears first, but merge-vs-replace
    // must not DEPEND on it: a missed hook (worker recycle race) plus a merge
    // here would resurrect cross-document refs, the wrong-click class.
    set(TAB, refs([['e1', 100]]), URL_A, 1)
    set(TAB, refs([['e2', 200]]), URL_B, 2)

    const held = resolve(TAB, '@e1', URL_B)
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('stale-read')
    expect(size(TAB)).toBe(1)
  })
})

describe('URL checks: anchors tolerated, routes count as moving', () => {
  it('an in-page anchor move does not bounce held refs', () => {
    set(TAB, refs([['e1', 100]]), `${URL_A}#top`, 1)

    expect(resolve(TAB, '@e1', `${URL_A}#section-3`)).toMatchObject({ ok: true })
  })

  it('a query change still refuses as navigated', () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)

    const moved = resolve(TAB, '@e1', `${URL_A}?step=2`)
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.reason).toBe('navigated')
  })

  it('a PATH change (pushState included) refuses as navigated', () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)

    const moved = resolve(TAB, '@e1', 'https://example.com/other-page')
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.reason).toBe('navigated')
  })

  it('a same-document re-read differing only by fragment still MERGES', () => {
    set(TAB, refs([['e1', 100]]), `${URL_A}#a`, 1)
    set(TAB, refs([['e2', 200]]), `${URL_A}#b`, 2)

    expect(resolve(TAB, '@e1', `${URL_A}#b`)).toMatchObject({ ok: true, backendNodeId: 100 })
    expect(resolve(TAB, '@e2', `${URL_A}#b`)).toMatchObject({ ok: true, backendNodeId: 200 })
  })

  it('a hash-ROUTE change refuses as navigated: the fragment IS the page there', () => {
    // Hash routing (#/inbox -> #/archive) renders a different view with no
    // document load; treating it as an anchor would let refs from one route
    // click into another.
    set(TAB, refs([['e1', 100]]), `${URL_A}#/inbox`, 1)

    const moved = resolve(TAB, '@e1', `${URL_A}#/archive`)
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.reason).toBe('navigated')
  })

  it('a hashbang route change refuses too, and a re-read there replaces, not merges', () => {
    set(TAB, refs([['e1', 100]]), `${URL_A}#!/inbox`, 1)
    set(TAB, refs([['e2', 200]]), `${URL_A}#!/archive`, 2)

    expect(size(TAB)).toBe(1)
    const held = resolve(TAB, '@e1', `${URL_A}#!/archive`)
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('stale-read')
  })
})

describe('mint serialization', () => {
  it('withMintLock runs two concurrent mints one after the other', async () => {
    // Two parallel reads of one tab must not both start from the same
    // counter: overlapping mints would number-collide, the exact class
    // monotonic numbering exists to remove.
    const order: string[] = []
    const gate = { release: () => {} }
    const first = withMintLock(TAB, async () => {
      order.push('first-start')
      await new Promise<void>((r) => {
        gate.release = r
      })
      order.push('first-end')
    })
    const second = withMintLock(TAB, async () => {
      order.push('second-start')
    })
    // Give the second mint every chance to start early; only the lock stops it.
    await new Promise((r) => setTimeout(r, 10))
    gate.release()
    await Promise.all([first, second])

    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })
})

describe('fingerprint normalization (shared mint/check helpers)', () => {
  it('normalizeAxName collapses whitespace and bounds length', () => {
    expect(normalizeAxName('  Pay\n  now ')).toBe('Pay now')
    expect(normalizeAxName('x'.repeat(300))).toHaveLength(200)
  })

  it('digit ticks share a key; text changes do not', () => {
    // "Cart (3)" -> "Cart (4)" is the same button with its badge ticked;
    // "Confirm" -> "Delete" is the wrong-click class the check exists for.
    expect(fingerprintNameKey('Cart (3)')).toBe(fingerprintNameKey('Cart (4)'))
    expect(fingerprintNameKey('2:59 remaining')).toBe(fingerprintNameKey('3:00 remaining'))
    expect(fingerprintNameKey('Confirm')).not.toBe(fingerprintNameKey('Delete'))
  })

  it('digits are ignored, not deleted: "A1B" does not collide with "AB"', () => {
    expect(fingerprintNameKey('A1B')).not.toBe(fingerprintNameKey('AB'))
  })
})

describe('counter persistence across worker recycles', () => {
  it('hydrates the next counter from chrome.storage.session', async () => {
    // A recycle wipes this module's memory but not storage.session: the next
    // read must continue numbering, or a held @e12 would collide with a fresh
    // mint and resolve to a different live element with full confidence.
    await chrome.storage.session.set({ 'nymRefCounter:1': 40 })

    expect(await nextCounter(TAB)).toBe(40)
  })

  it('set() mirrors the counter into storage.session', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 7)

    const got = await chrome.storage.session.get('nymRefCounter:1')
    expect(got['nymRefCounter:1']).toBe(7)
  })

  it('the counter survives clear() (navigation), so numbering stays monotonic', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 5)
    clear(TAB)

    expect(await nextCounter(TAB)).toBe(5)
  })

  it('dropTab surrenders the counter and its stored mirror', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 5)
    dropTab(TAB)

    expect(await nextCounter(TAB)).toBe(0)
    const got = await chrome.storage.session.get('nymRefCounter:1')
    expect('nymRefCounter:1' in got).toBe(false)
  })
})

describe('map persistence across worker recycles (#179)', () => {
  // A "recycle" in these tests is resetForTests(): module memory wiped, the
  // mock chrome.storage.session (reinstalled per test, stable within one)
  // playing the in-memory-browser-side store that outlives the worker.

  it('set() mirrors the map into storage.session beside the counter', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)

    const got = await chrome.storage.session.get('nymRefs:1')
    expect(got['nymRefs:1']).toEqual({
      url: URL_A,
      refs: { e1: { backendNodeId: 100, role: 'button', name: 'Pay' } },
    })
  })

  it('refs survive a recycle, frame fields intact: hydration restores the map', async () => {
    set(
      TAB,
      new Map<string, RefTarget>([
        ['e1', { backendNodeId: 100, role: 'button', name: 'Pay' }],
        [
          'e2',
          {
            backendNodeId: 200,
            frameTargetId: 'FRAME-T-1',
            frameUrl: 'https://frame.example/checkout',
            role: 'textbox',
            name: 'Card',
          },
        ],
      ]),
      URL_A,
      2,
    )

    resetForTests()
    await refsReady()

    expect(resolve(TAB, '@e1', URL_A)).toMatchObject({ ok: true, backendNodeId: 100 })
    expect(resolve(TAB, '@e2', URL_A)).toMatchObject({
      ok: true,
      backendNodeId: 200,
      frameTargetId: 'FRAME-T-1',
      frameUrl: 'https://frame.example/checkout',
      role: 'textbox',
      name: 'Card',
    })
  })

  it('the hydrated counter keeps the stale-read vs never-minted split honest post-recycle', async () => {
    set(TAB, refs([['e9', 900]]), URL_A, 9)

    resetForTests()
    await refsReady()

    // In the minted range but absent from the map: a stale read, not unknown.
    const staleRead = resolve(TAB, '@e5', URL_A)
    expect(staleRead.ok).toBe(false)
    if (!staleRead.ok) expect(staleRead.reason).toBe('stale-read')
    // Beyond the counter: genuinely never minted.
    const unknown = resolve(TAB, '@e999', URL_A)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.reason).toBe('unknown-ref')
      expect(unknown.detail).toMatch(/never minted/)
    }
  })

  it('a same-URL re-read after a recycle MERGES with the restored map', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)

    resetForTests()
    await refsReady()
    set(TAB, refs([['e2', 200]]), URL_A, 2)

    expect(resolve(TAB, '@e1', URL_A)).toMatchObject({ ok: true, backendNodeId: 100 })
    expect(resolve(TAB, '@e2', URL_A)).toMatchObject({ ok: true, backendNodeId: 200 })
  })

  it('clear() removes the stored map, keeps the stored counter, and the refusal says invalidated', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 5)
    clear(TAB)

    const got = await chrome.storage.session.get(null)
    expect('nymRefs:1' in got).toBe(false)
    expect(got['nymRefCounter:1']).toBe(5)

    resetForTests()
    await refsReady()
    const refusal = resolve(TAB, '@e1', URL_A)
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) {
      expect(refusal.reason).toBe('no-snapshot')
      expect(refusal.detail).toMatch(/invalidated/)
      expect(refusal.detail).not.toMatch(/read the page first/)
    }
  })

  it('a tab nobody ever read keeps the read-the-page-first copy', () => {
    const refusal = resolve(TAB, '@e1', URL_A)
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) {
      expect(refusal.reason).toBe('no-snapshot')
      expect(refusal.detail).toMatch(/read the page first/)
    }
  })

  it('dropTab removes both stored keys', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 5)
    dropTab(TAB)

    const got = await chrome.storage.session.get(null)
    expect('nymRefs:1' in got).toBe(false)
    expect('nymRefCounter:1' in got).toBe(false)
  })

  it('a clear() landing while hydration is in flight tombstones the tab: no resurrection', async () => {
    set(TAB, refs([['e1', 100]]), URL_A, 1)
    resetForTests()

    // Hold hydration between its storage READ and its populate, with the read
    // answering the PRE-clear data: the live race is onCommitted firing while
    // the get is in flight, and the stale snapshot must not win.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const session = chrome.storage.session as unknown as {
      get: (keys?: unknown) => Promise<Record<string, unknown>>
    }
    const realGet = session.get.bind(chrome.storage.session)
    session.get = async (keys?: unknown) => {
      const snapshot = await realGet(keys)
      await gate
      return snapshot
    }

    const ready = refsReady()
    clear(TAB) // the navigation-commit hook, mid-hydration
    release()
    await ready

    const refusal = resolve(TAB, '@e1', URL_A)
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.reason).toBe('no-snapshot')
  })

  it('a mid-hydration clear() still lets the COUNTER hydrate, keeping the refusal copy honest', async () => {
    // Wake-BY-navigation is the ordinary ordering, not a rare race: the
    // commit event starts the worker, so onCommitted's clear() routinely
    // lands while hydration is in flight. clear() keeps the counter
    // everywhere, so the tombstone must block only the MAP; a tombstone
    // that also withheld the counter would answer the next resolve with
    // "read the page first" on a tab that was read, the copy lie this
    // pass exists to remove.
    set(TAB, refs([['e1', 100]]), URL_A, 5)
    resetForTests()

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const session = chrome.storage.session as unknown as {
      get: (keys?: unknown) => Promise<Record<string, unknown>>
    }
    const realGet = session.get.bind(chrome.storage.session)
    session.get = async (keys?: unknown) => {
      const snapshot = await realGet(keys)
      await gate
      return snapshot
    }

    const ready = refsReady()
    clear(TAB)
    release()
    await ready

    const refusal = resolve(TAB, '@e1', URL_A)
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) {
      expect(refusal.reason).toBe('no-snapshot')
      expect(refusal.detail).toMatch(/invalidated/)
      expect(refusal.detail).not.toMatch(/read the page first/)
    }
    // And numbering still continues from the preserved floor.
    expect(await nextCounter(TAB)).toBe(5)
  })

  it('hydration never overwrites refs minted after the recycle', async () => {
    await chrome.storage.session.set({
      'nymRefs:1': { url: URL_A, refs: { e1: { backendNodeId: 999, role: 'button', name: 'Old' } } },
      'nymRefCounter:1': 1,
    })
    resetForTests()

    // Hold hydration on the OLD storage snapshot while a fresh mint lands
    // (the dispatcher gate makes this near-impossible live; the guard pins
    // that memory wins anyway).
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const session = chrome.storage.session as unknown as {
      get: (keys?: unknown) => Promise<Record<string, unknown>>
    }
    const realGet = session.get.bind(chrome.storage.session)
    session.get = async (keys?: unknown) => {
      const snapshot = await realGet(keys)
      await gate
      return snapshot
    }

    const ready = refsReady()
    set(TAB, refs([['e2', 200]]), URL_A, 2)
    release()
    await ready

    expect(resolve(TAB, '@e2', URL_A)).toMatchObject({ ok: true, backendNodeId: 200 })
    const old = resolve(TAB, '@e1', URL_A)
    expect(old.ok).toBe(false)
    if (!old.ok) expect(old.reason).toBe('stale-read')
  })

  it('a storage write rejection is HANDLED, not left to reject unhandled', async () => {
    // The v0.9.0 transport incident: an over-quota storage set() REJECTS,
    // and an unhandled rejection is the failure this guards. A bare
    // resolve-still-works assert has no teeth (it passes with the .catch
    // handlers deleted), so this listens for the rejection itself.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    // Via globalThis: the app tsconfig pins global types to ["chrome"], so
    // neither the `process` global nor a node: import typechecks here.
    const proc = (globalThis as unknown as { process: NodeProcessEvents }).process
    proc.on('unhandledRejection', onUnhandled)
    try {
      const session = chrome.storage.session as unknown as {
        set: (items: Record<string, unknown>) => Promise<void>
      }
      session.set = async () => {
        throw new Error('quota exceeded')
      }

      set(TAB, refs([['e1', 100]]), URL_A, 1) // must not throw
      await new Promise((r) => setTimeout(r, 0)) // let rejections surface

      expect(resolve(TAB, '@e1', URL_A)).toMatchObject({ ok: true, backendNodeId: 100 })
      expect(unhandled).toEqual([])
    } finally {
      proc.off('unhandledRejection', onUnhandled)
    }
  })

  it('a malformed stored entry is skipped whole, not half-hydrated', async () => {
    await chrome.storage.session.set({
      'nymRefs:1': {
        url: URL_A,
        refs: { e1: { backendNodeId: 'not-a-number', role: 'button', name: 'Pay' } },
      },
      'nymRefCounter:1': 1,
    })

    await refsReady()

    const refusal = resolve(TAB, '@e1', URL_A)
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.reason).toBe('no-snapshot')
  })
})

describe('frame refs across session churn', () => {
  it('a frame ref keeps resolving by stable frame target id (no session in the store)', () => {
    // Sessions die on every idle detach; refs deliberately carry the frame's
    // stable TARGET id instead, and the act layer maps it to the live
    // session at use time. This pins the store side of that contract.
    set(
      TAB,
      new Map([
        ['e1', { backendNodeId: 100, role: 'button', name: 'Pay' }],
        ['e2', { backendNodeId: 200, frameTargetId: 'FRAME-T-1', role: 'button', name: 'Card' }],
      ]),
      URL_A,
      2,
    )

    expect(resolve(TAB, '@e1', URL_A)).toMatchObject({ ok: true, frameTargetId: undefined })
    expect(resolve(TAB, '@e2', URL_A)).toMatchObject({
      ok: true,
      backendNodeId: 200,
      frameTargetId: 'FRAME-T-1',
    })
  })
})
