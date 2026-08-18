import { beforeEach, describe, expect, it, vi } from 'vitest'
import { armDelivery, clearWorld, resetForTests } from './delivery'
import { installCdpEventRouter, resetForTests as resetDebugger } from './debuggerSession'

const TAB = 1
const CONTEXT = 7

/**
 * Simulate CDP's binding channel (#180). Real Chrome exposes the
 * `Runtime.addBinding` function as a global in the delivery world and
 * delivers each call as a `Runtime.bindingCalled` event; the fake routes
 * a page-side call through the REAL event router, so the name check, the
 * payload parse and the per-probe slot routing are all exercised, not
 * mocked around.
 */
function installPushChannel(): (payload: string) => void {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const route = addListener.mock.calls.at(-1)?.[0] as (
    source: { tabId: number },
    method: string,
    params: unknown,
  ) => void
  const emit = (payload: string): void => {
    route({ tabId: TAB }, 'Runtime.bindingCalled', { name: '__nymDeliveryPush', payload })
  }
  ;(globalThis as Record<string, unknown>).__nymDeliveryPush = emit
  return emit
}

/**
 * A CDP mock that RUNS the probe's page-side JavaScript instead of matching it
 * as a string.
 *
 * The arm and read expressions are the whole mechanism: everything the module
 * does on the extension side is plumbing around them. Backlog #160 records the
 * cost of not doing this for the settle probe, whose `probeExpression` is "a
 * string no test ever executes", leaving the MutationObserver logic that IS the
 * settle mechanism unverified. happy-dom gives us a real `window` with real
 * event dispatch, so there is no reason to repeat that here.
 */
function installCdpMock(
  opts: { world?: boolean; readThrows?: string; armThrows?: string; tallyThrows?: string } = {},
) {
  const { world = true, readThrows, armThrows, tallyThrows } = opts
  const run = (expression: string): unknown =>
    (new Function(`return (${expression})`) as () => unknown)()

  const sendCommand = vi.fn(
    async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        return world ? { frameTree: { frame: { id: 'frame-1' } } } : {}
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: CONTEXT }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '')
        const isArm = expression.includes('addEventListener')
        const isPeek = expression.includes('nymPeek')
        const isTally = expression.includes('nymTally')
        if (isArm && armThrows) throw new Error(armThrows)
        if (isTally && tallyThrows) throw new Error(tallyThrows)
        // `readThrows` models the document dying with the final read; the
        // peek (taken earlier, while the document lived) stays runnable.
        if (!isArm && !isPeek && !isTally && readThrows) throw new Error(readThrows)
        // Real CDP resolves the value when `awaitPromise` is set; the read
        // expression yields a macrotask in the page (#180), so the mock
        // must await the same way or it would hand back a pending Promise.
        // And `returnByValue: true` SERIALIZES: returning page objects by
        // reference let a stored peek alias the live counters and read
        // fresher than it was, which silently defanged the merge tests
        // (review round, M4). Clone the way the wire does.
        const raw = params.awaitPromise ? await run(expression) : run(expression)
        const value = raw && typeof raw === 'object' ? structuredClone(raw) : raw
        return { result: { value } }
      }
      return {}
    },
  )
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

/**
 * An event as a real page produces one: dispatched at an element, bubbling, and
 * TRUSTED. The probe counts only trusted events, because a page can dispatch
 * its own and would otherwise be able to fake delivery, so a test firing
 * script-made events would silently exercise nothing.
 */
function firePageEvent(
  type: string,
  opts: { trusted?: boolean; target?: Element } = {},
): void {
  const target = opts.target ?? document.body ?? document.documentElement
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'isTrusted', { value: opts.trusted ?? true })
  target.dispatchEvent(event)
}

beforeEach(() => {
  resetDebugger()
  resetForTests()
  delete (globalThis as Record<string, unknown>).__nymDelivery
  delete (globalThis as Record<string, unknown>).__nymDeliveryPush
  document.body.innerHTML = ''
})

describe('delivery probe', () => {
  it('reports yes when the page actually received the event', async () => {
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    expect((await probe.read()).outcome).toBe('yes')
  })

  it('reports no when the event never arrived', async () => {
    // The failure this module exists for: CDP acked the dispatch, the browser
    // discarded it before the renderer, and nothing reached the page.
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    // Deliberately fire nothing.

    expect((await probe.read()).outcome).toBe('no')
  })

  it('ignores events the page dispatched itself', async () => {
    // The isolated world hides the counter but not the DOM, so page script can
    // fire its own mousedown. Counting those would let a hostile page fake
    // delivery and hand back the silent-success bug.
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown', { trusted: false })

    expect((await probe.read()).outcome).toBe('no')
  })

  it('counts only the event types it was armed for', async () => {
    installCdpMock()

    const probe = await armDelivery(TAB, ['wheel'])
    firePageEvent('mousedown')
    firePageEvent('keydown')

    expect((await probe.read()).outcome).toBe('no')
  })

  it('reports trusted-event counts by type, and only for trusted events', async () => {
    // #176: "arrived" alone cannot tell a press that never composed into a
    // click from a click whose default action was gated. The per-type
    // breakdown is what splits them, so it must count exactly what the page
    // received and nothing the page faked.
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown', 'mouseup', 'click'])
    firePageEvent('mousedown')
    firePageEvent('mouseup')
    firePageEvent('click')
    firePageEvent('click', { trusted: false })

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ mousedown: 1, mouseup: 1, click: 1 })
  })

  it('omits default_prevented when no composed click-family event fired', async () => {
    // The frame-1 diagnosis shape: the press arrived, the click never
    // composed. A null must stay absent, not read as "not prevented".
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown', 'mouseup', 'click'])
    firePageEvent('mousedown')
    firePageEvent('mouseup')

    const reading = await probe.read()
    expect(reading.events).toEqual({ mousedown: 1, mouseup: 1 })
    expect(reading.clickDefaultPrevented).toBeUndefined()
  })

  it('samples defaultPrevented deterministically: an immediate read still sees it (#180)', async () => {
    // Our capture listener on window is the FIRST hop, before any page
    // handler can call preventDefault, so reading the flag inline would
    // always say false; the sample rides a later tick. The read used to
    // win that race only by the accident of CDP round trips between
    // dispatch and read (measured present-sometimes across one session,
    // the #180 filing). Now the read itself yields one macrotask in the
    // page before snapping, so this test deliberately does NOT yield:
    // reading straight after dispatch must still see the settled flag.
    installCdpMock()

    const probe = await armDelivery(TAB, ['click'])
    const cancel = (e: Event) => e.preventDefault()
    document.body.addEventListener('click', cancel)
    try {
      firePageEvent('click')
      const reading = await probe.read()
      expect(reading.outcome).toBe('yes')
      expect(reading.clickDefaultPrevented).toBe(true)
    } finally {
      document.body.removeEventListener('click', cancel)
    }
  })

  it("reads the frame's user-activation state at read time", async () => {
    // The probe world shares the frame's navigator, and activation is what
    // navigation-class default actions key on (#176), so the read carries it.
    installCdpMock()
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive: true, hasBeenActive: true },
      configurable: true,
    })
    try {
      const probe = await armDelivery(TAB, ['mousedown'])
      firePageEvent('mousedown')

      const reading = await probe.read()
      expect(reading.userActivation).toEqual({ active: true, hasBeenActive: true })
    } finally {
      delete (navigator as unknown as Record<string, unknown>).userActivation
    }
  })

  it('tolerates a navigator without userActivation', async () => {
    // happy-dom has none, and neither may an older engine: the reading must
    // simply omit the field rather than fail the probe.
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.userActivation).toBeUndefined()
  })

  it("records the composed click's target identity, anchor href included", async () => {
    // The #176 round-1 measurement rejected every hypothesis a bare count
    // can test; whether the click composed ON the anchor is the remaining
    // in-frame measurable.
    installCdpMock()
    document.body.innerHTML = '<a href="https://dest.example/x">go</a>'
    const anchor = document.querySelector('a') as Element

    const probe = await armDelivery(TAB, ['click'])
    firePageEvent('click', { target: anchor })

    const reading = await probe.read()
    expect(reading.clickTarget).toEqual({ tag: 'a', href: 'https://dest.example/x' })
  })

  it('a peek before a navigating read preserves the counts', async () => {
    // A successful link click destroys the probe's world with the document,
    // so the final read proves delivery but loses the per-type counts: the
    // success payload was data-poorer than the failure one (QA rider).
    installCdpMock({ readThrows: 'Cannot find context with specified id' })

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')
    await probe.peek()

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ mousedown: 1 })
  })

  it('a navigating click keeps its whole diagnosis through the push channel (#180)', async () => {
    // The facts live in a page-world closure that dies with the document,
    // and on a fast navigation the read AND the peek both arrive after
    // teardown: the filing measured the entire diagnostic set absent on
    // the exact case it matters most for. The handler pushes after every
    // trusted event through the CDP binding, so the background already
    // holds the diagnosis when the world dies. Deliberately NO peek here:
    // the evidence must come from the pushes alone.
    installCdpMock({ readThrows: 'Cannot find context with specified id' })
    installPushChannel()
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive: true, hasBeenActive: true },
      configurable: true,
    })
    document.body.innerHTML = '<a href="https://dest.example/x">go</a>'
    try {
      const probe = await armDelivery(TAB, ['click'])
      firePageEvent('click', { target: document.querySelector('a') as Element })
      // One macrotask so the deferred defaultPrevented push lands, as it
      // does in reality: a real navigation commit needs at least a network
      // round trip, a macrotask does not.
      await new Promise((r) => setTimeout(r, 0))

      const reading = await probe.read()
      expect(reading.outcome).toBe('yes')
      expect(reading.events).toEqual({ click: 1 })
      expect(reading.clickTarget).toEqual({ tag: 'a', href: 'https://dest.example/x' })
      expect(reading.clickDefaultPrevented).toBe(false)
      expect(reading.userActivation).toEqual({ active: true, hasBeenActive: true })
    } finally {
      delete (navigator as unknown as Record<string, unknown>).userActivation
    }
  })

  it('the sync per-event push alone carries evidence when teardown beats the macrotask (#180)', async () => {
    // An instantly-committing navigation can kill the document before the
    // deferred defaultPrevented sample ever runs (measured live on a
    // hot-cache nav, 2026-08-16). The SYNCHRONOUS push at event time is
    // the insurance: counts and target survive, and prevented is honestly
    // absent rather than guessed. No macrotask yield and no peek here, so
    // only that sync push has run when the read finds the world dead.
    installCdpMock({ readThrows: 'Cannot find context with specified id' })
    installPushChannel()
    document.body.innerHTML = '<a href="https://dest.example/y">go</a>'

    const probe = await armDelivery(TAB, ['click'])
    firePageEvent('click', { target: document.querySelector('a') as Element })

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ click: 1 })
    expect(reading.clickTarget).toEqual({ tag: 'a', href: 'https://dest.example/y' })
    expect(reading.clickDefaultPrevented).toBeUndefined()
  })

  it('the freshest push outranks a stale peek on the navigating path (#180)', async () => {
    // Both carriers can be populated; the push is event-time truth and
    // strictly newer, so it must win the merge.
    installCdpMock({ readThrows: 'Cannot find context with specified id' })
    installPushChannel()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')
    await probe.peek()
    firePageEvent('mousedown')

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ mousedown: 2 })
  })

  it("a push from another tab never lands in this probe's slot (#180 review, M1)", async () => {
    // Slots are keyed by tab AND probe id: a binding call arriving on a
    // different tab's session, even one naming a live probe id, must be
    // dropped, or cross-tab contamination hands one act another's counts.
    installCdpMock({ readThrows: 'Cannot find context with specified id' })
    installPushChannel()
    const route = (
      chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0] as (s: { tabId: number }, m: string, p: unknown) => void

    const probe = await armDelivery(TAB, ['mousedown'])
    const reg = (globalThis as Record<string, unknown>).__nymDelivery as Record<string, unknown>
    const liveId = Object.keys(reg)[0]
    route({ tabId: TAB + 1 }, 'Runtime.bindingCalled', {
      name: '__nymDeliveryPush',
      payload: JSON.stringify({ id: liveId, n: 5, types: { mousedown: 5 } }),
    })

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toBeUndefined()
  })

  it('a held push rescues the verdict when the read fails without the context dying (#180)', async () => {
    // A transport deadline or a DevTools steal fails the read for a
    // NON-context reason, but a push counting a trusted event is the same
    // proof a successful read would have carried: shrugging "unknown"
    // while holding it would discard a free verdict (review round, M2).
    installCdpMock({ readThrows: 'CDP call deadline exceeded' })
    installPushChannel()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ mousedown: 1 })
  })

  it('falls back to the read-time activation sample when the handler saw none (#180)', async () => {
    // Event-time sampling wins when present; a page whose activation state
    // only became readable later must still answer through the read-time
    // sample rather than dropping the field.
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown') // navigator.userActivation does not exist yet
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive: true, hasBeenActive: true },
      configurable: true,
    })
    try {
      const reading = await probe.read()
      expect(reading.userActivation).toEqual({ active: true, hasBeenActive: true })
    } finally {
      delete (navigator as unknown as Record<string, unknown>).userActivation
    }
  })

  it('a malformed or misrouted push never becomes evidence (#180)', async () => {
    // The channel is world-scoped so page script cannot reach it, but the
    // parse still refuses garbage, and a payload naming a foreign probe id
    // lands nowhere: the navigating read then reports the bare yes it
    // always did rather than someone else's counts.
    installCdpMock({ readThrows: 'Cannot find context with specified id' })
    const emit = installPushChannel()

    const probe = await armDelivery(TAB, ['mousedown'])
    emit('{not json')
    emit(JSON.stringify({ id: 'p999999', n: 5, types: { mousedown: 5 } }))

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toBeUndefined()
  })

  it('the tally counts document mutations from the arm, surviving the read (#180 QA round 2)', async () => {
    // Live QA measured the settle-window tally blind to synchronous
    // handler reactions: the status line demonstrably changed and the
    // count read 0, a false negative on the strong signal. The observer
    // now installs WITH the arm, before any input, and keeps watching
    // through the read until the post-settle tally collects it.
    installCdpMock()

    const probe = await armDelivery(TAB, ['click'])
    document.body.appendChild(document.createElement('div')) // handler-time write
    firePageEvent('click')
    await probe.read()
    document.body.appendChild(document.createElement('div')) // settle-window write
    await new Promise((r) => setTimeout(r, 0)) // flush observer microtasks

    const tally = await probe.tally()
    expect(tally).not.toBeNull()
    expect(tally as number).toBeGreaterThanOrEqual(2)
  })

  it('an untouched document tallies an honest zero (#180)', async () => {
    installCdpMock()

    const probe = await armDelivery(TAB, ['click'])
    await new Promise((r) => setTimeout(r, 0))

    expect(await probe.tally()).toBe(0)
  })

  it('a dead context tallies null, never a fake zero (#180 QA round 2)', async () => {
    // The settle-window version leaked the DESTINATION document's count on
    // a navigating act (measured live: 5). The probe-world observer dies
    // with the acted document, and null keeps the payload key absent.
    installCdpMock({ tallyThrows: 'Cannot find context with specified id' })

    const probe = await armDelivery(TAB, ['click'])
    firePageEvent('click')

    expect(await probe.tally()).toBeNull()
  })

  it('installs the push binding scoped to the delivery world, never the page (#180)', async () => {
    // `executionContextName` is the security property: a binding without it
    // would hand page script a callable straight into the background.
    const cdp = installCdpMock()

    await armDelivery(TAB, ['click'])

    const call = cdp.mock.calls.find((c) => c[1] === 'Runtime.addBinding')
    expect(call?.[2]).toEqual({
      name: '__nymDeliveryPush',
      executionContextName: 'nymeria_delivery_probe',
    })
  })

  it('the peek does not disarm: later events still count and the read stays authoritative', async () => {
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')
    await probe.peek()
    firePageEvent('mousedown')

    const reading = await probe.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ mousedown: 2 })
  })

  it('reports unknown, never yes, when the isolated world cannot be created', async () => {
    // An unprovable delivery must not be dressed up as a proven one: that is
    // the exact dishonesty this module was built to remove.
    installCdpMock({ world: false })

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    expect((await probe.read()).outcome).toBe('unknown')
  })

  it('reports unknown when arming throws for a reason other than a dead context', async () => {
    installCdpMock({ armThrows: 'some other protocol failure' })

    const probe = await armDelivery(TAB, ['mousedown'])

    expect((await probe.read()).outcome).toBe('unknown')
  })

  it('treats a destroyed context at read time as delivered, not as unknown', async () => {
    // The action navigated the page. The probe died with its document, so the
    // count is unreadable, but the navigation is itself proof the input landed.
    installCdpMock({ readThrows: 'Cannot find context with specified id' })

    const probe = await armDelivery(TAB, ['mousedown'])

    expect((await probe.read()).outcome).toBe('yes')
  })

  it('reports unknown when the read fails for an unrelated reason', async () => {
    installCdpMock({ readThrows: 'some other protocol failure' })

    const probe = await armDelivery(TAB, ['mousedown'])

    expect((await probe.read()).outcome).toBe('unknown')
  })

  it('leaves no listener behind, so the next action counts only its own events', async () => {
    // Residue would inflate every later count and turn the probe into a
    // permanent "yes", which is worse than not having it.
    installCdpMock()

    const first = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')
    expect((await first.read()).outcome).toBe('yes')

    const second = await armDelivery(TAB, ['mousedown'])
    expect((await second.read()).outcome).toBe('no')
  })

  it('keeps concurrent probes on one tab independent', async () => {
    // A batch of tool calls in one assistant turn runs concurrently, so two
    // acts on the same tab overlap routinely. With a single shared counter the
    // second arm zeroed the first's count and the first read deleted the
    // second's record, so a delivered action could read zero and hard-fail.
    installCdpMock()

    const first = await armDelivery(TAB, ['mousedown'])
    const second = await armDelivery(TAB, ['keydown'])
    firePageEvent('mousedown')

    expect((await first.read()).outcome).toBe('yes')
    expect((await second.read()).outcome).toBe('no')
  })

  it('does not let one probe swallow another probe\'s events', async () => {
    installCdpMock()

    const first = await armDelivery(TAB, ['mousedown'])
    const second = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    // Both listeners are live, so both see the one real event.
    expect((await second.read()).outcome).toBe('yes')
    expect((await first.read()).outcome).toBe('yes')
  })

  it('removes its listeners at read and its global once tallied (#180)', async () => {
    installCdpMock()
    const registry = () =>
      (globalThis as Record<string, unknown>).__nymDelivery as Record<string, unknown>

    const probe = await armDelivery(TAB, ['mousedown'])
    await probe.read()

    // The read strips the input listeners but the entry SURVIVES: its
    // mutation observer keeps watching until the post-settle tally
    // collects it (#180 QA round 2 is why the window must reach settle).
    expect(Object.keys(registry() ?? {})).toHaveLength(1)
    // A later event still has no stale LISTENER left to count it twice.
    const next = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')
    const reading = await next.read()
    expect(reading.outcome).toBe('yes')
    expect(reading.events).toEqual({ mousedown: 1 })

    // The tally is the true end of life: both entries drain to nothing.
    await probe.tally()
    await next.tally()
    expect(Object.keys(registry() ?? {})).toHaveLength(0)
  })

  it('is one-shot: a second read reports unknown rather than re-reading', async () => {
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    expect((await probe.read()).outcome).toBe('yes')
    expect((await probe.read()).outcome).toBe('unknown')
  })

  it('rebuilds the world once when the cached context died with its document', async () => {
    const cdp = installCdpMock()
    await armDelivery(TAB, ['mousedown'])
    const before = cdp.mock.calls.filter((c) => c[1] === 'Page.createIsolatedWorld').length

    // Same tab, cached world, but the document has gone.
    let thrown = false
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(
      async (_t: unknown, method: string, params: Record<string, unknown> = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-2' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 }
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression ?? '')
          if (expression.includes('addEventListener') && !thrown) {
            thrown = true
            throw new Error('Cannot find context with specified id')
          }
          const raw = await (new Function(`return (${expression})`) as () => unknown)()
          return {
            result: { value: raw && typeof raw === 'object' ? structuredClone(raw) : raw },
          }
        }
        return {}
      },
    )

    const probe = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')

    expect(before).toBe(1)
    expect((await probe.read()).outcome).toBe('yes')
  })

  it('drops the cached world on request so a navigated tab re-creates one', async () => {
    const cdp = installCdpMock()
    await armDelivery(TAB, ['mousedown'])
    clearWorld(TAB)
    await armDelivery(TAB, ['mousedown'])

    const created = cdp.mock.calls.filter((c) => c[1] === 'Page.createIsolatedWorld')
    expect(created).toHaveLength(2)
  })

  it('reuses the cached world across actions on the same document', async () => {
    const cdp = installCdpMock()

    await armDelivery(TAB, ['mousedown'])
    await armDelivery(TAB, ['keydown'])

    const created = cdp.mock.calls.filter((c) => c[1] === 'Page.createIsolatedWorld')
    expect(created).toHaveLength(1)
  })
})

// The file-chooser watcher that used to ride this probe was removed in the
// #169 pass: `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened`
// (armed per attach, recorded in dialogs.ts) prevent the picker outright and
// see every route the in-page listener could not. Its behavior is covered in
// dialogs.test.ts and act.test.ts.
