import { sendCommand } from './debuggerSession'

/**
 * Wait for a page to stop changing after an action.
 *
 * Without this, multi-step flows race the page's own re-render: a click is
 * dispatched, the tool returns immediately, and the next snapshot reads a DOM
 * that is mid-update. Every competitor surveyed either delegates this to an
 * engine timeout or skips it entirely, which is why their multi-step flows are
 * flaky.
 *
 * The probe runs IN the page as a single `Runtime.evaluate` with
 * `awaitPromise`, so there is no polling round trip per tick and no CDP event
 * plumbing: a MutationObserver marks the last mutation, and the promise
 * resolves once the document is `complete` and has been quiet for `quietMs`,
 * or when the deadline passes.
 *
 * Network quiescence is deliberately not folded in. The Network domain IS
 * enabled per attach now, but in-flight-request counting adds a second
 * stalling condition (long-poll, streaming, telemetry beacons) for a race that
 * DOM quiet plus readyState already covers.
 */

export type SettleReason = 'quiet' | 'deadline' | 'navigated' | 'unavailable'

export interface SettleResult {
  settled: boolean
  reason: SettleReason
  ms: number
}

export const DEFAULT_QUIET_MS = 250
export const DEFAULT_MAX_MS = 5_000

/** Errors CDP reports when the context we evaluated in went away mid-flight. */
function isContextGone(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('execution context was destroyed') ||
    m.includes('inspected target navigated') ||
    m.includes('cannot find context') ||
    m.includes('target closed')
  )
}

function probeExpression(quietMs: number, maxMs: number): string {
  // Runs in the page. `Date.now()` here is page JS, not extension JS.
  return `new Promise((resolve) => {
    try {
      const quietMs = ${quietMs};
      const deadline = Date.now() + ${maxMs};
      let last = Date.now();
      const obs = new MutationObserver(() => { last = Date.now(); });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => {
        const now = Date.now();
        if (document.readyState === 'complete' && now - last >= quietMs) {
          obs.disconnect();
          resolve('quiet');
          return;
        }
        if (now >= deadline) {
          obs.disconnect();
          resolve('deadline');
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    } catch (e) {
      resolve('unavailable');
    }
  })`
}

/** Wait for the tab's own load to complete, bounded. Used after a navigation. */
export async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  const existing = await chrome.tabs.get(tabId).catch(() => null)
  if (existing?.status === 'complete') return true
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean) => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve(value)
    }
    const listener = (changedId: number, info: { status?: string }) => {
      if (changedId === tabId && info.status === 'complete') finish(true)
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

export async function settle(
  tabId: number,
  opts: { quietMs?: number; maxMs?: number } = {},
): Promise<SettleResult> {
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS
  const started = Date.now()
  const elapsed = () => Date.now() - started

  try {
    const resp = await sendCommand<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string }
    }>(tabId, 'Runtime.evaluate', {
      expression: probeExpression(quietMs, maxMs),
      awaitPromise: true,
      returnByValue: true,
    })
    if (resp.exceptionDetails) {
      return { settled: false, reason: 'unavailable', ms: elapsed() }
    }
    const value = resp.result?.value
    const reason: SettleReason =
      value === 'quiet' ? 'quiet' : value === 'deadline' ? 'deadline' : 'unavailable'
    return { settled: reason === 'quiet', reason, ms: elapsed() }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (isContextGone(message)) {
      // The action navigated the page out from under the probe. That is a
      // settle outcome, not a failure: wait for the new document instead.
      const loaded = await waitForTabComplete(tabId, Math.max(0, maxMs - elapsed()))
      return { settled: loaded, reason: 'navigated', ms: elapsed() }
    }
    return { settled: false, reason: 'unavailable', ms: elapsed() }
  }
}
