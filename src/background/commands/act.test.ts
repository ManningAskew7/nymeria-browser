import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct, __test } from './act'
import { resetForTests as resetDebugger } from '../debuggerSession'
import { push as pushConsole, resetForTests as resetConsole } from '../consoleBuffer'
import { resetForTests as resetDelivery } from '../delivery'
import { resetForTests as resetRefs, set as setRefs } from '../snapshotRefs'

const TAB = 1
const TAB_URL = 'https://example.com'

interface MockOptions {
  /** null means the element has no layout box (hidden / zero-size). */
  geometry?: { x: number; y: number; w: number; h: number } | null
  hit?: { hit: boolean; blocker?: string }
  value?: string | null
  resolveNode?: boolean
  settleValue?: string
  bodyText?: string
  selectMatches?: boolean
  /** false models a tab where the probe's isolated world cannot be created. */
  deliveryWorld?: boolean
  /** How many events the page saw. 0 is the suppressed-tab case. */
  deliveryCount?: number
  /** Thrown by the probe read, to model a context that died mid-action. */
  deliveryReadThrows?: string
  /**
   * true models a renderer suspended by a page dialog: EVERY renderer-bound
   * call queues behind it, not just one. Hanging a single method would model a
   * slow call and would pass even if the liveness check were removed.
   */
  rendererHangs?: boolean
  /** true models an action that RAISES a dialog: healthy until input lands. */
  rendererHangsAfterDispatch?: boolean
  /** true models a document containing iframes, where the probe sees one only. */
  pageHasFrames?: boolean
  /** false models a target inside an iframe the probe never watched. */
  targetInTopDocument?: boolean
}

/**
 * A CDP mock that answers by inspecting what is actually being asked, so the
 * tests assert on the wire traffic an action produces rather than on internal
 * call order.
 */
function installCdpMock(opts: MockOptions = {}) {
  const {
    geometry = { x: 50, y: 60, w: 100, h: 20 },
    hit = { hit: true },
    value = 'old value',
    resolveNode = true,
    settleValue = 'quiet',
    bodyText = '',
    selectMatches = true,
    deliveryWorld = true,
    deliveryCount = 1,
    deliveryReadThrows,
    rendererHangs,
    rendererHangsAfterDispatch,
    pageHasFrames = false,
    targetInTopDocument = true,
  } = opts
  const PROBE_CONTEXT = 77
  let dispatched = false

  // Every method that needs the renderer's main thread. A page suspended by its
  // own dialog answers NONE of them, which is what makes a single-method hang
  // the wrong model: it would pass with the liveness check deleted.
  const RENDERER_BOUND = new Set([
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.resolveNode',
    'Page.createIsolatedWorld',
  ])

  const sendCommand = vi.fn(async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
    if (rendererHangs && RENDERER_BOUND.has(method)) return new Promise<never>(() => {})
    if (method.startsWith('Input.')) dispatched = true
    if (rendererHangsAfterDispatch && dispatched && RENDERER_BOUND.has(method)) {
      return new Promise<never>(() => {})
    }
    if (method === 'DOM.resolveNode') {
      return resolveNode ? { object: { objectId: 'obj-1' } } : { object: {} }
    }
    if (method === 'Runtime.callFunctionOn') {
      const fn = String(params.functionDeclaration ?? '')
      if (fn.includes('getBoundingClientRect')) {
        return { result: { value: geometry } }
      }
      if (fn.includes('elementFromPoint')) return { result: { value: hit } }
      if (fn.includes('isConnected')) return { result: { value: true } }
      if (fn.includes('ownerDocument')) return { result: { value: targetInTopDocument } }
      if (fn.includes('this.options')) return { result: { value: selectMatches } }
      if (fn.includes('this.checked') && fn.includes('return')) return { result: { value: value } }
      if (fn.includes('this.value !== undefined')) return { result: { value } }
      return { result: { value: undefined } }
    }
    if (method === 'Page.getFrameTree') {
      return deliveryWorld ? { frameTree: { frame: { id: 'frame-1' } } } : {}
    }
    if (method === 'Page.createIsolatedWorld') {
      return { executionContextId: PROBE_CONTEXT }
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      // The delivery probe, addressed to its own isolated world. Answered by
      // count rather than by running the page-side code: that logic has its own
      // executed-for-real tests in delivery.test.ts, and here we only care what
      // an action DOES with each outcome.
      if (params.contextId === PROBE_CONTEXT) {
        if (expression.includes('addEventListener')) return { result: { value: true } }
        if (expression.includes('querySelectorAll')) {
          return { result: { value: !pageHasFrames } }
        }
        if (deliveryReadThrows) throw new Error(deliveryReadThrows)
        return { result: { value: deliveryCount } }
      }
      if (expression.includes('MutationObserver')) return { result: { value: settleValue } }
      if (expression.includes('activeElement')) {
        return { result: { value: { tag: 'input', label: 'Email' } } }
      }
      if (expression.includes('innerWidth')) return { result: { value: { x: 400, y: 300 } } }
      if (expression.includes('innerText.includes')) {
        const needle = expression.slice(expression.indexOf('includes(') + 9, expression.lastIndexOf(')'))
        return { result: { value: bodyText.includes(JSON.parse(needle)) } }
      }
      if (expression.includes('querySelector') || expression.includes('document.evaluate')) {
        return { result: { objectId: 'css-obj' } }
      }
      return { result: { value: undefined } }
    }
    return {}
  })
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

function methodsOf(mock: ReturnType<typeof installCdpMock>): string[] {
  return mock.mock.calls.map((c) => c[1] as string)
}

function inputEventTypes(mock: ReturnType<typeof installCdpMock>): string[] {
  return mock.mock.calls
    .filter((c) => c[1] === 'Input.dispatchMouseEvent')
    .map((c) => (c[2] as { type: string }).type)
}

beforeEach(() => {
  resetRefs()
  resetDebugger()
  resetConsole()
  resetDelivery()
})

describe('trusted input', () => {
  it('clicks through browser-level input events, not page-synthesized ones', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect((result.data as { input: string }).input).toBe('trusted')
    // The synthetic path must NOT have been used.
    const synthetic = cdp.mock.calls.some(
      (c) => c[1] === 'Runtime.callFunctionOn' && String((c[2] as { functionDeclaration?: string }).functionDeclaration).includes('this.click()'),
    )
    expect(synthetic).toBe(false)
  })

  it('double_click presses twice with an increasing click count', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'double_click', ref: '@e1' })

    const presses = cdp.mock.calls
      .filter((c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed')
      .map((c) => (c[2] as { clickCount: number }).clickCount)
    expect(presses).toEqual([1, 2])
  })

  it('falls back to synthetic dispatch when the element has no layout box, and says so', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ geometry: null })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { input: string; synthetic_reason?: string }
    expect(data.input).toBe('synthetic')
    expect(data.synthetic_reason).toMatch(/no layout box/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('refuses the click when another element covers the point, and names it', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ hit: { hit: false, blocker: 'div#cookie-banner' } })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div#cookie-banner/)
    expect((result.data as { intercepted_by: string }).intercepted_by).toBe('div#cookie-banner')
    // Nothing was clicked: refusing beats clicking the overlay.
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('fills by inserting text into the focused element and reports the previous value', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ value: 'before@example.com' })

    const result = await execAct({
      tab_id: TAB,
      action: 'fill',
      ref: '@e1',
      value: 'after@example.com',
    })

    expect(result.ok).toBe(true)
    const methods = methodsOf(cdp)
    expect(methods).toContain('DOM.focus')
    expect(methods).toContain('Input.insertText')
    const data = result.data as { previous_value: string; input: string }
    expect(data.previous_value).toBe('before@example.com')
    expect(data.input).toBe('trusted')
  })
})

describe('ref lifecycle', () => {
  it('refuses to act on a ref minted on a different URL and says to re-read', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), 'https://example.com/checkout')
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/re-read the page/)
    expect((result.data as { stale_refs: boolean; reason: string }).stale_refs).toBe(true)
    expect((result.data as { reason: string }).reason).toBe('navigated')
    expect(methodsOf(cdp)).not.toContain('DOM.resolveNode')
  })

  it('reports no-snapshot rather than an unknown-ref crash after a worker recycle', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect((result.data as { reason: string }).reason).toBe('no-snapshot')
    expect(result.error).toMatch(/read the page first/)
  })

  it('reports unknown-ref for a ref that was never minted', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e99' })

    expect(result.ok).toBe(false)
    expect((result.data as { reason: string }).reason).toBe('unknown-ref')
  })

  it('reports a ref that resolves to nothing as stale rather than acting', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ resolveNode: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer exists/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })
})

describe('verification payload', () => {
  it('surfaces console errors raised since the action started', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()
    // An error from before the action must not be attributed to it.
    pushConsole(TAB, { level: 'error', text: 'stale earlier error', ts: Date.now() - 60_000 })

    const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
    pushConsole(TAB, { level: 'error', text: 'POST /cart 500', ts: Date.now() + 5 })
    const result = await pending

    const errors = (result.data as { console_errors?: { text: string }[] }).console_errors ?? []
    expect(errors.map((e) => e.text)).toEqual(['POST /cart 500'])
  })

  it('reports a URL change caused by the action', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementationOnce(async () => ({ id: TAB, url: TAB_URL }))
      .mockImplementation(async () => ({ id: TAB, url: 'https://example.com/thanks' }))

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { url_changed: boolean; url: string }
    expect(data.url_changed).toBe(true)
    expect(data.url).toBe('https://example.com/thanks')
  })

  it('waits for the page to settle and reports the outcome', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ settleValue: 'quiet' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const settled = (result.data as { settled: { settled: boolean; reason: string } }).settled
    expect(settled.settled).toBe(true)
    expect(settled.reason).toBe('quiet')
  })

  it('reports a deadline settle without failing the action', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ settleValue: 'deadline' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { settled: { reason: string } }).settled.reason).toBe('deadline')
  })

  it('reports not-found on timeout instead of claiming success', async () => {
    installCdpMock({ bodyText: 'still loading' })

    const result = await execAct({
      tab_id: TAB,
      action: 'wait',
      wait_for: { text: 'Order confirmed' },
      timeout_ms: 150,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/wait timed out/)
    expect((result.data as { found: boolean }).found).toBe(false)
  })

  it('waits on a url substring', async () => {
    installCdpMock()
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({ id: TAB, url: 'https://example.com/checkout/done' }))

    const result = await execAct({
      tab_id: TAB,
      action: 'wait',
      wait_for: { url_contains: '/checkout/done' },
      timeout_ms: 500,
    })

    expect(result.ok).toBe(true)
    expect((result.data as { found: boolean }).found).toBe(true)
  })
})

describe('argument handling', () => {
  it('rejects an unknown target format', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', ref: 'plain-string' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must start with @, css=, or xpath=/)
  })

  it('requires a value for fill', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/fill requires value/)
  })

  it('requires a target for element actions', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/requires ref or coordinate/)
  })

  it('accepts a bare coordinate target', async () => {
    const cdp = installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [120, 240] })
    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 120, y: 240 })
  })

  it('resolves a css= target through Runtime.evaluate', async () => {
    const cdp = installCdpMock()
    const resolution = await __test.resolveTarget(TAB, 'css=.btn-primary', TAB_URL)
    expect(resolution.ok).toBe(true)
    expect(methodsOf(cdp)).toContain('Runtime.evaluate')
  })

  it('reports a css= target that matches nothing', async () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { subtype: 'null' } }))
    const resolution = await __test.resolveTarget(TAB, 'css=#missing', TAB_URL)
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.error).toMatch(/matched no element/)
  })

  it('selects by visible label, not just by option value', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ selectMatches: true })

    const result = await execAct({ tab_id: TAB, action: 'select', ref: '@e1', value: 'Express shipping' })

    expect(result.ok).toBe(true)
    const call = cdp.mock.calls.find(
      (c) => c[1] === 'Runtime.callFunctionOn' && String((c[2] as { functionDeclaration: string }).functionDeclaration).includes('this.options'),
    )
    expect(call).toBeDefined()
    expect((result.data as { input: string }).input).toBe('synthetic')
  })

  it('fails a select whose value matches no option', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ selectMatches: false })

    const result = await execAct({ tab_id: TAB, action: 'select', ref: '@e1', value: 'Teleport' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no option matching/)
  })
})

describe('execAct target resolution', () => {
  it('focuses the ref before typing instead of typing wherever focus happened to be', async () => {
    // `type` and `key` advertise a `ref`, and the failure mode when it is
    // ignored is invisible: the characters land in whatever was already
    // focused (the previous field, the page's search box) and the command
    // still reports ok:true. Nothing downstream can tell the difference.
    const mock = installCdpMock()
    setRefs(TAB, new Map([['e1', { backendNodeId: 77 }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'hi' })

    expect(result.ok).toBe(true)
    const methods = methodsOf(mock)
    expect(methods).toContain('DOM.resolveNode')
    const focusAt = methods.indexOf('DOM.focus')
    const typedAt = methods.indexOf('Input.dispatchKeyEvent')
    expect(focusAt, 'the ref must be focused').toBeGreaterThanOrEqual(0)
    expect(typedAt, 'keystrokes must follow the focus, not precede it').toBeGreaterThan(focusAt)
  })

  it('refuses to check a box whose click point is covered, rather than forcing the property', async () => {
    // Forcing `.checked` on an intercepted element sets the property without
    // the page's own change handler running, so the agent sees success while
    // the state the site actually reads never moved. `click` already refuses
    // here; check must not be the soft path around that refusal.
    const mock = installCdpMock({ hit: { hit: false, blocker: 'div.cookie-banner' }, value: null })
    setRefs(TAB, new Map([['e1', { backendNodeId: 77 }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'check', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div\.cookie-banner/)
    const forced = mock.mock.calls.some(
      (c) =>
        c[1] === 'Runtime.callFunctionOn' &&
        String((c[2] as { functionDeclaration?: string }).functionDeclaration ?? '').includes(
          'this.checked =',
        ),
    )
    expect(forced, 'must not fall back to forcing the property').toBe(false)
  })
})

describe('input delivery', () => {
  /**
   * The failure these cover: Chrome disables page input while a tab-modal
   * dialog is showing, so `Input.dispatch*` is accepted by CDP, acked without
   * error, and discarded before the renderer. Nothing mutates, so settle
   * reports `quiet`, and the action reported a clean success having done
   * nothing at all.
   */

  it('fails the command when the page provably received no event', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/received no event/)
  })

  it('gives both recoveries in cheapest-first order and rules out reloading', async () => {
    // The agent cannot see browser UI: not in the tree, not in the console, not
    // in a screenshot. Told only that the click failed it will retry the same
    // dead tab forever, which is exactly what happened live.
    //
    // The ORDER is measured, not stylistic (2026-08-11). Navigating away DID
    // recover a tab held by an HTTP auth prompt, so leading with "open a fresh
    // tab" throws away the cheap fix and the work already done in that tab. It
    // did NOT recover a tab poisoned by an alert(), so closing has to remain the
    // fallback that always works.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const error = String(result.error)
    expect(error).toMatch(/navigate this tab/i)
    expect(error).toMatch(/close the tab/i)
    expect(error.search(/navigate this tab/i)).toBeLessThan(error.search(/close the tab/i))
    expect(error).toMatch(/reloading does not help/i)
  })

  it('warns that the suppression can outlive the dialog that caused it', async () => {
    // Measured 2026-08-11 and genuinely counter-intuitive: after an alert() was
    // dismissed by navigating away, the tab ran scripts again (a page read
    // returned real content in under a second) while input stayed undelivered.
    // So there can be NOTHING on screen to find. An agent told only "a dialog
    // may be blocking you" looks, sees a clean page, concludes the tool is
    // wrong, and retries the dead tab.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.error).toMatch(/outlive/i)
  })

  it('fails when the action itself suspends the page, and says the input LANDED', async () => {
    // The commoner dialog case, and the one a pre-flight alone cannot see: the
    // click raises the dialog. Everything after dispatch is renderer-bound,
    // including settle, whose deadline is in-page and never ticks. Telling the
    // agent nothing was sent here would invite a retry that double-submits.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      installCdpMock({ rendererHangsAfterDispatch: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      const error = String(result.error)
      expect(error).toMatch(/was sent/i)
      expect(error).toMatch(/not simply retry/i)
      expect(error).not.toMatch(/was NOT sent/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on a css= target too, where nothing is armed at all', async () => {
    // The seam this sits at matters. Target resolution runs BEFORE any delivery
    // probe and a `css=` selector resolves through a bare `Runtime.evaluate`, so
    // a check placed after arming never runs on this path and the command hangs
    // its full transport timeout. Review finding, 2026-08-11.
    vi.useFakeTimers()
    try {
      const cdp = installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: 'css=#go' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/did not run a script/i)
      expect(methodsOf(cdp)).not.toContain('Input.dispatchMouseEvent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on a verb with no probeable events, like hover', async () => {
    // Coverage must not be decided by PROBE_EVENTS, which excludes hover and
    // scroll for reasons about event coalescing that have nothing to do with
    // noticing a dead renderer.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'hover', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/did not run a script/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast WITHOUT dispatching when the page will not run a script', async () => {
    // A page dialog suspends the renderer, so arming never returns. Before the
    // deadline this rode the 30s transport timeout and came back with no payload
    // and no action-scoped reason: measured live 2026-08-11 against a real
    // alert(). The tool-layer message names the dialog cause since 71a41e7b;
    // what was missing is failing FAST and per action.
    //
    // The not-dispatched assertion is the point. Sending input into a suspended
    // page cannot work, and every step after it (dispatch, settle, verification)
    // also runs in-page and would each wait out their own share of the timeout
    // to learn the same thing.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      const cdp = installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(methodsOf(cdp)).not.toContain('Input.dispatchMouseEvent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names both causes of a stall and asserts neither', async () => {
    // A dialog and a long-running script are indistinguishable from out here.
    // The compared Chrome extension's equivalent messages each assert one wrong
    // cause ("showing error page", "page still loading") and its own operator
    // had to decode them, so this one lists both and commits to neither.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      const error = String(result.error)
      expect(error).toMatch(/did not run a script/i)
      expect(error).toMatch(/alert, confirm, prompt/i)
      expect(error).toMatch(/long-running script/i)
      // Must not claim delivery failed: nothing was sent, so there is no verdict.
      expect(error).not.toMatch(/received no event/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the whole verification payload on the failure', async () => {
    // A failure that drops the diagnostics is a worse trade than the silent
    // success it replaced.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as Record<string, unknown>
    expect(data).toBeDefined()
    expect(data.action).toBe('click')
    expect(data.url).toBe(TAB_URL)
    expect(data.settled).toBeDefined()
  })

  it('reports the channel and the outcome as two separate answers', async () => {
    // `input: "trusted"` says which pipe was used. It must keep saying that on
    // a dropped event, because collapsing the two is how the original bug read
    // as success.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { input: string; input_delivered: string }
    expect(data.input).toBe('trusted')
    expect(data.input_delivered).toBe('no')
  })

  it('succeeds and records delivery when the event arrived', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 1 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('yes')
  })

  it('does not fail the command when delivery could not be proven either way', async () => {
    // Unprovable is not the same as failed. Turning "we could not check" into
    // an error would make the tool unusable wherever the probe cannot run.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryWorld: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('treats an action that navigated the page as delivered', async () => {
    // The probe died with its document, so the count is unreadable, but a
    // navigation is proof the input landed.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryReadThrows: 'Cannot find context with specified id' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('yes')
  })

  it('checks delivery for every verb that goes in through browser-level input', async () => {
    for (const action of ['click', 'double_click', 'right_click', 'key', 'type']) {
      resetRefs()
      resetDelivery()
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      installCdpMock({ deliveryCount: 0 })

      const result = await execAct({ tab_id: TAB, action, ref: '@e1', value: 'a' })

      expect(result.ok, `${action} must report an undelivered event as a failure`).toBe(false)
      expect(result.error, `${action} error text`).toMatch(/received no event/)
    }
  })

  it('does not probe the verbs that never touch the browser input gate', async () => {
    // `fill` is Input.insertText, an IME commit on a path the gate does not
    // consult: it kept working live while every other verb was suppressed.
    // `select` and `check` run in-page, and `check` already verifies itself.
    for (const [action, extra] of [
      ['fill', { value: 'x' }],
      ['select', { value: 'Option 2' }],
      ['check', {}],
    ] as const) {
      resetRefs()
      resetDelivery()
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      const cdp = installCdpMock({ deliveryCount: 0, value: 'false' })

      const result = await execAct({ tab_id: TAB, action, ref: '@e1', ...extra })

      expect(result.ok, `${action} must not be failed by the delivery probe`).toBe(true)
      expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
      expect(
        methodsOf(cdp),
        `${action} must not pay for a probe it does not need`,
      ).not.toContain('Page.createIsolatedWorld')
    }
  })

  it('arms the probe after target resolution so setup cannot be counted as delivery', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const methods = methodsOf(cdp)
    const armed = cdp.mock.calls.findIndex(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression ?? '').includes('addEventListener'),
    )
    const dispatched = methods.indexOf('Input.dispatchMouseEvent')
    expect(armed).toBeGreaterThan(-1)
    // After resolution, so the resolve traffic cannot be counted as delivery,
    // and before dispatch, so the dispatch can be.
    expect(armed).toBeGreaterThan(methods.indexOf('DOM.resolveNode'))
    expect(dispatched).toBeGreaterThan(armed)
  })
})

describe('delivery in framed pages', () => {
  /**
   * The probe watches one document, the top one, but this tool deliberately
   * acts inside iframes: cross-origin frames are where payment fields and
   * consent dialogs live, and the whole `elementSession` / `frameOffset`
   * machinery exists for them. Events dispatched inside a frame never reach the
   * top window, so a zero count there means "not seen here", not "not
   * delivered". Failing on it would tell the agent to abandon a working tab and
   * retry in a fresh one, where the identical failure repeats.
   */

  it('does not fail a click whose target lives inside an iframe', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: true, targetInTopDocument: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok, 'an unwatched frame is not evidence of suppression').toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('still fails when the target is in the top document the probe watched', async () => {
    // Frames exist, but this target is not in one, so a zero count is real.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: true, targetInTopDocument: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/received no event/)
  })

  it('trusts a zero count outright when the document has no frames at all', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
  })

  it('does not fail an untargeted action on a framed page', async () => {
    // A keystroke with no ref goes to whatever holds focus, which on a framed
    // page may be inside a frame. With no target there is nothing to check the
    // absence against, so it cannot be confirmed.
    installCdpMock({ deliveryCount: 0, pageHasFrames: true })

    const result = await execAct({ tab_id: TAB, action: 'key', value: 'a' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('still fails an untargeted action on a page with no frames', async () => {
    installCdpMock({ deliveryCount: 0, pageHasFrames: false })

    const result = await execAct({ tab_id: TAB, action: 'key', value: 'a' })

    expect(result.ok).toBe(false)
  })
})

describe('delivery is only asked about input we actually dispatched', () => {
  it('does not fail a click that deliberately fell back to synthetic dispatch', async () => {
    // A hidden file input has no layout box, so the click goes in as
    // `this.click()`. That produces no TRUSTED event by definition, so probing
    // it would fail the one path chrome_find's own docstring recommends for
    // upload buttons, on a page with nothing wrong with it.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ geometry: null, deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input: string }).input).toBe('synthetic')
    expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
  })

  it('does not fail a type of the empty string, which dispatches nothing', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: '' })

    expect(result.ok).toBe(true)
    expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
  })

  it('still checks a click that did go in as trusted input', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
  })
})
