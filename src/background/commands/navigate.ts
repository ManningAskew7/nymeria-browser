import type { CommandResult } from '../../shared/types'
import {
  blockedByDialogError,
  raceStandingDialog,
  standingDialog,
  standingDialogPayload,
} from '../dialogs'
import {
  commitSeq,
  commitSince,
  navigationError,
  navigationPending,
  sameDocumentSince,
  waitForNavSignal,
} from '../navWatch'
import { clear as clearRefs } from '../snapshotRefs'
import { statusPayload } from '../statusWatch'
import { TAB_LOAD_WAIT_MS, waitForTabComplete } from '../settle'

// NB `history.ts` (back/forward) still determines its outcome the OLD way
// (`waitForTabComplete` + url comparison): upgrading it to this module's
// commit-signal shape needs a live BFCache measurement first (a cached
// back/forward restore may not fire the same webNavigation events), recorded
// on backlog #160. The docstrings scope the honest contract accordingly; do
// not extend them to back/forward without doing the code first.

interface NavigateArgs {
  tab_id: number
  url: string
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * How long after `tabs.update` a navigation gets to START (onBeforeNavigate)
 * before the never-left verdict. Starting is browser-process work and takes
 * milliseconds; this deadline is generous slack, not an expected wait. It is
 * what replaces the old shape, which rode the full 25s load wait and then
 * reported `ok: true` with the starting url sitting quietly in the payload.
 */
const NAV_START_DEADLINE_MS = 2_000

/**
 * The beat a dead navigation gets before the aborted verdict. An abort is
 * often a REPLACEMENT (the page redirecting the navigation we started aborts
 * ours and starts its own moments later); judging at the abort instant would
 * false-fail those, and a false failure aborts the rest of a batch.
 */
const ERROR_SETTLE_MS = 300

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return ALLOWED_SCHEMES.has(u.protocol)
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type NavProgress =
  | { kind: 'committed'; url: string; complete: boolean }
  | { kind: 'same-document'; url: string }
  | { kind: 'pending'; url: string }
  | { kind: 'aborted'; error: string | null }
  | { kind: 'never-started' }
  | { kind: 'tab-gone' }

/**
 * Determine what actually happened to the navigation, from the
 * browser-process record (navWatch) rather than from comparing url strings.
 *
 * String comparison is the shape that was built and REVERTED 2026-08-11: it
 * false-failed slow-TTFB navigations, tripped on url normalization, failed
 * open when the OLD document read complete, and could never see a same-url
 * navigation. Navigation signals have none of those failure modes, and the
 * same-document signal covers the one case string comparison got right
 * (a fragment or pushState move fires no commit at all).
 */
async function navigationOutcome(
  tabId: number,
  seqBefore: number,
  t0: number,
): Promise<NavProgress> {
  const deadline = t0 + TAB_LOAD_WAIT_MS
  // Advanced past a handled abort so a consumed error cannot re-trigger the
  // pre-check on the next lap; commits use seq and are unaffected.
  let signalSince = t0
  let inStartWindow = true
  for (;;) {
    const windowEnd = inStartWindow ? Math.min(t0 + NAV_START_DEADLINE_MS, deadline) : deadline
    const signal = await waitForNavSignal(
      tabId,
      seqBefore,
      signalSince,
      Math.max(0, windowEnd - Date.now()),
    )
    if (signal?.kind === 'commit') {
      const complete = await waitForTabComplete(tabId, Math.max(0, deadline - Date.now()))
      return { kind: 'committed', url: signal.url, complete }
    }
    if (signal?.kind === 'same-document') return { kind: 'same-document', url: signal.url }
    if (signal?.kind === 'removed') return { kind: 'tab-gone' }
    if (signal?.kind === 'error') {
      await sleep(ERROR_SETTLE_MS)
      const followedBy =
        commitSince(tabId, seqBefore) ??
        navigationPending(tabId, t0) ??
        sameDocumentSince(tabId, signalSince)
      if (followedBy) {
        signalSince = Date.now()
        inStartWindow = false
        continue
      }
      return { kind: 'aborted', error: signal.error }
    }
    // null: this window's deadline passed with no signal.
    if (inStartWindow) {
      if (!navigationPending(tabId, t0)) return { kind: 'never-started' }
      inStartWindow = false
      continue
    }
    const stillPending = navigationPending(tabId, t0)
    if (stillPending) return { kind: 'pending', url: stillPending.url }
    // Pending evaporated with neither commit nor error record: aborted,
    // cause unrecorded (safety net; the events should always say which).
    return { kind: 'aborted', error: navigationError(tabId, t0)?.error ?? null }
  }
}

function neverStartedError(stayedOn: string | undefined, requested: string): string {
  return (
    `the navigation to ${requested} never started: the tab is still on ` +
    `${stayedOn ?? 'its previous page'}. Chrome may have refused the URL, or ` +
    'the tab may be held by something this session cannot see (a dialog ' +
    'raised before any attach). Re-check the URL, or read the page to see ' +
    'where you are.'
  )
}

function abortedError(
  stayedOn: string | undefined,
  requested: string,
  reason: string | null,
): string {
  const named = reason ? ` (Chrome reported ${reason})` : ''
  return (
    `the navigation to ${requested} started but never arrived${named}. ` +
    'This happens when the URL triggered a download, the site or an ' +
    'extension canceled it, or Chrome blocked it. The tab is still on ' +
    `${stayedOn ?? 'its previous page'}.`
  )
}

export async function execNavigate(args: unknown): Promise<CommandResult> {
  const a = args as NavigateArgs
  if (typeof a.tab_id !== 'number') {
    return { ok: false, status: 'error', error: 'tab_id required' }
  }
  if (!isAllowedUrl(a.url)) {
    return { ok: false, status: 'error', error: 'url must be http:// or https://' }
  }
  const seqBefore = commitSeq(a.tab_id)
  const t0 = Date.now()
  const tab = await chrome.tabs.update(a.tab_id, { url: a.url })
  clearRefs(a.tab_id)

  // Raced against a dialog opening (#169): a beforeunload holds the tab on
  // its old page, and riding the wait out against a known, named cause would
  // be the old dishonest shape with the answer standing right there.
  const outcome = await raceStandingDialog(a.tab_id, navigationOutcome(a.tab_id, seqBefore, t0))
  const finalTab = await chrome.tabs.get(a.tab_id).catch(() => null)

  const dialogResult = (d: NonNullable<ReturnType<typeof standingDialog>>): CommandResult => ({
    ok: false,
    status: 'error',
    error: blockedByDialogError(a.tab_id, d),
    data: {
      tab_id: a.tab_id,
      // Honest: the tab is still where it was.
      url: (finalTab ?? tab)?.url,
      requested_url: a.url,
      dialog: standingDialogPayload(a.tab_id, d),
    },
  })
  if (outcome.kind === 'dialog') return dialogResult(outcome.dialog)
  // Belt over the race: whichever branch won, a dialog standing NOW is the
  // story (the outcome work can finish off the OLD document's state in the
  // same instant a beforeunload opens).
  const belt = standingDialog(a.tab_id)
  if (belt) return dialogResult(belt)

  const nav = outcome.value
  switch (nav.kind) {
    case 'committed':
      return {
        ok: true,
        status: 'success',
        data: {
          tab_id: a.tab_id,
          // The re-read wins over the commit record: a redirect chain can
          // move the url again after the first commit.
          url: (finalTab ?? tab)?.url ?? nav.url,
          title: (finalTab ?? tab)?.title,
          complete: nav.complete,
          // #175: the HTTP status behind the committed document, when the
          // webRequest grant lets it be seen. An error page commits like any
          // other, so without this a 404/500/401 reads as a clean success;
          // absent means UNKNOWN (no grant, or no matching record), never OK.
          // Only the committed branch may claim one: a same-document move has
          // no request, and the failure branches never arrived.
          ...statusPayload(a.tab_id, t0, [nav.url, (finalTab ?? tab)?.url]),
        },
      }
    case 'same-document':
      // A fragment or history-API move: no document load, nothing to wait
      // for, the tab is already there.
      return {
        ok: true,
        status: 'success',
        data: {
          tab_id: a.tab_id,
          url: (finalTab ?? tab)?.url ?? nav.url,
          title: (finalTab ?? tab)?.title,
          complete: true,
          same_document: true,
        },
      }
    case 'pending':
      // Started and still in flight at the deadline: a slow site, not a
      // failure (a false failure aborts the rest of a batch). Nothing is
      // asserted as arrived; the payload names what is still pending.
      return {
        ok: true,
        status: 'success',
        data: {
          tab_id: a.tab_id,
          url: (finalTab ?? tab)?.url,
          title: (finalTab ?? tab)?.title,
          complete: false,
          navigation_pending: nav.url,
          requested_url: a.url,
        },
      }
    case 'aborted':
      return {
        ok: false,
        status: 'error',
        error: abortedError((finalTab ?? tab)?.url, a.url, nav.error),
        data: { tab_id: a.tab_id, url: (finalTab ?? tab)?.url, requested_url: a.url },
      }
    case 'never-started':
      return {
        ok: false,
        status: 'error',
        error: neverStartedError((finalTab ?? tab)?.url, a.url),
        data: { tab_id: a.tab_id, url: (finalTab ?? tab)?.url, requested_url: a.url },
      }
    case 'tab-gone':
      return {
        ok: false,
        status: 'error',
        error: `the tab was closed while the navigation to ${a.url} was in flight.`,
        data: { tab_id: a.tab_id, requested_url: a.url },
      }
  }
}
