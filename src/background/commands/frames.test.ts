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
        ['e1', { backendNodeId: 42 }],
        ['e2', { backendNodeId: 42, sessionId: FRAME_SESSION }],
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const resolveCall = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect(resolveCall?.[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })

    // The follow-up element calls must use the same session: an objectId from
    // a frame is meaningless on the page session, so running geometry or the
    // hit test on the root would read the wrong element (or nothing).
    const elementCalls = cdp.mock.calls.filter((c) => {
      if (c[1] !== 'Runtime.callFunctionOn') return false
      const fn = String((c[2] as { functionDeclaration?: string }).functionDeclaration)
      // The frame-offset probe measures the <iframe> element itself, which
      // lives in the MAIN document, so it correctly runs on the root session.
      if (fn.includes('getComputedStyle')) return false
      return /getBoundingClientRect|elementFromPoint|isConnected/.test(fn)
    })
    expect(elementCalls.length).toBeGreaterThan(0)
    for (const call of elementCalls) {
      expect(call[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })
    }
  })
})

describe('frame input geometry', () => {
  it('composes the frame offset so a click in an iframe lands on the page', async () => {
    const cdp = installCdpMock({
      frameLocalRect: { x: 30, y: 40, w: 100, h: 20 },
      iframeRect: { left: 200, top: 300 },
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, sessionId: FRAME_SESSION }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    // 30 + 200, 40 + 300: frame-local rect plus the iframe's own position.
    expect(pressed?.[2]).toMatchObject({ x: 230, y: 340 })
    // Input is dispatched on the ROOT session; Chrome routes it into the frame.
    expect(pressed?.[0]).toEqual({ tabId: TAB })
  })

  it('does not offset an element in the main document', async () => {
    const cdp = installCdpMock({ frameLocalRect: { x: 30, y: 40, w: 100, h: 20 } })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7 }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
    expect(cdp.mock.calls.some((c) => c[1] === 'DOM.getFrameOwner')).toBe(false)
  })
})
