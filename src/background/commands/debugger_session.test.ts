import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquire,
  activeTabs,
  installDetachHandler,
  isAttached,
  release,
  resetForTests,
  sendCommand,
} from '../debuggerSession'

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

/**
 * `chrome.debugger.sendCommand` has no timeout, and a discarded or frozen tab
 * never answers, so an unbounded await never settled and held the MV3 worker
 * toward its 5-minute kill (backlog #165: C-02, L-01). Every call is bounded
 * now, an external detach fails in-flight calls immediately, and a tab whose
 * renderer is not running is refused before attach with the remedy named.
 */
describe('CDP call deadlines', () => {
  const hangCdp = () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(() => new Promise<never>(() => {}))
  }
  type MutableTab = { id: number; discarded?: boolean; frozen?: boolean; status?: string }
  const mockTabs = () => (chrome.tabs as unknown as { _tabs: MutableTab[] })._tabs

  it('rejects a call Chrome never answers, naming the method, and frees the session', async () => {
    hangCdp()
    const p = sendCommand(1, 'Test.method')
    const seen = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(15_100)
    const err = await seen
    expect(String(err)).toMatch(/did not answer Test\.method/)
    // Effect must stay hedged (the call may have landed), and the remedies
    // must match the pre-flight's: reload for discarded/frozen, close for
    // the rest.
    expect(String(err)).toMatch(/whether the call took effect is unknown/i)
    expect(String(err)).toMatch(/reload recovers a discarded or frozen tab/i)
    // The refcount was released at the deadline, so the detach linger runs:
    // an abandoned call must not pin the debugger banner forever.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
    expect(isAttached(1)).toBe(false)
  })

  it('honours a caller-supplied deadline above the default', async () => {
    hangCdp()
    let settled = false
    const p = sendCommand(1, 'Slow.method', {}, { deadlineMs: 30_000 })
    p.then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.advanceTimersByTimeAsync(16_000)
    expect(settled, 'must outlive the 15s default').toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(settled).toBe(true)
    await expect(p).rejects.toThrow(/within 30s/)
  })

  it('fails in-flight calls the moment Chrome detaches externally', async () => {
    hangCdp()
    installDetachHandler()
    const addListener = chrome.debugger.onDetach.addListener as ReturnType<typeof vi.fn>
    const listener = addListener.mock.calls.at(-1)?.[0] as (
      source: { tabId?: number },
      reason: string,
    ) => void
    const p = sendCommand(1, 'Test.method')
    const seen = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000) // well inside every deadline
    listener({ tabId: 1 }, 'target_closed')
    const err = await seen
    expect(String(err)).toMatch(/detached the debugger/i)
    // Chrome names why; the message must carry that name, not guess.
    expect(String(err)).toMatch(/went away/i)
    expect(isAttached(1)).toBe(false)
  })

  it('refuses a discarded tab before attaching, naming the reload remedy', async () => {
    mockTabs().push({ id: 55, discarded: true })
    await expect(sendCommand(55, 'Runtime.evaluate')).rejects.toThrow(
      /discarded[\s\S]*chrome_tabs\(action="reload", tab_id=55\)/,
    )
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('does NOT refuse a frozen tab: attach may unfreeze it, and a false refusal is the expensive mistake', async () => {
    mockTabs().push({ id: 56, frozen: true, status: 'complete' })
    const result = await sendCommand(56, 'Runtime.evaluate')
    expect(result).toEqual({})
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
  })

  it('rolls the refcount back on a refusal, so a later session still detaches', async () => {
    const tabs = mockTabs()
    tabs.push({ id: 57, discarded: true })
    await expect(acquire(57)).rejects.toThrow(/discarded/)
    // The tab comes back (the user or a reload restored it): a normal
    // acquire/release cycle must reach zero and detach, which it cannot if
    // the refused acquire stranded a count.
    tabs.find((t) => t.id === 57)!.discarded = false
    await acquire(57)
    release(57)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('shares one attach between concurrent cold acquires', async () => {
    // Two racers used to BOTH call chrome.debugger.attach, and the loser's
    // "already attached" rejection failed a command that should have ridden
    // the winner's session. Concurrent same-tab commands in one assistant
    // turn are routine (a batch), so this is a live path.
    let resolveAttach: () => void = () => {}
    ;(chrome.debugger.attach as unknown) = vi.fn(
      () => new Promise<void>((resolve) => (resolveAttach = resolve)),
    )
    const a = acquire(7)
    const b = acquire(7)
    await vi.advanceTimersByTimeAsync(0)
    resolveAttach()
    await Promise.all([a, b])
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect(isAttached(7)).toBe(true)
    release(7)
    release(7)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('an acquire during an in-flight detach waits it out and starts a fresh session', async () => {
    // Joining the dying entry left the caller holding a ref to a session
    // deleted underneath it: isAttached() went false while it believed
    // otherwise, and its next command got "Debugger is not attached".
    let resolveDetach: () => void = () => {}
    ;(chrome.debugger.detach as unknown) = vi.fn(
      () => new Promise<void>((resolve) => (resolveDetach = resolve)),
    )
    await acquire(8)
    release(8)
    await vi.advanceTimersByTimeAsync(10_100) // linger expires, detach starts and hangs
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)

    const late = acquire(8) // must wait the detach out, then cold-attach
    await vi.advanceTimersByTimeAsync(0)
    resolveDetach()
    await late
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
    expect(isAttached(8)).toBe(true)
    const result = await sendCommand(8, 'Runtime.evaluate')
    expect(result).toEqual({})
  })

  it('cleans the bookkeeping even when Chrome never answers the detach', async () => {
    ;(chrome.debugger.detach as unknown) = vi.fn(() => new Promise<never>(() => {}))
    await acquire(9)
    release(9)
    await vi.advanceTimersByTimeAsync(10_100) // linger expires, detach hangs
    await vi.advanceTimersByTimeAsync(5_100) // detach deadline gives up on it
    expect(isAttached(9)).toBe(false)
    // A fresh session must start cold, not ride the dead entry.
    await acquire(9)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
  })
})
