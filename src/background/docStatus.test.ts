import { afterEach, describe, expect, it } from 'vitest'
import { DOC_STATUS_EXPRESSION, httpStatusField } from './docStatus'

/**
 * The probe is exercised IN PAGE (`new Function`), not staged at a CDP mock:
 * the #210 review found that a mock which stages the ANSWER pins the caller's
 * ladder and leaves the measurement itself untested, so a mutation could delete
 * the mechanism with every test still green.
 *
 * What happy-dom cannot stand in for is Chrome's own Performance timeline, so
 * these tests stage a realistic one and assert the LOOKUP DISCIPLINE (own
 * descriptor before the prototype chain, prototype descriptors rather than
 * bare property reads, and silence on every failure). The Chrome-side facts
 * (that `responseStatus` reports 404/500/401 and the final status of a
 * redirect, that it survives a pushState, and that the probe world reads the
 * truth while the main world reads a page's forgery) were measured against a
 * real headless Chrome before any of this was written.
 */

interface Staged {
  restore: () => void
}

/** Stand in for Chrome's navigation timing, shaped like the real prototypes. */
function stageTiming(
  status: unknown,
  opts: { entries?: 'none' | 'one'; responseStatus?: 'present' | 'absent'; noPerformance?: boolean } = {},
): Staged {
  const g = globalThis as unknown as Record<string, unknown>
  const savedPerf = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  const savedPerformance = Object.getOwnPropertyDescriptor(globalThis, 'Performance')
  const savedTiming = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceResourceTiming')

  class FakeResourceTiming {
    _status: unknown = status
  }
  if (opts.responseStatus !== 'absent') {
    Object.defineProperty(FakeResourceTiming.prototype, 'responseStatus', {
      get(this: FakeResourceTiming) {
        return this._status
      },
      configurable: true,
    })
  }
  class FakeNavigationTiming extends FakeResourceTiming {}
  const staged = opts.entries === 'none' ? [] : [new FakeNavigationTiming()]
  // Reads its entries off `this`, the way the real method does. A closure
  // would answer for ANY receiver, and that quietly defanged the shadowing
  // test below: the forged object got the real entries handed to it.
  class FakePerformance {
    _entries: unknown[] = staged
    getEntriesByType(this: FakePerformance, type: string): unknown[] {
      return type === 'navigation' ? (this?._entries ?? []) : []
    }
  }

  g.Performance = FakePerformance
  g.PerformanceResourceTiming = FakeResourceTiming
  Object.defineProperty(globalThis, 'performance', {
    value: opts.noPerformance ? undefined : new FakePerformance(),
    configurable: true,
    writable: true,
  })

  return {
    restore: () => {
      const put = (name: string, d: PropertyDescriptor | undefined) => {
        if (d) Object.defineProperty(globalThis, name, d)
        else delete g[name]
      }
      put('performance', savedPerf)
      put('Performance', savedPerformance)
      put('PerformanceResourceTiming', savedTiming)
    },
  }
}

function probe(): { http_status: number | null } {
  return (new Function(`return ${DOC_STATUS_EXPRESSION}`) as () => { http_status: number | null })()
}

let staged: Staged | null = null
afterEach(() => {
  staged?.restore()
  staged = null
})

describe('the document status probe (executed in-page)', () => {
  it('reads the status the document itself reports, from its navigation timing entry', () => {
    staged = stageTiming(404)

    expect(probe().http_status).toBe(404)
  })

  it('never looks `performance` up bare, so a shadowing named element cannot answer', () => {
    // `<img name="performance">` writes into the WindowProperties object, which
    // sits BEFORE Window.prototype in the global's chain, so a bare read or a
    // chain walk can find the forgery first (the inversion #210 measured).
    // An OWN property is found before the chain, which is why this holds.
    staged = stageTiming(500)
    const chain = Object.getPrototypeOf(globalThis)
    const savedOnChain = Object.getOwnPropertyDescriptor(chain, 'performance')
    Object.defineProperty(chain, 'performance', {
      value: { getEntriesByType: () => [{ responseStatus: 200 }] },
      configurable: true,
      writable: true,
    })

    try {
      expect(probe().http_status, 'the real own-property answer must win').toBe(500)
    } finally {
      if (savedOnChain) Object.defineProperty(chain, 'performance', savedOnChain)
      else delete (chain as Record<string, unknown>).performance
    }
  })

  it('reads `performance` through the own-descriptor helper, never bare', () => {
    // A behavioural test cannot separate the two: an own property is found
    // own-before-chain whichever way you ask for it, so the test above kills
    // only a chain-first implementation. The LOOKUP is the invariant, so the
    // expression source is what gets pinned, the same way the text read pins
    // its own `getComputedStyle` lookup (review round).
    expect(DOC_STATUS_EXPRESSION).toContain("nymGlobal('performance')")
    expect(DOC_STATUS_EXPRESSION, 'a bare lookup is the shadowable one').not.toMatch(
      /[^'"]performance\./,
    )
  })

  it('says nothing when the document has no navigation entry', () => {
    staged = stageTiming(404, { entries: 'none' })

    expect(probe().http_status).toBeNull()
  })

  it('says nothing on a Chrome without responseStatus, rather than guessing', () => {
    // Feature-detected through the descriptor: the property is not Baseline,
    // and an absent one must read as unknown, never as a clean load.
    staged = stageTiming(404, { responseStatus: 'absent' })

    expect(probe().http_status).toBeNull()
  })

  it('says nothing when there is no performance object at all', () => {
    staged = stageTiming(404, { noPerformance: true })

    expect(probe().http_status).toBeNull()
  })

  it('says nothing when the entry answers something that is not a number', () => {
    staged = stageTiming('404')

    expect(probe().http_status).toBeNull()
  })
})

describe('httpStatusField', () => {
  it('carries a real status', () => {
    expect(httpStatusField(404)).toEqual({ http_status: 404 })
    expect(httpStatusField(200)).toEqual({ http_status: 200 })
    expect(httpStatusField(599)).toEqual({ http_status: 599 })
  })

  it('treats every unknown as ABSENT, never as a claim the load was fine', () => {
    // Zero is the spec's own "not available", so it must not render as a
    // status; the rest are shapes a payload can take when nothing was known.
    for (const value of [0, null, undefined, NaN, 99, 600, 404.5, true, '404', {}]) {
      expect(httpStatusField(value), `${String(value)} must not become a status`).toEqual({})
    }
  })
})
