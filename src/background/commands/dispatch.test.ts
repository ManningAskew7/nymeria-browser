import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchBrowserCommand, EXECUTORS, setDispatchHooks } from './index'
import { setConfig } from '../../utils/storage'
import type { BrowserCommandEvent } from '../../shared/types'

beforeEach(async () => {
  await setConfig({ baseUrl: 'http://api.test', token: 'nym_unit' })
  setDispatchHooks({})
})

describe('dispatchBrowserCommand', () => {
  it('routes to the matching executor and POSTs the result', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ received: true, delivered: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const event: BrowserCommandEvent = {
      type: 'browser_command',
      command_id: 'bcmd_unit_1',
      command_type: 'navigate',
      args: { tab_id: 1, url: 'https://example.com' },
      timeout_seconds: 30,
    }

    // Stub the navigate executor to a fast success.
    const original = EXECUTORS.navigate
    ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).navigate = vi.fn(async () => ({
      ok: true,
      status: 'success',
      data: { final_url: 'https://example.com' },
    }))
    try {
      await dispatchBrowserCommand(event)
    } finally {
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).navigate = original
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calls = fetchSpy.mock.calls as unknown as Array<[URL | string, RequestInit]>
    const [calledUrl, init] = calls[0]
    expect(String(calledUrl)).toContain('/browser-commands/bcmd_unit_1/result')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.ok).toBe(true)
    expect(body.status).toBe('success')
    expect(body.data.final_url).toBe('https://example.com')
  })

  it('catches executor exceptions and POSTs ok:false', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ received: true, delivered: true }), { status: 200 }),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const original = EXECUTORS.snapshot
    ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).snapshot = async () => {
      throw new Error('boom')
    }
    try {
      await dispatchBrowserCommand({
        type: 'browser_command',
        command_id: 'bcmd_unit_2',
        command_type: 'snapshot',
        args: { tab_id: 1 },
        timeout_seconds: 15,
      })
    } finally {
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).snapshot = original
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calls = fetchSpy.mock.calls as unknown as Array<[URL | string, RequestInit]>
    const init = calls[0][1]
    const body = JSON.parse(String(init.body))
    expect(body.ok).toBe(false)
    expect(body.status).toBe('error')
    expect(body.error).toMatch(/boom/)
  })

  it('rejects unknown command_type with ok:false', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ received: true, delivered: true }), { status: 200 }),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    await dispatchBrowserCommand({
      type: 'browser_command',
      command_id: 'bcmd_unit_3',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      command_type: 'totally_made_up' as any,
      args: {},
      timeout_seconds: 5,
    })

    const calls = fetchSpy.mock.calls as unknown as Array<[URL | string, RequestInit]>
    const init = calls[0][1]
    const body = JSON.parse(String(init.body))
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/unknown command_type/)
  })

  it('hooks fire with onResult', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ received: true, delivered: true }), { status: 200 }),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const onResult = vi.fn()
    setDispatchHooks({ onResult })

    const original = EXECUTORS.tabs
    ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).tabs = async () => ({
      ok: true,
      status: 'success',
      data: { tabs: [] },
    })
    try {
      await dispatchBrowserCommand({
        type: 'browser_command',
        command_id: 'bcmd_unit_4',
        command_type: 'tabs',
        args: { action: 'list' },
        timeout_seconds: 5,
      })
    } finally {
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).tabs = original
    }

    expect(onResult).toHaveBeenCalledTimes(1)
    const [event, result] = onResult.mock.calls[0]
    expect(event.command_type).toBe('tabs')
    expect(result.ok).toBe(true)
  })
})
