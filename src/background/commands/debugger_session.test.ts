import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquire, activeTabs, isAttached, release, resetForTests } from '../debuggerSession'

beforeEach(() => {
  vi.useFakeTimers()
  resetForTests()
  ;(chrome.debugger.attach as unknown) = vi.fn(async () => undefined)
  ;(chrome.debugger.detach as unknown) = vi.fn(async () => undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('debuggerSession ref counting', () => {
  it('attaches once and detaches after the linger window', async () => {
    await acquire(7)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect(isAttached(7)).toBe(true)
    expect(activeTabs()).toEqual([7])

    release(7)
    // detach is delayed by DETACH_LINGER_MS (10s).
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
    expect(isAttached(7)).toBe(false)
  })

  it('shares a single attach across concurrent acquires', async () => {
    await acquire(7)
    await acquire(7)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)

    release(7)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(chrome.debugger.detach).not.toHaveBeenCalled() // still one outstanding refcount

    release(7)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('cancels the detach timer when a new command arrives during the linger', async () => {
    await acquire(7)
    release(7)
    await vi.advanceTimersByTimeAsync(2_000)
    await acquire(7) // re-acquire mid-linger
    await vi.advanceTimersByTimeAsync(15_000)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1) // no re-attach
  })
})
