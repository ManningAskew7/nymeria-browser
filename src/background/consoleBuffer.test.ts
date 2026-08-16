import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installCdpEventRouter,
  resetForTests as resetDebugger,
  sendCommand,
} from './debuggerSession'
import {
  installCdpConsoleCapture,
  read,
  readSince,
  resetForTests as resetConsole,
} from './consoleBuffer'

const TAB = 1
const FRAME_SESSION = 'SESSION-ABC'
const FRAME_URL = 'https://pay.example/card'

type CdpListener = (
  source: { tabId: number; sessionId?: string },
  method: string,
  params: unknown,
) => void

/**
 * Re-bind the CDP router onto the freshly installed chrome mock and hand back
 * the listener, so these tests exercise the real event path rather than
 * poking the buffer directly.
 */
function wireCapture(): CdpListener {
  installCdpEventRouter()
  installCdpConsoleCapture()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const call = addListener.mock.calls.at(-1)
  return call?.[0] as CdpListener
}

/** Attach the tab, then announce a cross-origin frame the way Chrome does. */
async function attachFrame(emit: CdpListener): Promise<void> {
  await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
  emit({ tabId: TAB }, 'Target.attachedToTarget', {
    sessionId: FRAME_SESSION,
    targetInfo: { targetId: 'FRAME-TARGET-1', type: 'iframe', url: FRAME_URL },
  })
}

function consoleCall(emit: CdpListener, text: string, opts: { type?: string; sessionId?: string } = {}): void {
  emit({ tabId: TAB, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }, 'Runtime.consoleAPICalled', {
    type: opts.type ?? 'log',
    args: [{ type: 'string', value: text }],
    timestamp: Date.now(),
  })
}

beforeEach(() => {
  resetDebugger()
  resetConsole()
})

describe('console capture', () => {
  it('maps console API levels and joins arguments into text', () => {
    const emit = wireCapture()
    emit({ tabId: TAB }, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [
        { type: 'string', value: 'cart total' },
        { type: 'number', value: 42 },
      ],
      timestamp: Date.now(),
    })

    const entries = read(TAB, {})
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe('warn')
    expect(entries[0].text).toBe('cart total 42')
    // Root entries must keep their pre-#177 shape: no frame key at all.
    expect('frame' in entries[0]).toBe(false)
    expect('browser' in entries[0]).toBe(false)
  })

  it('records an uncaught exception with its source location', () => {
    const emit = wireCapture()
    emit({ tabId: TAB }, 'Runtime.exceptionThrown', {
      timestamp: Date.now(),
      exceptionDetails: {
        text: 'Uncaught',
        url: 'https://example.com/app.js',
        lineNumber: 10,
        columnNumber: 3,
        exception: { type: 'object', description: 'TypeError: x is not a function' },
      },
    })

    const [entry] = read(TAB, {})
    expect(entry.level).toBe('exception')
    expect(entry.text).toBe('Uncaught: TypeError: x is not a function')
    expect(entry.source).toBe('https://example.com/app.js')
    expect(entry.line).toBe(10)
    expect(entry.col).toBe(3)
  })

  it('surfaces browser advisories from the Log domain as browser entries', () => {
    const emit = wireCapture()
    const refusal =
      "Refused to display 'https://www.iana.org/domains/example' in a frame because it set 'X-Frame-Options' to 'deny'."
    emit({ tabId: TAB }, 'Log.entryAdded', {
      entry: {
        source: 'security',
        level: 'error',
        text: refusal,
        timestamp: Date.now(),
        url: 'https://www.iana.org/domains/example',
      },
    })

    const [entry] = read(TAB, { only_errors: true })
    expect(entry.level).toBe('error')
    expect(entry.text).toBe(refusal)
    expect(entry.browser).toBe(true)
    expect(entry.source).toBe('https://www.iana.org/domains/example')
  })

  it('maps Log domain levels and filters sub-error advisories under only_errors', () => {
    const emit = wireCapture()
    emit({ tabId: TAB }, 'Log.entryAdded', {
      entry: { source: 'rendering', level: 'warning', text: 'layout advisory', timestamp: Date.now() },
    })
    emit({ tabId: TAB }, 'Log.entryAdded', {
      entry: { source: 'other', level: 'verbose', text: 'chatter', timestamp: Date.now() },
    })
    emit({ tabId: TAB }, 'Log.entryAdded', {
      entry: { source: 'network', level: 'error', text: 'blocked', timestamp: Date.now() },
    })

    const all = read(TAB, {})
    expect(all.map((e) => e.level)).toEqual(['warn', 'debug', 'error'])
    expect(read(TAB, { only_errors: true }).map((e) => e.text)).toEqual(['blocked'])
  })

  it('attributes frame-session events to the frame origin', async () => {
    const emit = wireCapture()
    await attachFrame(emit)

    consoleCall(emit, 'from the frame', { type: 'error', sessionId: FRAME_SESSION })
    emit({ tabId: TAB, sessionId: FRAME_SESSION }, 'Log.entryAdded', {
      entry: { source: 'security', level: 'error', text: 'frame refusal', timestamp: Date.now() },
    })
    consoleCall(emit, 'from the top document', { type: 'error' })

    const entries = read(TAB, { only_errors: true })
    expect(entries.map((e) => e.frame)).toEqual(['https://pay.example', 'https://pay.example', undefined])
    expect(entries[1].browser).toBe(true)
  })

  it('labels an unannounced session honestly rather than guessing', () => {
    const emit = wireCapture()
    consoleCall(emit, 'orphan', { type: 'error', sessionId: 'SESSION-NEVER-SEEN' })

    expect(read(TAB, {})[0].frame).toBe('unknown')
  })

  it('caps the per-tab buffer and drops the oldest entries first', () => {
    const emit = wireCapture()
    for (let i = 0; i < 205; i++) consoleCall(emit, `line ${i}`)

    const entries = read(TAB, {})
    expect(entries).toHaveLength(200)
    expect(entries[0].text).toBe('line 5')
    expect(entries[199].text).toBe('line 204')
  })

  it('readSince windows out entries from before the action', () => {
    const emit = wireCapture()
    emit({ tabId: TAB }, 'Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'earlier' }],
      timestamp: Date.now() - 60_000,
    })
    const actionStart = Date.now() - 100
    consoleCall(emit, 'during', { type: 'error' })

    expect(readSince(TAB, actionStart, { only_errors: true }).map((e) => e.text)).toEqual(['during'])
  })
})
