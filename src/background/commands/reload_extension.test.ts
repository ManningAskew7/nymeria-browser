import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchBrowserCommand, setDispatchHooks } from './index'
import { execReloadExtension, RELOAD_DELAY_MS } from './reload_extension'
import { setConfig } from '../../utils/storage'
import type { BrowserCommandEvent } from '../../shared/types'

/**
 * The whole contract is an ORDERING: the ack must be produced (and, at the
 * dispatch level, POSTed) before `chrome.runtime.reload()` fires, because
 * the reload kills the worker and a dead worker cannot report anything.
 */

beforeEach(async () => {
  vi.useFakeTimers()
  await setConfig({ baseUrl: 'http://api.test', token: 'nym_unit' })
  setDispatchHooks({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('execReloadExtension', () => {
  it('acks first and reloads only after the fixed delay', async () => {
    const result = await execReloadExtension()

    expect(result.ok).toBe(true)
    expect(chrome.runtime.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RELOAD_DELAY_MS - 1)
    expect(chrome.runtime.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })

  it('reports the running manifest version so the agent can verify the swap', async () => {
    const result = await execReloadExtension()

    expect((result.data as { version_before?: string }).version_before).toBe('9.9.9')
    expect((result.data as { reloading?: boolean }).reloading).toBe(true)
  })
})

describe('reload_extension through dispatch', () => {
  it('POSTs the result before the reload fires', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ received: true, delivered: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const event: BrowserCommandEvent = {
      type: 'browser_command',
      command_id: 'bcmd_reload_1',
      command_type: 'reload_extension',
      args: {},
      timeout_seconds: 10,
    }

    await dispatchBrowserCommand(event)

    // The result left the building while the reload is still pending.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calls = fetchSpy.mock.calls as unknown as Array<[URL | string, RequestInit]>
    const [calledUrl, init] = calls[0]
    expect(String(calledUrl)).toContain('/browser-commands/bcmd_reload_1/result')
    const body = JSON.parse(String(init.body))
    expect(body.ok).toBe(true)
    expect(chrome.runtime.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RELOAD_DELAY_MS)
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
  })
})
