import { beforeEach, describe, expect, it, vi } from 'vitest'
import { armDelivery, clearWorld, resetForTests } from './delivery'
import { resetForTests as resetDebugger } from './debuggerSession'

const TAB = 1
const CONTEXT = 7

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
  opts: { world?: boolean; readThrows?: string; armThrows?: string } = {},
) {
  const { world = true, readThrows, armThrows } = opts
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
        if (isArm && armThrows) throw new Error(armThrows)
        if (!isArm && readThrows) throw new Error(readThrows)
        return { result: { value: run(expression) } }
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
function firePageEvent(type: string, opts: { trusted?: boolean } = {}): void {
  const target = document.body ?? document.documentElement
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'isTrusted', { value: opts.trusted ?? true })
  target.dispatchEvent(event)
}

beforeEach(() => {
  resetDebugger()
  resetForTests()
  delete (globalThis as Record<string, unknown>).__nymDelivery
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

  it('removes its listener and its global once read', async () => {
    installCdpMock()

    const probe = await armDelivery(TAB, ['mousedown'])
    await probe.read()

    const registry = (globalThis as Record<string, unknown>).__nymDelivery as Record<
      string,
      unknown
    >
    expect(Object.keys(registry ?? {})).toHaveLength(0)
    // A later event has nothing stale left to count it twice.
    const next = await armDelivery(TAB, ['mousedown'])
    firePageEvent('mousedown')
    expect((await next.read()).outcome).toBe('yes')
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
          return {
            result: {
              value: (new Function(`return (${expression})`) as () => unknown)(),
            },
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
