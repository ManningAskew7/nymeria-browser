import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  execLoginSessionStart,
  execLoginSessionStop,
  handleLoginInput,
  loginSessionTabs,
  MAX_QUEUED_FRAMES,
  resetLoginSessionsForTests,
} from './login_session'
import { EXECUTORS } from './index'
import {
  installCdpEventRouter,
  installDetachHandler,
  resetForTests as resetDebugger,
} from '../debuggerSession'
import { resetForTests as resetWorlds } from '../worlds'
import { setConfig } from '../../utils/storage'

/**
 * The extension half of the human login handoff.
 *
 * The properties with teeth here are the ones that fail SILENTLY in
 * production: an unacked frame stops the screencast three frames later with
 * no error, a PNG default costs ~67x the bytes, an ignored
 * `session_active: false` leaves a camera running on a session nobody is
 * watching, and a pointer coordinate scaled by the wrong viewport is a
 * trusted click somewhere the operator did not click.
 */

const TAB = 7
const SESSION = 'blogin_test_1'

type Fire = (tabId: number, method: string, params?: unknown) => void

/** Speak to the CDP router the way Chrome does, so the real route is under test. */
function cdpEvents(): Fire {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const route = addListener.mock.calls.at(-1)![0] as (
    source: { tabId?: number },
    method: string,
    params: unknown,
  ) => void
  return (tabId, method, params = {}) => route({ tabId }, method, params)
}

/** CDP mock that can answer the probe-world handshake and a viewport read. */
function mockCdp(viewport: { width: number; height: number } | null = { width: 1000, height: 500 }) {
  const sendCommand = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args) => {
    const method = args[1] as string
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 }
    if (method === 'Runtime.evaluate') return { result: { value: viewport } }
    return {}
  })
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

interface FramePost {
  url: string
  frames: { data: string }[]
}

/** Fetch spy that records every login-frame POST and answers with `body`. */
function mockFetch(body: { accepted?: number; session_active?: boolean } = {}) {
  const posts: FramePost[] = []
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null
  const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const parsed = JSON.parse(String(init?.body ?? '{}')) as { frames?: { data: string }[] }
    posts.push({ url, frames: parsed.frames ?? [] })
    if (gate) await gate
    return new Response(
      JSON.stringify({ accepted: body.accepted ?? parsed.frames?.length ?? 0, session_active: body.session_active ?? true, last_seq: 1 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchSpy
  return {
    posts,
    /** Hold every in-flight POST open until `release()` is called. */
    hold() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    release() {
      openGate?.()
      gate = null
    },
  }
}

function acks(cdp: ReturnType<typeof mockCdp>): unknown[] {
  return cdp.mock.calls.filter((c) => c[1] === 'Page.screencastFrameAck').map((c) => c[2])
}

function calls(cdp: ReturnType<typeof mockCdp>, method: string): unknown[] {
  return cdp.mock.calls.filter((c) => c[1] === method).map((c) => c[2])
}

beforeEach(async () => {
  resetDebugger()
  resetWorlds()
  resetLoginSessionsForTests()
  await setConfig({ baseUrl: 'http://api.test', token: 'nym_unit' })
  ;(chrome.debugger.attach as unknown) = vi.fn(async () => undefined)
  ;(chrome.debugger.detach as unknown) = vi.fn(async () => undefined)
})

afterEach(() => {
  resetLoginSessionsForTests()
})

// ---------------------------------------------------------------- starting

describe('starting a login session', () => {
  it('starts a JPEG screencast with a size cap, never the PNG default', async () => {
    const cdp = mockCdp()

    const result = await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    expect(result.ok).toBe(true)
    const started = calls(cdp, 'Page.startScreencast')[0] as Record<string, unknown>
    // Measured ~67x the bytes as PNG, which is the default if unset.
    expect(started.format).toBe('jpeg')
    expect(started.quality).toBe(60)
    expect(started.maxWidth).toBe(1280)
    expect(started.maxHeight).toBe(800)
    expect(chrome.debugger.attach).toHaveBeenCalled()
  })

  it('holds the debugger rather than borrowing it for one call', async () => {
    mockCdp()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    // A held session (refCount > 0) is what makes the capture outlive the
    // command AND survive the turn-end release that drops idle holds.
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    expect(loginSessionTabs()).toEqual([TAB])
  })

  it('refuses a second session on a tab a human is already driving', async () => {
    mockCdp()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    const second = await execLoginSessionStart({ tab_id: TAB, session_id: 'blogin_other' })

    expect(second.ok).toBe(false)
    expect(second.error).toContain(SESSION)
    expect(second.error).toContain('one person at a time')
  })

  it('leaves no session behind when the screencast cannot start', async () => {
    const cdp = mockCdp()
    cdp.mockImplementation(async (...args) => {
      if ((args[1] as string) === 'Page.startScreencast') throw new Error('nope')
      return {}
    })

    const result = await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    expect(result.ok).toBe(false)
    // The tab must be free for a retry, not stuck holding a dead session.
    expect(loginSessionTabs()).toEqual([])
  })

  it('rejects a start with no tab or no session id', async () => {
    mockCdp()
    expect((await execLoginSessionStart({ session_id: SESSION })).ok).toBe(false)
    expect((await execLoginSessionStart({ tab_id: TAB })).ok).toBe(false)
  })
})

// ----------------------------------------------------------------- frames

describe('screencast frames', () => {
  it('acks every single frame', async () => {
    // The one that fails silently: Chrome allows three frames in flight and
    // then simply stops, which is indistinguishable from a static page.
    const cdp = mockCdp()
    mockFetch()
    const fire = cdpEvents()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    for (let n = 1; n <= 5; n += 1) {
      fire(TAB, 'Page.screencastFrame', { data: `frame-${n}`, sessionId: n })
    }
    await vi.waitFor(() => expect(acks(cdp)).toHaveLength(5))

    expect(acks(cdp)).toEqual([
      { sessionId: 1 },
      { sessionId: 2 },
      { sessionId: 3 },
      { sessionId: 4 },
      { sessionId: 5 },
    ])
  })

  it('POSTs frames to the login endpoint, not the command channel', async () => {
    mockCdp()
    const http = mockFetch()
    const fire = cdpEvents()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    fire(TAB, 'Page.screencastFrame', { data: 'pixels', sessionId: 1 })
    await vi.waitFor(() => expect(http.posts).toHaveLength(1))

    expect(http.posts[0].url).toBe(`http://api.test/browser-login/${SESSION}/frame`)
    expect(http.posts[0].frames).toEqual([{ data: 'pixels', metadata: undefined }])
    // Never the command-result route: a frame answers no command.
    expect(http.posts.some((p) => p.url.includes('/browser-commands/'))).toBe(false)
  })

  it('coalesces frames that arrive while a POST is in flight', async () => {
    // Adaptive batching: no timer, one POST in flight, and whatever piled up
    // goes together next. A fast link sends one frame per POST; a slow one
    // batches on its own.
    mockCdp()
    const http = mockFetch()
    const fire = cdpEvents()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    http.hold()
    fire(TAB, 'Page.screencastFrame', { data: 'a', sessionId: 1 })
    await vi.waitFor(() => expect(http.posts).toHaveLength(1))
    fire(TAB, 'Page.screencastFrame', { data: 'b', sessionId: 2 })
    fire(TAB, 'Page.screencastFrame', { data: 'c', sessionId: 3 })
    expect(http.posts).toHaveLength(1)
    http.release()

    await vi.waitFor(() => expect(http.posts).toHaveLength(2))
    expect(http.posts[0].frames.map((f) => f.data)).toEqual(['a'])
    expect(http.posts[1].frames.map((f) => f.data)).toEqual(['b', 'c'])
  })

  it('drops the oldest frames when the uplink stalls', async () => {
    mockCdp()
    const http = mockFetch()
    const fire = cdpEvents()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    http.hold()
    const total = MAX_QUEUED_FRAMES + 4
    for (let n = 1; n <= total; n += 1) {
      fire(TAB, 'Page.screencastFrame', { data: `f${n}`, sessionId: n })
    }
    await vi.waitFor(() => expect(http.posts).toHaveLength(1))
    http.release()
    // The newest frame always survives: it shows everything the dropped
    // ones did, so waiting for it is waiting for the queue to drain.
    const sentSoFar = () => http.posts.flatMap((p) => p.frames.map((f) => f.data))
    await vi.waitFor(() => expect(sentSoFar()).toContain(`f${total}`))

    // And the oldest did NOT survive, which is what bounds memory.
    expect(sentSoFar().length).toBeLessThan(total)
    expect(sentSoFar()).not.toContain('f2')
  })

  it('stops capturing when the backend says the session is over', async () => {
    // The ONLY downward signal for an ending the extension never heard
    // (Done, the time limit, a thread abort).
    const cdp = mockCdp()
    mockFetch({ session_active: false })
    const fire = cdpEvents()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    fire(TAB, 'Page.screencastFrame', { data: 'pixels', sessionId: 1 })
    await vi.waitFor(() => expect(calls(cdp, 'Page.stopScreencast')).toHaveLength(1))

    expect(loginSessionTabs()).toEqual([])
  })

  it('ignores frames for a tab with no login session', async () => {
    const cdp = mockCdp()
    const http = mockFetch()
    const fire = cdpEvents()

    fire(99, 'Page.screencastFrame', { data: 'stray', sessionId: 1 })

    expect(acks(cdp)).toEqual([])
    expect(http.posts).toEqual([])
  })
})

// ------------------------------------------------------------------ input

describe('replaying operator input', () => {
  it('turns a key event into a trusted keystroke with no viewport round trip', async () => {
    const cdp = mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    await handleLoginInput({
      session_id: SESSION,
      tab_id: TAB,
      events: [{ type: 'key', key: 'a' }],
    })

    const keys = calls(cdp, 'Input.dispatchKeyEvent') as Record<string, unknown>[]
    expect(keys.map((k) => k.type)).toEqual(['keyDown', 'keyUp'])
    expect(keys[0].text).toBe('a')
    // Typing must not pay for geometry it does not use.
    expect(calls(cdp, 'Runtime.evaluate')).toHaveLength(0)
  })

  it('inserts pasted text as one edit', async () => {
    const cdp = mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    await handleLoginInput({
      session_id: SESSION,
      tab_id: TAB,
      events: [{ type: 'text', text: 'hunter2' }],
    })

    expect(calls(cdp, 'Input.insertText')).toEqual([{ text: 'hunter2' }])
  })

  it('scales normalized coordinates by the tab live viewport', async () => {
    // The conversion the whole pointer path rests on: the frame and
    // innerWidth/innerHeight describe the same rectangle, so a fraction
    // converts between them with no ratio a zoom or resize can invalidate.
    const cdp = mockCdp({ width: 1000, height: 500 })
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    await handleLoginInput({
      session_id: SESSION,
      tab_id: TAB,
      events: [{ type: 'mouse', action: 'click', x: 0.5, y: 0.2, button: 'left' }],
    })

    const mouse = calls(cdp, 'Input.dispatchMouseEvent') as Record<string, unknown>[]
    const pressed = mouse.find((m) => m.type === 'mousePressed')
    expect(pressed?.x).toBe(500)
    expect(pressed?.y).toBe(100)
  })

  it('drops a pointer event rather than guess where an unreadable viewport is', async () => {
    // A mis-aimed trusted click on a login page can submit or navigate, so
    // "no honest coordinate" has to mean "no click".
    const cdp = mockCdp(null)
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    await handleLoginInput({
      session_id: SESSION,
      tab_id: TAB,
      events: [{ type: 'mouse', action: 'click', x: 0.5, y: 0.5 }],
    })

    expect(calls(cdp, 'Input.dispatchMouseEvent')).toEqual([])
  })

  it('scrolls with a trusted wheel at the scaled point', async () => {
    const cdp = mockCdp({ width: 800, height: 600 })
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    await handleLoginInput({
      session_id: SESSION,
      tab_id: TAB,
      events: [{ type: 'wheel', x: 0.25, y: 0.5, delta_y: 120 }],
    })

    const wheel = (calls(cdp, 'Input.dispatchMouseEvent') as Record<string, unknown>[]).find(
      (m) => m.type === 'mouseWheel',
    )
    expect(wheel?.x).toBe(200)
    expect(wheel?.y).toBe(300)
    expect(wheel?.deltaY).toBe(120)
  })

  it('ignores input for a session this worker does not have', async () => {
    const cdp = mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    await handleLoginInput({
      session_id: 'blogin_someone_else',
      tab_id: TAB,
      events: [{ type: 'key', key: 'a' }],
    })

    expect(calls(cdp, 'Input.dispatchKeyEvent')).toEqual([])
  })

  it('keeps replaying a batch after one event fails', async () => {
    const cdp = mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })
    let firstKey = true
    cdp.mockImplementation(async (...args) => {
      if ((args[1] as string) === 'Input.dispatchKeyEvent' && firstKey) {
        firstKey = false
        throw new Error('transient')
      }
      return {}
    })

    await handleLoginInput({
      session_id: SESSION,
      tab_id: TAB,
      events: [
        { type: 'key', key: 'a' },
        { type: 'key', key: 'b' },
      ],
    })

    // The operator is mid-password: a swallowed remainder is worse than one
    // keystroke they can see did not arrive.
    const keys = calls(cdp, 'Input.dispatchKeyEvent') as Record<string, unknown>[]
    expect(keys.some((k) => k.key === 'b')).toBe(true)
  })
})

// -------------------------------------------------------------- lifecycle

describe('ending a login session', () => {
  it('stops the screencast and gives the tab back', async () => {
    const cdp = mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })

    const result = await execLoginSessionStop({ tab_id: TAB, session_id: SESSION })

    expect(result.ok).toBe(true)
    expect((result.data as { stopped?: boolean }).stopped).toBe(true)
    expect(calls(cdp, 'Page.stopScreencast')).toHaveLength(1)
    expect(loginSessionTabs()).toEqual([])
  })

  it('is idempotent, because more than one path can end a session', async () => {
    mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })
    await execLoginSessionStop({ tab_id: TAB, session_id: SESSION })

    const again = await execLoginSessionStop({ tab_id: TAB, session_id: SESSION })

    expect(again.ok).toBe(true)
    expect((again.data as { stopped?: boolean }).stopped).toBe(false)
  })

  it('stops cleanly when the tab has already gone away', async () => {
    const cdp = mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })
    cdp.mockImplementation(async () => {
      throw new Error('No tab with given id')
    })

    const result = await execLoginSessionStop({ tab_id: TAB, session_id: SESSION })

    expect(result.ok).toBe(true)
    expect(loginSessionTabs()).toEqual([])
  })

  it('ends the login session when the debugger detaches under it', async () => {
    // DevTools opening, the banner's cancel, the tab closing. Without this
    // the map keeps a dead entry and the tab can never host another login.
    mockCdp()
    mockFetch()
    await execLoginSessionStart({ tab_id: TAB, session_id: SESSION })
    // Re-bind against the current chrome mock, the same way the router is
    // re-bound: mock calls recorded at module load do not survive the reset.
    installDetachHandler()
    const onDetach = (chrome.debugger.onDetach.addListener as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.at(-1)![0] as (source: { tabId: number }, reason: string) => void

    onDetach({ tabId: TAB }, 'target_closed')
    await vi.waitFor(() => expect(loginSessionTabs()).toEqual([]))
  })
})

// ------------------------------------------------------------- registration

describe('command registration', () => {
  it('registers both control commands', () => {
    expect(EXECUTORS.login_session_start).toBeTypeOf('function')
    expect(EXECUTORS.login_session_stop).toBeTypeOf('function')
  })
})
