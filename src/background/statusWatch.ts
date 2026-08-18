/**
 * Last main-frame HTTP response per tab, observed via `webRequest` (#175).
 *
 * This is the half of navigation truth `webNavigation` cannot carry: an error
 * PAGE commits normally, so a 404, a 500, or a 401 sitting under an auth
 * prompt all read as clean successes to a lifecycle watcher. Only the network
 * layer knows the status code, and seeing it from here requires BOTH the
 * `webRequest` permission (manifest) and a host permission the user grants at
 * runtime from the popup. Deliberately a SIBLING of navWatch, not folded in:
 * navWatch's contract is "no CDP attach and no host permission", and this
 * module is exactly the part that needs one.
 *
 * When the grant is absent the listener simply never fires, so every reader
 * degrades to "no record". Consumers must treat that as UNKNOWN and omit the
 * field: an absent status is never a claim the load was fine.
 *
 * `onResponseStarted` rather than `onCompleted`: it carries the status code
 * and fires before the commit, so the record is already in place when a
 * navigation consumer reads it. Redirect hops never reach `onResponseStarted`
 * (they end at `onBeforeRedirect`), so the recorded status is the FINAL
 * response's by construction, which is the one the committed document came
 * from.
 *
 * State is in-memory and per-worker, same rationale as navWatch: consumers
 * sample within one command's lifetime, and the worker cannot recycle while a
 * command is running. A record lost to a recycle degrades to "unknown".
 */

import { sameResource } from './urlMatch'

export interface StatusRecord {
  url: string
  status: number
  at: number
}

const tabs = new Map<number, StatusRecord>()

let installed = false

/**
 * Register the listener. Called once from the worker top level (index.ts):
 * MV3 requires top-level registration so the event wakes a recycled worker.
 * The `types: ['main_frame']` filter matches the top-frame-only rule every
 * navigation payload follows.
 */
export function installStatusWatch(): void {
  if (installed) return
  installed = true
  // Guarded because this runs at worker top level: on a Chrome where the
  // `webRequest` API is unavailable or the registration itself throws, the
  // whole worker must not die with it. Every reader already degrades to
  // "no record", which is exactly the honest shape for "cannot watch".
  try {
    chrome.webRequest?.onResponseStarted?.addListener?.(
      (details) => {
        if (details.type !== 'main_frame') return
        if (typeof details.tabId !== 'number' || details.tabId < 0) return
        tabs.set(details.tabId, {
          url: details.url,
          status: details.statusCode,
          at: details.timeStamp ?? Date.now(),
        })
      },
      { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
    )
  } catch {
    // Readers see an empty map: statuses report as unknown, never as claims.
  }
}

/** Drop a closed tab's record; called from the one onRemoved block in index.ts. */
export function clearTabStatus(tabId: number): void {
  tabs.delete(tabId)
}

/**
 * The last main-frame response this tab saw, as a RECORD (url, status, at),
 * or null. For the health read, which reports it as history rather than
 * claiming it belongs to any particular navigation, so the
 * `statusForNavigation` gates deliberately do not apply here. Absence still
 * means unknown (no grant, no record yet, or a worker recycle), never OK.
 */
export function lastStatus(tabId: number): StatusRecord | null {
  return tabs.get(tabId) ?? null
}

// URL equality with the fragment ignored (shared, urlMatch.ts): a navigate
// to `/page#sec` commits with the fragment while the request that produced
// it has none, and a mismatch on that difference would throw away a correct
// record.

/**
 * The status of the response behind a navigation this command attributed to
 * itself, or null when it cannot be known.
 *
 * Two checks, both required before a status may be CLAIMED:
 * - `at >= sinceMs`: the response arrived after the command began. An older
 *   record describes the previous document.
 * - the record's url matches one of the candidate urls (the commit record and
 *   the final tab re-read), fragment ignored. A mismatch means the record
 *   describes some other load, and guessing would be the lie this module
 *   exists to remove.
 */
function statusForNavigation(
  tabId: number,
  sinceMs: number,
  candidateUrls: Array<string | null | undefined>,
): number | null {
  const record = tabs.get(tabId)
  if (!record || record.at < sinceMs) return null
  const matched = candidateUrls.some((u) => typeof u === 'string' && sameResource(record.url, u))
  return matched ? record.status : null
}

/**
 * The one status class that needs more than the number: a 401/407 means an
 * auth prompt is almost certainly showing, and Chrome discards input sent to
 * a tab under one (the SKILL.md recovery matrix's browser-dialog class), so
 * the payload says that instead of leaving the agent to click a dead tab.
 * Exported as the ONE definition of the challenge set; the health read's
 * `auth_prompt_likely` keys on it too.
 */
export function isAuthChallenge(status: number): boolean {
  return status === 401 || status === 407
}

function authHintFor(status: number): string | null {
  if (!isAuthChallenge(status)) return null
  return (
    'an authentication prompt is likely showing on this tab, and Chrome ' +
    'suppresses input sent to a tab under one. Navigate the tab somewhere ' +
    'else to clear it; do not try to click or type through it.'
  )
}

/**
 * The payload fields a navigation-shaped command spreads into its data:
 * `{}` when the status cannot be known, `{http_status}` when it can, plus
 * `{http_status_hint}` for the auth class. One producer so navigate, create
 * and reload cannot drift on the claim rules. Named `http_status`, not
 * `status`, on purpose: the wire envelope already has a `status`
 * (success/error) and act payloads have control `status` values, and a third
 * meaning under the same key was a collision waiting to be misread.
 */
export function statusPayload(
  tabId: number,
  sinceMs: number,
  candidateUrls: Array<string | null | undefined>,
): Record<string, unknown> {
  const status = statusForNavigation(tabId, sinceMs, candidateUrls)
  if (status === null) return {}
  const hint = authHintFor(status)
  return { http_status: status, ...(hint ? { http_status_hint: hint } : {}) }
}

export function resetForTests(): void {
  tabs.clear()
  installed = false
}

/** Internal seams for unit tests; not part of the module's contract. */
export const __test = { statusForNavigation, authHintFor }
