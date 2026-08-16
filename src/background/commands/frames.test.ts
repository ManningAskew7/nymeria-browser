import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct } from './act'
import {
  frameSessions,
  installCdpEventRouter,
  resetForTests as resetDebugger,
  sendCommand,
} from '../debuggerSession'
import { resetForTests as resetConsole } from '../consoleBuffer'
import { resetForTests as resetRefs, resolve as resolveRef, set as setRefs } from '../snapshotRefs'
import { resetForTests as resetWorlds } from '../worlds'

/**
 * Cross-origin iframes are the case that decides whether a checkout flow can
 * be completed at all: payment fields and consent dialogs live in them, they
 * run in their own renderer, and they are absent from the page's own tree.
 */

const TAB = 1
// Must match the tab url in the chrome mock, or refs read as stale.
const TAB_URL = 'https://example.com'
const FRAME_SESSION = 'SESSION-ABC'
const FRAME_TARGET = 'FRAME-TARGET-1'

type CdpListener = (source: { tabId: number }, method: string, params: unknown) => void

function cdpEmitter(): CdpListener {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  return addListener.mock.calls.at(-1)?.[0] as CdpListener
}

interface MockOpts {
  /** Rect the element reports inside its own frame. */
  frameLocalRect?: { x: number; y: number; w: number; h: number }
  /** Rect the <iframe> element reports in the main document. */
  iframeRect?: { left: number; top: number }
}

function installCdpMock(opts: MockOpts = {}) {
  const local = opts.frameLocalRect ?? { x: 30, y: 40, w: 100, h: 20 }
  const iframeRect = opts.iframeRect ?? { left: 200, top: 300 }

  const sendCommandMock = vi.fn(
    async (target: unknown, method: string, params: Record<string, unknown> = {}) => {
      const sessionId = (target as { sessionId?: string }).sessionId
      if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${sessionId ?? 'root'}` } }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 555 }
      // Worlds: each session answers with its own frame and context id, so
      // probes minted for a frame element run in THAT frame's world.
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: sessionId ? 'frame-child' : 'frame-root' } } }
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: sessionId ? 99 : 88 }
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration ?? '')
        if (fn.includes('getComputedStyle')) {
          // The iframe element's own position in the main document.
          return { result: { value: { x: iframeRect.left, y: iframeRect.top } } }
        }
        if (fn.includes('getBoundingClientRect')) {
          return { result: { value: local } }
        }
        if (fn.includes('elementFromPoint')) return { result: { value: { hit: true } } }
        if (fn.includes('isConnected')) return { result: { value: true } }
        return { result: { value: undefined } }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '')
        if (expression.includes('MutationObserver')) return { result: { value: 'quiet' } }
        if (expression.includes('activeElement')) return { result: { value: null } }
        return { result: { value: undefined } }
      }
      return {}
    },
  )
  ;(chrome.debugger.sendCommand as unknown) = sendCommandMock
  return sendCommandMock
}

/** Attach the tab, then announce a cross-origin frame the way Chrome does. */
async function attachFrame(): Promise<void> {
  await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
  cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
    sessionId: FRAME_SESSION,
    targetInfo: { targetId: FRAME_TARGET, type: 'iframe', url: 'https://pay.example/card' },
  })
}

beforeEach(() => {
  resetRefs()
  resetDebugger()
  resetConsole()
  resetWorlds()
})

describe('frame session discovery', () => {
  it('records an attached cross-origin frame for the tab', async () => {
    installCdpMock()
    await attachFrame()

    const frames = frameSessions(TAB)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      sessionId: FRAME_SESSION,
      targetId: FRAME_TARGET,
      url: 'https://pay.example/card',
    })
  })

  it('ignores non-iframe targets', async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
      sessionId: 'worker-1',
      targetInfo: { targetId: 'W1', type: 'worker', url: 'https://shop.example/sw.js' },
    })

    expect(frameSessions(TAB)).toHaveLength(0)
  })

  it('forgets a frame when it detaches', async () => {
    installCdpMock()
    await attachFrame()
    expect(frameSessions(TAB)).toHaveLength(1)

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })
    expect(frameSessions(TAB)).toHaveLength(0)
  })
})

describe('frame-scoped refs', () => {
  it('keeps refs with the same backendNodeId in different frames distinct', () => {
    // backendNodeId is a PROCESS-global counter, so the same number really
    // does occur in two frames. Without the session the second ref would
    // resolve to the first frame's element and click the wrong thing.
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 42, role: 'button', name: 'Pay' }],
        ['e2', { backendNodeId: 42, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }],
      ]),
      TAB_URL,
    )

    const main = resolveRef(TAB, '@e1', TAB_URL)
    const framed = resolveRef(TAB, '@e2', TAB_URL)

    expect(main.ok && main.sessionId).toBeUndefined()
    expect(framed.ok && framed.sessionId).toBe(FRAME_SESSION)
  })

  it('resolves a frame ref through that frame session, not the page session', async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const resolveCall = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect(resolveCall?.[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })

    // The follow-up element calls must use the same session: an objectId from
    // a frame is meaningless on the page session, so running geometry or the
    // hit test on the root would read the wrong element (or nothing).
    const elementCalls = cdp.mock.calls.filter((c) => {
      if (c[1] !== 'Runtime.callFunctionOn') return false
      const fn = String((c[2] as { functionDeclaration?: string }).functionDeclaration)
      return /getBoundingClientRect|elementFromPoint|isConnected/.test(fn)
    })
    expect(elementCalls.length).toBeGreaterThan(0)
    for (const call of elementCalls) {
      expect(call[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })
    }
  })
})

describe('frame input dispatch', () => {
  it("dispatches a frame ref's click on the FRAME's own session at frame-local coordinates", async () => {
    // Root-session dispatch at composed root coordinates was measured live
    // (2026-08-15) never to reach OOPIF content: acked ok, nothing arrived.
    // The frame's own session is the delivery channel, and the coordinates
    // stay in the frame's viewport space end to end, so no offset exists.
    const cdp = installCdpMock({
      frameLocalRect: { x: 30, y: 40, w: 100, h: 20 },
      iframeRect: { left: 200, top: 300 },
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    // The frame-local point, verbatim. The iframe's own position on the
    // page (200, 300) must appear NOWHERE in the dispatch.
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    // No offset is measured at all: the owner lookup was the old shape.
    expect(cdp.mock.calls.some((c) => c[1] === 'DOM.getFrameOwner')).toBe(false)
  })

  it('dispatches a main-document click on the root session, un-offset', async () => {
    const cdp = installCdpMock({ frameLocalRect: { x: 30, y: 40, w: 100, h: 20 } })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
    expect(pressed?.[0]).toEqual({ tabId: TAB })
    expect(cdp.mock.calls.some((c) => c[1] === 'DOM.getFrameOwner')).toBe(false)
  })

  it('sends fill (focus, select-all, insertText) entirely on the frame session', async () => {
    // The pre-fix shape was a cross-session SPLIT: DOM.focus went to the
    // frame while Input.insertText went to the root, whose IME commits into
    // the ROOT document's focused element. Text never reached the frame.
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'textbox', name: 'Card number' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: '4242' })

    const focus = cdp.mock.calls.find((c) => c[1] === 'DOM.focus')
    expect(focus?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    const insert = cdp.mock.calls.find((c) => c[1] === 'Input.insertText')
    expect(insert?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    expect(insert?.[2]).toMatchObject({ text: '4242' })
  })

  it('sends type and key events on the frame session', async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'textbox', name: 'Card number' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'hi' })
    await execAct({ tab_id: TAB, action: 'key', ref: '@e1', value: 'Enter' })

    const keyEvents = cdp.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBeGreaterThan(0)
    for (const call of keyEvents) {
      expect(call[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    }
  })

  it('a covered frame target refuses without offering the root-coordinate escape', async () => {
    // The taught click-through is a bare-coordinate act, which dispatches on
    // the ROOT session: measured never to arrive inside a cross-origin
    // frame. Offering it for a frame target teaches a guaranteed no-op, and
    // a frame-local click_point would be a mixed-space trap for the same
    // move. The frame exit is the covering element's own ref.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      const params = args[2] as { functionDeclaration?: string } | undefined
      const fn = String(params?.functionDeclaration ?? '')
      if (args[1] === 'Runtime.callFunctionOn' && sessionId && fn.includes('elementFromPoint')) {
        return { result: { value: { hit: false, blocker: 'div#overlay' } } }
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div#overlay/)
    expect(result.error).toMatch(/own @ref/)
    expect(result.error).not.toMatch(/coordinate=\[/)
    expect((result.data as { click_point?: unknown })?.click_point).toBeUndefined()
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })
})

describe('cross-frame drag', () => {
  it('refuses a drag whose source and destination live in different sessions', async () => {
    // One pointer stream goes to ONE session; the root-dispatch alternative
    // is the measured OOPIF no-op. Fail closed, nothing dispatched.
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'listitem', name: 'Card' }],
        ['e2', { backendNodeId: 8, role: 'list', name: 'Saved cards' }],
      ]),
      TAB_URL,
    )

    const result = await execAct({ tab_id: TAB, action: 'drag', ref: '@e1', to_ref: '@e2' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cannot cross a frame boundary/)
    expect((result.data as { cross_frame?: boolean })?.cross_frame).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('dispatches a same-frame drag entirely on that frame session, frame-local', async () => {
    const cdp = installCdpMock({ frameLocalRect: { x: 30, y: 40, w: 100, h: 20 } })
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'listitem', name: 'Card' }],
        ['e2', { backendNodeId: 8, sessionId: FRAME_SESSION, role: 'list', name: 'Saved cards' }],
      ]),
      TAB_URL,
    )

    const result = await execAct({ tab_id: TAB, action: 'drag', ref: '@e1', to_ref: '@e2' })

    expect(result.ok).toBe(true)
    const mouseEvents = cdp.mock.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent')
    expect(mouseEvents.length).toBeGreaterThan(0)
    for (const call of mouseEvents) {
      expect(call[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    }
    const pressed = mouseEvents.find((c) => (c[2] as { type: string }).type === 'mousePressed')
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
  })
})

describe('frame probe worlds (#160)', () => {
  it("mints a frame ref's handle in that frame session's own world", async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    // The world is created ON the frame session (a cross-origin frame's DOM
    // is only reachable from its own session), and the handle resolve carries
    // that session's context id, not the root's.
    const worldCall = cdp.mock.calls.find(
      (c) =>
        c[1] === 'Page.createIsolatedWorld' &&
        (c[0] as { sessionId?: string }).sessionId === FRAME_SESSION,
    )
    expect(worldCall).toBeDefined()
    const resolveCall = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect(resolveCall?.[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })
    expect((resolveCall?.[2] as { executionContextId?: number }).executionContextId).toBe(99)
  })

  it("a frame click no longer depends on the ROOT session's world at all", async () => {
    // The old shape resolved the <iframe> owner in the root world to compose
    // the offset, so a root-world hiccup refused a perfectly measurable
    // frame click. With dispatch on the frame's own session there is nothing
    // left to ask the root: the click must succeed with root world creation
    // broken the whole time.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      const params = args[2] as { worldName?: string } | undefined
      if (args[1] === 'Page.createIsolatedWorld' && !sessionId && params?.worldName === 'nymeria_probe') {
        return {}
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
  })

  it('a frame session that refuses world creation gets one Page.enable and a retry (throw shape)', async () => {
    // Live-measured 2026-08-15: on the user's Chrome, OOPIF world creation
    // failed until Page was enabled on that session, so every click inside
    // a cross-origin iframe refused. The retry is the fix; this pins it.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const enabledSessions = new Set<string>()
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      if (args[1] === 'Page.enable' && sessionId) {
        enabledSessions.add(sessionId)
        return {}
      }
      if (args[1] === 'Page.createIsolatedWorld' && sessionId && !enabledSessions.has(sessionId)) {
        throw new Error("'Page.createIsolatedWorld' wasn't found")
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(enabledSessions.has(FRAME_SESSION)).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(true)
  })

  it('the enable retry also covers a frame session answering world creation with nothing', async () => {
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const enabledSessions = new Set<string>()
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      if (args[1] === 'Page.enable' && sessionId) {
        enabledSessions.add(sessionId)
        return {}
      }
      if (args[1] === 'Page.createIsolatedWorld' && sessionId && !enabledSessions.has(sessionId)) {
        return {}
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(enabledSessions.has(FRAME_SESSION)).toBe(true)
  })

  it('a ROOT session world failure gets no enable retry (Page is already enabled per attach)', async () => {
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      const params = args[2] as { worldName?: string } | undefined
      if (args[1] === 'Page.createIsolatedWorld' && !sessionId && params?.worldName === 'nymeria_probe') {
        return {}
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, role: 'button', name: 'Pay' }]]), TAB_URL)
    // The attach itself enables Page on the root (#169); the retry would be
    // an ADDITIONAL enable, so compare counts across the act.
    const rootEnables = () =>
      cdp.mock.calls.filter(
        (c) => c[1] === 'Page.enable' && (c[0] as { sessionId?: string }).sessionId === undefined,
      ).length
    const before = rootEnables()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(rootEnables()).toBe(before)
  })

})
