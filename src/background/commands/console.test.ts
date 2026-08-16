import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execConsole } from './console'
import {
  installCdpEventRouter,
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
