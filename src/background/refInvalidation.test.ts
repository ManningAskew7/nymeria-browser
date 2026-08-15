import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installCdpEventRouter,
  resetForTests as resetDebugger,
  sendCommand,
} from './debuggerSession'
import { installRefInvalidation, resetForTests as resetRefInvalidation } from './refInvalidation'
import { resetForTests as resetRefs, resolve, set as setRefs } from './snapshotRefs'
import {
  cachedWorld,
  PROBE_WORLD,
  resetForTests as resetWorlds,
  worldFor,
} from './worlds'

/**
 * The per-frame invalidation wiring (#160 behavior 11): a frame session
 * detaching (its OOPIF navigated cross-process or left the page) must kill
 * BOTH that frame's refs and its cached probe world, while the top frame's
 * survive. Tested against the real CDP event router, the way the worker
 * receives the event.
 */

const TAB = 1
const TAB_URL = 'https://example.com'
const FRAME_SESSION = 'SESSION-ABC'

type CdpListener = (source: { tabId: number }, method: string, params: unknown) => void

function cdpEmitter(): CdpListener {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  return addListener.mock.calls.at(-1)?.[0] as CdpListener
}

function installCdpMock() {
  const sendCommandMock = vi.fn(
    async (target: unknown, method: string) => {
      const sessionId = (target as { sessionId?: string }).sessionId
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: sessionId ? 'frame-child' : 'frame-root' } } }
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: sessionId ? 99 : 88 }
      }
      return {}
    },
  )
  ;(chrome.debugger.sendCommand as unknown) = sendCommandMock
  return sendCommandMock
}

beforeEach(() => {
  resetRefs()
  resetWorlds()
  resetDebugger()
  resetRefInvalidation()
  installRefInvalidation()
})

describe('per-frame ref and world invalidation', () => {
  it("a frame detach drops that session's refs and world; the top frame keeps both", async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 100, role: 'button', name: 'Pay' }],
        ['e2', { backendNodeId: 7, sessionId: FRAME_SESSION, role: 'button', name: 'Card' }],
      ]),
      TAB_URL,
      2,
    )
    await worldFor(TAB, PROBE_WORLD)
    await worldFor({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)
    expect(cachedWorld({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)).toBe(99)

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })

    const framed = resolve(TAB, '@e2', TAB_URL)
    expect(framed.ok).toBe(false)
    if (!framed.ok) expect(framed.reason).toBe('stale-read')
    expect(cachedWorld({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)).toBeUndefined()
    // The top frame is untouched: whole-map clearing here would make
    // ad-heavy pages unusable, their iframes churn constantly.
    expect(resolve(TAB, '@e1', TAB_URL)).toMatchObject({ ok: true, backendNodeId: 100 })
    expect(cachedWorld(TAB, PROBE_WORLD)).toBe(88)
  })

  it('a detach event without a sessionId clears nothing', async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    setRefs(
      TAB,
      new Map([['e1', { backendNodeId: 100, role: 'button', name: 'Pay' }]]),
      TAB_URL,
      1,
    )
    await worldFor(TAB, PROBE_WORLD)

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', {})

    expect(resolve(TAB, '@e1', TAB_URL)).toMatchObject({ ok: true })
    expect(cachedWorld(TAB, PROBE_WORLD)).toBe(88)
  })

  it('other CDP events pass through without touching refs', async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    setRefs(
      TAB,
      new Map([['e1', { backendNodeId: 100, sessionId: FRAME_SESSION, role: 'button', name: 'Pay' }]]),
      TAB_URL,
      1,
    )

    cdpEmitter()({ tabId: TAB }, 'Page.frameNavigated', { sessionId: FRAME_SESSION })

    expect(resolve(TAB, '@e1', TAB_URL)).toMatchObject({ ok: true })
  })
})
