import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rendererResponsive, settle } from './settle'
import type { SettleResult } from './settle'
import { isAttached, resetForTests as resetDebugger } from './debuggerSession'

const TAB = 1

beforeEach(() => {
  resetDebugger()
})

/**
 * The failure these cover: a dialog the PAGE raised (alert/confirm/prompt/
 * "Leave site?") suspends the renderer, so every renderer-bound CDP call queues
 * behind it and returns only when the dialog is answered, which may be never.
 * Commands rode their full 30s transport timeout to discover this, and reported
 * a bare timeout that said nothing about the cause.
 *
 * Measured live 2026-08-11 against a real `alert()`.
 */
describe('rendererResponsive', () => {
  it('is true when the page answers', async () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { value: 1 } }))

    expect(await rendererResponsive(TAB)).toBe(true)
  })

  it('is false when the page never answers, rather than waiting forever', async () => {
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => new Promise<never>(() => {}))

      const pending = rendererResponsive(TAB)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await pending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not give up on a page that is merely slow', async () => {
    // The expensive mistake is a false negative: it refuses an action that was
    // about to succeed. A couple of seconds of synchronous work is ordinary on a
    // heavy page, so the deadline has to sit well clear of it.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ result: { value: 1 } }), 2_000)
          }),
      )

      const pending = rendererResponsive(TAB)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await pending).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up well before the command transport does', async () => {
    // The upper bound is the one that decides whether this does anything. The
    // tool layer kills a browser command at 30s, so a deadline near that is the
    // feature costing a round trip and buying nothing. Without this assertion a
    // 29s deadline passes every other test in the file.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => new Promise<never>(() => {}))

      let settled = false
      const pending = rendererResponsive(TAB).then((v) => {
        settled = true
        return v
      })
      await vi.advanceTimersByTimeAsync(8_000)

      expect(settled, 'must decide well inside the 30s transport timeout').toBe(true)
      expect(await pending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leave the tab attached forever', async () => {
    // The probe acquires a session so the attach is paid outside its deadline.
    // Acquiring without releasing pins the refcount above zero, and the detach
    // linger is only ever scheduled when it reaches zero, so the tab would keep
    // Chrome's "being debugged" banner up for the life of the service worker.
    // This runs on EVERY action, twice, so it is not a leak that needs an
    // unusual page to show up.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { value: 1 } }))

      await rendererResponsive(TAB)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(isAttached(TAB), 'the session must be released when the probe is done').toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a protocol error as responsive, not as a dialog', async () => {
    // A detached session or a closed target is a different failure with its own
    // honest message downstream. Reporting it as a suspended page would send the
    // agent hunting for a dialog that was never there.
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => {
      throw new Error('Detached while handling command')
    })

    expect(await rendererResponsive(TAB)).toBe(true)
  })

  it('asks the page something trivial rather than running real work', async () => {
    // The probe must not depend on the DOM, on a frame tree, or on anything a
    // hostile or half-loaded page controls: its only job is to prove the main
    // thread is turning.
    const send = vi.fn(async () => ({ result: { value: 1 } }))
    ;(chrome.debugger.sendCommand as unknown) = send

    await rendererResponsive(TAB)

    // Attaching the debugger enables its capture domains first, so count the
    // evaluates rather than the calls.
    const evaluates = send.mock.calls.filter(
      (c) => (c as unknown as [unknown, string])[1] === 'Runtime.evaluate',
    ) as unknown as [unknown, string, { expression: string }][]
    expect(evaluates).toHaveLength(1)
    expect(evaluates[0][2].expression.length).toBeLessThan(10)
  })
})

/**
 * The settle probe runs IN the page for up to maxMs, a budget the agent picks
 * via wait's timeout_ms. The transport deadline under it must therefore sit
 * above maxMs, or a healthy 20s wait is cut off at the 15s default and
 * reported as a hang.
 */
describe('settle transport deadline', () => {
  it('lets an agent-chosen wait outlive the default CDP deadline', async () => {
    vi.useFakeTimers()
    try {
      resetDebugger()
      ;(chrome.debugger.sendCommand as unknown) = vi.fn((_target: unknown, method: string) =>
        method === 'Runtime.evaluate' ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      let result: SettleResult | null = null
      void settle(TAB, { maxMs: 20_000 }).then((r) => (result = r))

      await vi.advanceTimersByTimeAsync(16_000)
      expect(result, 'a 20s wait must survive the 15s default').toBeNull()

      await vi.advanceTimersByTimeAsync(7_000) // past maxMs + slack
      expect(result).not.toBeNull()
      expect(result!.reason).toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * These EXECUTE the probe expression in happy-dom instead of matching it as
 * a string, the gap backlog #160 recorded for this exact probe ("a string no
 * test ever executes"). The mock resolves the expression's promise the way
 * `awaitPromise` does, so the MutationObserver logic that IS the settle
 * mechanism, tally included (#180), runs for real.
 */
describe('settle probe execution (#180)', () => {
  function installRunningMock(): void {
    resetDebugger()
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(
      async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
        if (method === 'Runtime.evaluate') {
          const value = (new Function(`return (${String(params.expression)})`) as () => unknown)()
          return { result: { value: params.awaitPromise ? await value : value } }
        }
        return {}
      },
    )
  }

  it('counts the mutations the page makes during the window', async () => {
    installRunningMock()

    const pending = settle(TAB, { quietMs: 40, maxMs: 2_000 })
    // Let the probe install its observer (settle's attach + evaluate are
    // async), then the page reacts: three DOM changes land while it watches.
    await new Promise((r) => setTimeout(r, 20))
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div')
      el.textContent = `reaction-${i}`
      document.body.appendChild(el)
    }
    const result = await pending

    expect(result.reason).toBe('quiet')
    expect(result.mutations).toBeGreaterThanOrEqual(1)
  })

  it('reports an honest zero when the page never reacted', async () => {
    // Zero is the STRONG signal (the phantom add-to-cart shape): it must be
    // a measured tally of a quiet window, never an omission or a default.
    installRunningMock()

    const result = await settle(TAB, { quietMs: 40, maxMs: 2_000 })

    expect(result.reason).toBe('quiet')
    expect(result.mutations).toBe(0)
  })
})
