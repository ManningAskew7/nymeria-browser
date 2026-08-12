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

/**
 * The readers had no way to notice a suspended renderer, so they rode their
 * full transport budget and came back with a bare timeout. Measured live
 * 2026-08-12: a `chrome_find` against a tab held by an alert() spent 20s
 * saying nothing useful, and the agent guessed a css= selector rather than
 * learning the tab was wedged.
 */
describe('suspended-page pre-flight', () => {
  const suspendRenderer = () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => new Promise<never>(() => {}))
  }
  const healthyRenderer = () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { value: 1 } }))
  }

  const runCommand = async (type: string, args: unknown) => {
    const results: unknown[] = []
    setDispatchHooks({ onResult: (_e: unknown, r: unknown) => results.push(r) })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    const event = {
      type: 'browser_command',
      command_id: `bcmd_${type}`,
      command_type: type,
      args,
      timeout_seconds: 30,
    } as BrowserCommandEvent
    const pending = dispatchBrowserCommand(event)
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    return results[0] as { ok: boolean; error?: string }
  }

  it.each(['snapshot', 'extract_text'])(
    'fails %s fast and honestly instead of riding its transport budget',
    async (type) => {
      vi.useFakeTimers()
      try {
        suspendRenderer()
        const result = await runCommand(type, { tab_id: 1 })

        expect(result.ok).toBe(false)
        const error = String(result.error)
        expect(error).toMatch(/did not run a script/i)
        // Both causes named, neither asserted, same rule the act path follows.
        expect(error).toMatch(/dialog/i)
        expect(error).toMatch(/long-running script/i)
        // A read changes nothing, so it must not inherit act's retry warning.
        expect(error).not.toMatch(/submit twice/i)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(['navigate', 'tabs', 'console', 'network', 'screenshot'])(
    'does not pre-flight %s, which still works on a suspended tab',
    async (type) => {
      // Gating these would break the recovery: navigating away is how a
      // browser dialog is cleared, and the buffer readers are the diagnostics
      // an agent reaches for once a tab goes quiet. `screenshot` is here
      // because its image comes from the compositor, so a picture of a frozen
      // page is exactly what an agent wants and a pre-flight would discard it.
      vi.useFakeTimers()
      try {
        suspendRenderer()
        const original = EXECUTORS[type as keyof typeof EXECUTORS]
        ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>)[type] = vi.fn(async () => ({
          ok: true,
          status: 'success',
          data: {},
        }))
        try {
          const result = await runCommand(type, { tab_id: 1 })
          expect(result.ok, `${type} must not be gated by the page's liveness`).toBe(true)
        } finally {
          ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>)[type] = original
        }
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('lets a read through on a healthy page', async () => {
    vi.useFakeTimers()
    try {
      healthyRenderer()
      const original = EXECUTORS.snapshot
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).snapshot = vi.fn(async () => ({
        ok: true,
        status: 'success',
        data: { tree: 'ok' },
      }))
      try {
        const result = await runCommand('snapshot', { tab_id: 1 })
        expect(result.ok).toBe(true)
      } finally {
        ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).snapshot = original
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a read through on a page that is merely slow, where act would refuse', async () => {
    // The deadlines are tuned to different costs and must not be unified.
    // Refusing an ACT early is cheap: nothing mutated. Refusing a READ early
    // turns a slow success into a hard failure that tells the agent to close
    // the tab, and reads are idempotent with 15-20s budgets to spend. Five
    // seconds of synchronous hydration is ordinary on a heavy first paint,
    // and act's 4s deadline would fail it.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ result: { value: 1 } }), 5_000)
          }),
      )
      const original = EXECUTORS.snapshot
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).snapshot = vi.fn(async () => ({
        ok: true,
        status: 'success',
        data: { tree: 'ok' },
      }))
      try {
        const result = await runCommand('snapshot', { tab_id: 1 })
        expect(result.ok, 'a 5s hydration must not read as a wedged tab').toBe(true)
      } finally {
        ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).snapshot = original
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
