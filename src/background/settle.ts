import { acquire, release, sendCommand } from './debuggerSession'

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
  /**
   * MutationObserver records seen during the settle window (#180): the
   * observer was already watching for quiescence and throwing the tally
   * away, while "did the page visibly react AT ALL" is exactly what an
   * act's verification lacks (the measured phantom add-to-cart carried
   * every per-field truth and no page reaction). ZERO is the strong
   * signal, a page that did nothing observable; nonzero is weak, since
   * dynamic pages mutate constantly. Root document, main world (a page
   * faking its own mutation count only fails itself, the settle probe's
   * standing decision); absent when the probe never ran (`navigated`,
   * `unavailable`).
   */
  mutations?: number
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
  // Resolves { s: reason, m: mutation-record count }: the observer was
  // already watching, and the tally is the payload's "did the page react
  // at all" fact (#180; see SettleResult.mutations).
  return `new Promise((resolve) => {
    try {
      const quietMs = ${quietMs};
      const deadline = Date.now() + ${maxMs};
      let last = Date.now();
      let muts = 0;
      const obs = new MutationObserver((records) => { last = Date.now(); muts += records.length; });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => {
        const now = Date.now();
        if (document.readyState === 'complete' && now - last >= quietMs) {
          obs.disconnect();
          resolve({ s: 'quiet', m: muts });
          return;
        }
        if (now >= deadline) {
          obs.disconnect();
          resolve({ s: 'deadline', m: muts });
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    } catch (e) {
      resolve({ s: 'unavailable' });
    }
  })`
}

/**
 * How long any command that triggers a page load waits for it.
 *
 * Shared so `navigate`, `tabs create` and `tabs reload` cannot drift, and
 * because the BACKEND's transport budget for those commands must exceed this
 * number across a repo boundary (`chrome_browser.py::_TIMEOUTS`). Raise it
 * here and the backend starts returning bare transport timeouts instead of
 * these commands' honest `complete: false`.
 */
export const TAB_LOAD_WAIT_MS = 25_000

/**
 * Watch for the NEXT completed load, without the already-complete early-out.
 *
 * `waitForTabComplete` short-circuits when the tab currently reads `complete`,
 * which is right when you are waiting on a load already in flight and wrong
 * when you are about to START one: at the instant `chrome.tabs.reload()`
 * resolves, the OLD document still reads `complete`, so the early-out fires
 * and the wait returns true having waited for nothing.
 *
 * The listener is attached synchronously here so the caller can arm it BEFORE
 * triggering the load, which is what removes the race rather than narrowing
 * it: no completion can land in the gap between trigger and listen.
 */
export function watchForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
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

/** Wait for the tab's own load to complete, bounded. Used after a navigation. */
export async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  const existing = await chrome.tabs.get(tabId).catch(() => null)
  if (existing?.status === 'complete') return true
  return watchForTabComplete(tabId, timeoutMs)
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

/**
 * The same probe, given longer, for a READ.
 *
 * `RESPONSIVE_DEADLINE_MS` is tuned for `act`, where refusing early is cheap
 * because nothing has mutated. For a read the trade inverts: reads are
 * idempotent and their transport budgets are 15-20s, so failing a page that is
 * five seconds into synchronous hydration would turn a slow success into a
 * hard failure that tells the agent to close the tab. Long enough to clear
 * that, short enough to still save most of the budget on a genuinely wedged
 * tab.
 */
export const READ_LIVENESS_DEADLINE_MS = 8_000

/** Resolve `work`, or report a timeout, whichever comes first. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
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
 * What to tell an agent whose READ could not run because the page is suspended.
 *
 * Names no command, deliberately: the agent called `chrome_read_page`,
 * `chrome_find`, `chrome_read_text` or `chrome_screenshot`, and the wire type
 * behind them ("snapshot", "extract_text") is a name it has never seen. Two of
 * those tools share one wire type, so there is nothing honest to interpolate.
 *
 * Deliberately shaped like `act`'s equivalent, and deliberately not identical:
 * nothing was dispatched here, so there is no "your input landed" half and no
 * double-submit risk, and the honest advice is different. Both name two causes
 * and assert neither, because a suspended renderer looks the same whether a
 * dialog is holding it or a script is still running.
 */
export function suspendedPageReadError(): string {
  // Reached only when NO owned dialog is recorded for the tab: the dispatch
  // pre-flight names an owned one outright (#169), so if a dialog is the
  // cause here it predates the attach and chrome_dialog genuinely cannot
  // answer it (ownership cannot be taken retroactively).
  return (
    'this read could not run: the tab did not run a script for several seconds, so ' +
    'nothing could be read from it. Two things do that. A dialog raised BEFORE ' +
    'this session touched the tab (alert, confirm, prompt, or a "Leave site?") ' +
    'suspends it until answered, and chrome_dialog cannot answer that one ' +
    '(dialogs are only answerable when raised while the extension was driving ' +
    'the tab): close the tab and redo the work in a fresh one. A long-running ' +
    'script suspends it temporarily: wait a few seconds and retry, and if the ' +
    'retry reports this again it is the dialog. Nothing was changed on the page ' +
    'either way.'
  )
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
    // Released immediately, which does NOT undo the point of acquiring here:
    // the attach and its capture-domain enables have already been paid, and
    // the 10s detach linger keeps the session warm for the probe below and
    // for the action after it. Holding the ref instead would leak it, since
    // there is no path back here to release it, and a refcount that never
    // returns to zero never schedules the detach: the tab would keep its
    // "being debugged" banner for the life of the service worker.
    release(tabId)
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
    }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: probeExpression(quietMs, maxMs),
        awaitPromise: true,
        returnByValue: true,
      },
      // This evaluate legitimately runs for up to maxMs IN the page (the
      // agent picks it, via wait's timeout_ms), so the transport deadline
      // must sit above it or a healthy long wait gets cut off as a hang. The
      // slack covers dispatch overhead; a truly suspended page still fails,
      // just maxMs+2s late instead of at the default.
      { deadlineMs: maxMs + 2_000 },
    )
    if (resp.exceptionDetails) {
      return { settled: false, reason: 'unavailable', ms: elapsed() }
    }
    const value = resp.result?.value as { s?: unknown; m?: unknown } | null | undefined
    const status = value && typeof value === 'object' ? value.s : undefined
    const reason: SettleReason =
      status === 'quiet' ? 'quiet' : status === 'deadline' ? 'deadline' : 'unavailable'
    const mutations =
      value && typeof value === 'object' && typeof value.m === 'number' ? value.m : null
    return {
      settled: reason === 'quiet',
      reason,
      ms: elapsed(),
      ...(mutations === null ? {} : { mutations }),
    }
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
