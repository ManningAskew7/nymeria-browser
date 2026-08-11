import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rendererResponsive } from './settle'
import { resetForTests as resetDebugger } from './debuggerSession'

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
