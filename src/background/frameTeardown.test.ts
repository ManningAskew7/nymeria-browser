import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installCdpEventRouter,
  resetForTests as resetDebugger,
  sendCommand,
} from './debuggerSession'
import { installFrameTeardown, resetForTests as resetFrameTeardown } from './frameTeardown'
import { resetForTests as resetRefs, resolve, set as setRefs } from './snapshotRefs'
import {
  cachedWorld,
  PROBE_WORLD,
  resetForTests as resetWorlds,
  worldFor,
} from './worlds'

/**
 * Frame-session teardown wiring: a detach kills that session's cached
 * WORLDS (context ids are per-session and can never answer again) while
 * refs deliberately SURVIVE (they key on the frame's stable target id, not
 * the ephemeral session; the 10s idle detach would otherwise kill every
 * frame ref between two tool calls, measured 2026-08-16). Tested against
 * the real CDP event router, the way the worker receives the event.
 */

const TAB = 1
const TAB_URL = 'https://example.com'
const FRAME_SESSION = 'SESSION-ABC'
const FRAME_TARGET = 'FRAME-TARGET-1'

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
  resetFrameTeardown()
  installFrameTeardown()
})

describe('per-frame world teardown', () => {
  it("a frame detach drops that session's world; refs and the top frame survive", async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 100, role: 'button', name: 'Pay' }],
        ['e2', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Card' }],
      ]),
      TAB_URL,
      2,
    )
    await worldFor(TAB, PROBE_WORLD)
    await worldFor({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)
    expect(cachedWorld({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)).toBe(99)

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })

    // The world is gone with its session...
    expect(cachedWorld({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)).toBeUndefined()
    // ...but the frame ref still RESOLVES: sessions churn on the idle
    // detach, and killing refs with them cost multiple re-reads per round.
    // Whether the frame is still live is the act layer's question.
    expect(resolve(TAB, '@e2', TAB_URL)).toMatchObject({
      ok: true,
      backendNodeId: 7,
      frameTargetId: FRAME_TARGET,
    })
    expect(resolve(TAB, '@e1', TAB_URL)).toMatchObject({ ok: true, backendNodeId: 100 })
    expect(cachedWorld(TAB, PROBE_WORLD)).toBe(88)
  })

  it('a detach event without a sessionId clears nothing', async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    await worldFor(TAB, PROBE_WORLD)

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', {})

    expect(cachedWorld(TAB, PROBE_WORLD)).toBe(88)
  })

  it('other CDP events pass through without touching worlds', async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    await worldFor({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)

    cdpEmitter()({ tabId: TAB }, 'Page.frameNavigated', { sessionId: FRAME_SESSION })

    expect(cachedWorld({ tabId: TAB, sessionId: FRAME_SESSION }, PROBE_WORLD)).toBe(99)
  })
})
