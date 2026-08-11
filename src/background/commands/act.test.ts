import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct, __test } from './act'
import { resetForTests as resetDebugger } from '../debuggerSession'
import { push as pushConsole, resetForTests as resetConsole } from '../consoleBuffer'
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
  } = opts

  const sendCommand = vi.fn(async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
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
      if (fn.includes('this.options')) return { result: { value: selectMatches } }
      if (fn.includes('this.checked') && fn.includes('return')) return { result: { value: value } }
      if (fn.includes('this.value !== undefined')) return { result: { value } }
      return { result: { value: undefined } }
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
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

  it('skips settling when settle is disabled', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1', settle: false })

    expect((result.data as { settled?: unknown }).settled).toBeUndefined()
  })
})

describe('wait', () => {
  it('returns as soon as the awaited text is present', async () => {
    installCdpMock({ bodyText: 'Order confirmed' })

    const result = await execAct({
      tab_id: TAB,
      action: 'wait',
      wait_for: { text: 'Order confirmed' },
      timeout_ms: 1000,
    })

    expect(result.ok).toBe(true)
    const data = result.data as { found: boolean; condition: string }
    expect(data.found).toBe(true)
    expect(data.condition).toBe('text:Order confirmed')
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
