import { acquire, sendCommand } from './debuggerSession'

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

/**
 * How long the renderer gets to answer a trivial expression before we call the
 * page suspended.
 *
 * Generous on purpose. On a healthy page the probe returns in single-digit
 * milliseconds, so the deadline costs nothing there and is only ever paid by a
 * page that is genuinely stuck. A page doing a couple of seconds of synchronous
 * work is not rare, and calling it suspended would refuse an action that was
 * about to succeed, which is the expensive mistake here.
 *
 * Deliberately a single attempt, not a retry loop: a retried evaluate queues
 * behind the same blocked main thread, so two attempts at N ms decide exactly
 * what one attempt at 2N ms decides, while leaving a second abandoned call
 * behind.
 */
const RESPONSIVE_DEADLINE_MS = 4_000

/** Resolve `work`, or report a timeout, whichever comes first. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * Is this tab's renderer running script at all?
 *
 * A dialog the PAGE raised (alert/confirm/prompt/beforeunload) suspends the
 * renderer, and EVERY renderer-bound CDP call then queues behind it:
 * `Runtime.evaluate`, `DOM.resolveNode`, the settle probe above, whose own
 * deadline is in-page and therefore never ticks. A command against such a tab
 * used to ride its full transport timeout and come back with a bare failure,
 * which is both slow and uninformative.
 *
 * One trivial evaluate, raced against a wall-clock deadline. It belongs here
 * rather than inside the delivery probe because it is a PRE-condition about the
 * page, not a verdict about an action: `navigate`, `snapshot` and the text
 * readers hit the same wall, and tying it to the delivery counter would scope
 * it to the handful of verbs that happen to have probeable events.
 *
 * A false is NOT proof of a dialog: a long-running script blocks identically
 * and then finishes. Callers must name both causes and assert neither.
 *
 * Errors count as responsive. A rejected evaluate (target closed, detached
 * session) is a different failure with its own honest message downstream, and
 * reporting it as a dialog would send the agent hunting for one.
 */
export async function rendererResponsive(
  tabId: number,
  ms: number = RESPONSIVE_DEADLINE_MS,
): Promise<boolean> {
  // Attach FIRST, outside the budget. A cold attach also enables the capture
  // domains, and on a loaded machine that is not free; spending it inside the
  // deadline would let a slow attach read as a suspended page and refuse a
  // healthy action. Attaching does not need the renderer, so it cannot hang on
  // the condition being measured.
  try {
    await acquire(tabId)
  } catch {
    // Nothing to measure without a session. Downstream calls will fail with
    // their own honest error rather than being blamed on a dialog.
    return true
  }

  const probe = sendCommand(tabId, 'Runtime.evaluate', {
    expression: '1',
    returnByValue: true,
  }).then(
    () => true,
    () => true,
  )
  return (await withDeadline(probe, ms)) === true
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
