import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execConsole } from './console'
import {
  installCdpEventRouter,
  installDetachHandler,
  resetForTests as resetDebugger,
  sendCommand,
} from '../debuggerSession'
import { installCdpConsoleCapture, resetForTests as resetConsole } from '../consoleBuffer'

const TAB = 1

type CdpListener = (
  source: { tabId: number; sessionId?: string },
  method: string,
  params: unknown,
) => void

function wireCapture(): CdpListener {
  installCdpEventRouter()
  installCdpConsoleCapture()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  return addListener.mock.calls.at(-1)?.[0] as CdpListener
}

function consoleEvent(emit: CdpListener, text: string): void {
  emit({ tabId: TAB }, 'Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ type: 'string', value: text }],
    timestamp: Date.now(),
  })
}

beforeEach(() => {
  resetDebugger()
  resetConsole()
})

describe('execConsole cold-attach settle', () => {
  it('includes the enable backlog on the first read that cold-attaches the tab', async () => {
    const emit = wireCapture()
    // Simulate the replay: entries that only arrive shortly AFTER the
    // attach, the way Runtime/Log deliver their backlog on enable. A read
    // without the settle returns before they land and reports empty.
    const pending = execConsole({ tab_id: TAB, only_errors: false })
    setTimeout(() => consoleEvent(emit, 'replayed backlog line'), 50)
    const result = await pending

    const data = result.data as { entries: { text: string }[]; count: number }
    expect(data.count).toBe(1)
    expect(data.entries[0].text).toBe('replayed backlog line')
  })

  it('does not wait when the tab is already attached', async () => {
    const emit = wireCapture()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    consoleEvent(emit, 'already buffered')

    const started = Date.now()
    const result = await execConsole({ tab_id: TAB, only_errors: false })
    const elapsed = Date.now() - started

    const data = result.data as { entries: { text: string }[] }
    expect(data.entries.map((e) => e.text)).toEqual(['already buffered'])
    // Warm path is a refcount bump, not a settle window.
    expect(elapsed).toBeLessThan(350)
  })
})

describe('execConsole capture honesty (#183 rider)', () => {
  // Network got the started-now/resumed split in v0.9.0 and console did not,
  // while its silence had the identical ambiguity: an empty list on a cold
  // read said nothing about the page. The shared sampler closes that.

  function flags(result: { data?: unknown }) {
    return result.data as {
      count: number
      capture_started_now?: boolean
      capture_resumed?: boolean
      capture_gap_ms?: number
    }
  }

  function detachTab(): void {
    installDetachHandler()
    const addListener = chrome.debugger.onDetach.addListener as unknown as ReturnType<typeof vi.fn>
    const listener = addListener.mock.calls.at(-1)?.[0] as (
      source: { tabId: number },
      reason: string,
    ) => void
    listener({ tabId: TAB }, 'canceled_by_user')
  }

  it('says capture just started on the read that cold-attaches the tab', async () => {
    wireCapture()

    const data = flags(await execConsole({ tab_id: TAB, only_errors: false }))

    expect(data.capture_started_now).toBe(true)
    expect(data.capture_resumed).toBeUndefined()
  })

  it('says capture lapsed, and for how long, after a detach', async () => {
    const emit = wireCapture()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    consoleEvent(emit, 'before the lapse')
    detachTab()

    const data = flags(await execConsole({ tab_id: TAB, only_errors: false }))

    expect(data.count).toBe(1)
    expect(data.capture_resumed).toBe(true)
    expect(data.capture_started_now).toBeUndefined()
    expect(typeof data.capture_gap_ms).toBe('number')
  })

  it('hedges nothing on a warm read', async () => {
    const emit = wireCapture()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    consoleEvent(emit, 'warm')

    const data = flags(await execConsole({ tab_id: TAB, only_errors: false }))

    expect(data.capture_started_now).toBeUndefined()
    expect(data.capture_resumed).toBeUndefined()
    expect(data.capture_gap_ms).toBeUndefined()
  })
})
