import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchBrowserCommand, EXECUTORS, setDispatchHooks } from './index'
import { BUDGET_RESERVE_MS } from '../budget'
import { standingDialog } from '../dialogs'
import { resetForTests as resetRefs, resolve as resolveRef } from '../snapshotRefs'
import { setConfig } from '../../utils/storage'
import type { BrowserCommandEvent } from '../../shared/types'

// Stubbed so a test can INJECT an owned standing dialog; the event plumbing
// behind the real implementation has its own tests in dialogs.test.ts.
vi.mock('../dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogs')>()
  return { ...actual, standingDialog: vi.fn(actual.standingDialog) }
})

beforeEach(async () => {
  await setConfig({ baseUrl: 'http://api.test', token: 'nym_unit' })
  setDispatchHooks({})
  // The ref store memoizes its hydration per worker life; without a reset it
  // would carry one test's storage view (and cache) into the next.
  resetRefs()
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

  it('waits for ref hydration before any executor runs (#179)', async () => {
    // Fresh-worker shape: storage.session holds a persisted map, module
    // memory holds nothing. The stubbed executor resolves a ref ITSELF, so
    // without the runSingle gate it would race hydration and see an empty
    // map (`act` is used because it has no page-reading pre-flight).
    await chrome.storage.session.set({
      'nymRefs:1': {
        url: 'https://example.com',
        refs: { e1: { backendNodeId: 100, role: 'button', name: 'Pay' } },
      },
      'nymRefCounter:1': 1,
    })
    resetRefs()

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ received: true, delivered: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const original = EXECUTORS.act
    ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).act = async () => {
      const resolution = resolveRef(1, '@e1', 'https://example.com')
      return {
        ok: resolution.ok,
        status: resolution.ok ? 'success' : 'error',
        data: resolution,
      }
    }
    try {
      await dispatchBrowserCommand({
        type: 'browser_command',
        command_id: 'bcmd_hydrate_1',
        command_type: 'act',
        args: { tab_id: 1, action: 'click', ref: '@e1' },
        timeout_seconds: 30,
      })
    } finally {
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>).act = original
    }

    const calls = fetchSpy.mock.calls as unknown as Array<[URL | string, RequestInit]>
    const body = JSON.parse(String(calls[0][1].body))
    expect(body.ok).toBe(true)
    expect(body.data.backendNodeId).toBe(100)
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

  it.each(['snapshot', 'extract_text', 'screenshot'])(
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

  it.each(['navigate', 'tabs', 'console', 'network'])(
    'does not pre-flight %s, which still works on a suspended tab',
    async (type) => {
      // Gating these would break the recovery: navigating away is how a
      // browser dialog is cleared, and the buffer readers are the diagnostics
      // an agent reaches for once a tab goes quiet. `screenshot` used to be
      // here on the compositor theory; measured live 2026-08-12, capture
      // hangs on a dialog-suspended tab like every other renderer-bound
      // call, so it is gated with the readers now.
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

describe('page_loading stamp on reads', () => {
  const healthyRenderer = () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { value: 1 } }))
  }

  const runStamped = async (type: string, executor: () => Promise<unknown>, tabStatus: string) => {
    const results: unknown[] = []
    setDispatchHooks({ onResult: (_e: unknown, r: unknown) => results.push(r) })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    healthyRenderer()
    ;(chrome.tabs.get as unknown) = vi.fn(async () => ({ id: 1, url: 'https://x.test/', status: tabStatus }))

    const original = EXECUTORS[type as keyof typeof EXECUTORS]
    ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>)[type] = vi.fn(executor)
    try {
      await dispatchBrowserCommand({
        type: 'browser_command',
        command_id: `bcmd_stamp_${type}`,
        command_type: type,
        args: { tab_id: 1 },
        timeout_seconds: 30,
      } as BrowserCommandEvent)
    } finally {
      ;(EXECUTORS as Record<string, (a: unknown) => Promise<unknown>>)[type] = original
    }
    return results[0] as { ok: boolean; data?: Record<string, unknown> }
  }

  const success = async () => ({ ok: true, status: 'success', data: { tree: 'ok' } })

  it('stamps a read captured while the tab was still loading', async () => {
    // A mid-load read returns whatever had committed; without the stamp a
    // sparse tree is indistinguishable from a sparse page (#160, the
    // create-then-read residue: any load our own commands did not initiate).
    const result = await runStamped('snapshot', success, 'loading')
    expect(result.ok).toBe(true)
    expect(result.data?.page_loading).toBe(true)
    expect(result.data?.tree, 'the stamp joins the payload, never replaces it').toBe('ok')
  })

  it('does not stamp a read against a settled tab', async () => {
    const result = await runStamped('snapshot', success, 'complete')
    expect(result.ok).toBe(true)
    expect(result.data && 'page_loading' in result.data).toBe(false)
  })

  it('does not stamp a non-reader command, whatever the tab is doing', async () => {
    const result = await runStamped('act', success, 'loading')
    expect(result.ok).toBe(true)
    expect(result.data && 'page_loading' in result.data).toBe(false)
  })

  it('leaves a failed read untouched', async () => {
    const failure = async () => ({ ok: false, status: 'error', error: 'boom', data: { partial: true } })
    const result = await runStamped('extract_text', failure, 'loading')
    expect(result.ok).toBe(false)
    expect(result.data && 'page_loading' in result.data).toBe(false)
  })
})

describe('owned-dialog pre-flight naming (#169)', () => {
  it('names the standing dialog and its answer route instead of the two-cause guess', async () => {
    vi.useFakeTimers()
    try {
      // The renderer IS suspended, but the cause is known by name: the named
      // message must win over the generic suspended-page guess, and no
      // liveness probe should even be spent.
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => new Promise<never>(() => {}))
      vi.mocked(standingDialog).mockReturnValueOnce({
        type: 'confirm',
        message: 'Delete this item?',
        url: 'https://example.com',
        openedAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
      })

      const results: unknown[] = []
      setDispatchHooks({ onResult: (_e: unknown, r: unknown) => results.push(r) })
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
        new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch
      const pending = dispatchBrowserCommand({
        type: 'browser_command',
        command_id: 'bcmd_dialog_named',
        command_type: 'snapshot',
        args: { tab_id: 1 },
        timeout_seconds: 30,
      } as BrowserCommandEvent)
      await vi.advanceTimersByTimeAsync(30_000)
      await pending
      const result = results[0] as { ok: boolean; error?: string }

      expect(result.ok).toBe(false)
      const error = String(result.error)
      expect(error).toMatch(/confirm dialog: "Delete this item\?"/)
      expect(error).toMatch(/chrome_dialog\(tab_id=1/)
      expect(error).toMatch(/dismissed automatically/)
      expect(error, 'the generic guess must not leak in beside the named cause').not.toMatch(
        /long-running script/i,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('command budget derivation (#162)', () => {
  const stubFetch = () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ received: true, delivered: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
  }

  const runWithTimeout = async (timeoutSeconds: number) => {
    stubFetch()
    const ctxSeen: unknown[] = []
    const original = EXECUTORS.act
    ;(EXECUTORS as Record<string, (a: unknown, c?: unknown) => Promise<unknown>>).act = vi.fn(
      async (_a: unknown, ctx?: unknown) => {
        ctxSeen.push(ctx)
        return { ok: true, status: 'success', data: {} }
      },
    )
    try {
      await dispatchBrowserCommand({
        type: 'browser_command',
        command_id: 'bcmd_budget',
        command_type: 'act',
        args: { tab_id: 1, action: 'key', value: 'End' },
        timeout_seconds: timeoutSeconds,
      } as BrowserCommandEvent)
    } finally {
      ;(EXECUTORS as Record<string, unknown>).act = original
    }
    return ctxSeen[0] as { deadline: number; budgetMs: number } | undefined
  }

  it('hands the executor a deadline: the wire budget minus the result reserve', async () => {
    // The reserve is the feature: an executor that ran to the full wire
    // budget would finish exactly when the backend stops listening, and the
    // honest payload would arrive as delivered=false.
    const before = Date.now()
    const ctx = await runWithTimeout(30)

    expect(ctx).toBeDefined()
    expect(ctx!.budgetMs).toBe(30_000)
    expect(ctx!.deadline).toBeGreaterThanOrEqual(before + 30_000 - BUDGET_RESERVE_MS)
    expect(ctx!.deadline).toBeLessThanOrEqual(Date.now() + 30_000 - BUDGET_RESERVE_MS)
  })

  it('no wire budget means no context at all: enforcement stays off', async () => {
    // One encoding (budget.ts): a command either has a budget or has no ctx.
    // A ctx full of nulls was the second spelling whose dead fallback
    // branches the first review round flagged.
    const ctx = await runWithTimeout(0)

    expect(ctx).toBeUndefined()
  })

  it('a tiny wire budget keeps a working floor instead of arriving spent', async () => {
    const before = Date.now()
    const ctx = await runWithTimeout(2)

    expect(ctx!.deadline).toBeGreaterThanOrEqual(before + 1_000)
  })
})
