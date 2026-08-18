/**
 * One call that answers "is this tab healthy" (#188).
 *
 * The QA operator's top ask, verbatim: "Attached or not, buffer size,
 * last-driven timestamp, standing dialog, input suppression. Today that
 * state is inferable only by scattering probes across chrome_network,
 * chrome_console and a throwaway act." This command assembles those facts
 * into one read.
 *
 * LOCAL READS ONLY, deliberately. Health must not attach the tab
 * (`withSession` is forbidden here): an attach would flip the very capture
 * state being reported, start a capture the caller did not ask for, and pay
 * a CDP round trip for facts that are all sitting in worker memory, session
 * storage, or the browser process. For the same reason it is
 * `READS_THE_PAGE: false`: this is the diagnostic an agent reaches for when
 * a tab looks wedged, and gating it on renderer liveness or refusing it
 * under a standing dialog would deadlock the cure on the disease (the
 * console/network/dialog rationale, one further).
 *
 * Absence is honest everywhere: an absent key means unknown or
 * none, never "fine". Ages are reported as `age_ms` rather than absolute
 * clocks so the reader does no clock math. The one cross-cutting caveat is
 * the MV3 recycle asymmetry (#179 made refs the ONLY section that survives
 * a worker recycle): `worker_recycled_since_drive` names it when it
 * applies, and the backend renders the honesty note.
 *
 * Input suppression is EVIDENCE, not state: Chrome has no getter for the
 * flag (delivery.ts docstring), so `input_swallowed` reports the last act
 * whose probe PROVED a trusted event was discarded, cleared again when one
 * provably arrives. `auth_prompt_likely` is the one inference: a 401/407
 * last response means Chrome is almost certainly showing an auth prompt and
 * discarding input under it.
 */

import type { CommandResult } from '../../shared/types'
import { count as consoleCount } from '../consoleBuffer'
import { suppressionEvidence } from '../delivery'
import { everAttached, isAttached, lastDetachAt } from '../debuggerSession'
import { lastResolvedDialog, recentChooser, standingDialog } from '../dialogs'
import { readDriveStamp, WORKER_STARTED_AT } from '../driveStamp'
import { lastNavigationError, pendingNavigation } from '../navWatch'
import { count as networkCount } from '../networkBuffer'
import { mintedCount, size as heldRefs, snapshotUrl } from '../snapshotRefs'
import { lastStatus } from '../statusWatch'

interface HealthArgs {
  tab_id: number
}

function age(now: number, at: number): number {
  return Math.max(0, now - at)
}

export async function execHealth(args: unknown): Promise<CommandResult> {
  const a = args as HealthArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const tabId = a.tab_id

  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) {
    return {
      ok: false,
      status: 'error',
      error: `tab ${tabId} does not exist (it may have been closed). chrome_tabs lists the live ones.`,
    }
  }

  const now = Date.now()
  const attached = isAttached(tabId)
  const everThisWorker = everAttached(tabId)
  const detachedAt = lastDetachAt(tabId)
  const dialog = standingDialog(tabId)
  const resolved = dialog ? null : lastResolvedDialog(tabId)
  const chooser = recentChooser(tabId)
  const pending = pendingNavigation(tabId)
  const navError = lastNavigationError(tabId)
  const status = lastStatus(tabId)
  const driven = await readDriveStamp(tabId)
  const swallowed = await suppressionEvidence(tabId)

  return {
    ok: true,
    status: 'success',
    data: {
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        window_id: tab.windowId,
        status: tab.status,
        ...(tab.discarded === true ? { discarded: true } : {}),
      },
      attached,
      ever_attached_this_worker: everThisWorker,
      console_entries: consoleCount(tabId),
      network_entries: networkCount(tabId),
      // The lapse a buffer-reading command would resume from: only when
      // detached after having captured, same rule as capture_gap_ms there.
      ...(!attached && everThisWorker && detachedAt !== null
        ? { capture_gap_ms: age(now, detachedAt) }
        : {}),
      ...(dialog
        ? {
            dialog: {
              type: dialog.type,
              message: dialog.message,
              age_ms: age(now, dialog.openedAt),
              auto_answer_in_ms: Math.max(0, dialog.deadlineAt - now),
            },
          }
        : {}),
      ...(resolved
        ? {
            dialog_resolved: {
              type: resolved.type,
              accepted: resolved.accepted,
              by: resolved.by,
              age_ms: age(now, resolved.resolvedAt),
            },
          }
        : {}),
      ...(chooser ? { file_chooser_intercepted: { mode: chooser.mode, age_ms: age(now, chooser.at) } } : {}),
      ...(pending ? { navigation_pending: { url: pending.url, age_ms: age(now, pending.at) } } : {}),
      ...(navError ? { navigation_error: { error: navError.error, age_ms: age(now, navError.at) } } : {}),
      ...(status
        ? {
            http_status: { status: status.status, url: status.url, age_ms: age(now, status.at) },
            ...(status.status === 401 || status.status === 407 ? { auth_prompt_likely: true } : {}),
          }
        : {}),
      refs: {
        held: heldRefs(tabId),
        minted_total: mintedCount(tabId),
        ...(snapshotUrl(tabId) !== null ? { snapshot_url: snapshotUrl(tabId) } : {}),
      },
      ...(driven
        ? {
            last_driven: { command: driven.command, age_ms: age(now, driven.at) },
            ...(driven.at < WORKER_STARTED_AT ? { worker_recycled_since_drive: true } : {}),
          }
        : {}),
      ...(swallowed ? { input_swallowed: { action: swallowed.action, age_ms: age(now, swallowed.at) } } : {}),
    },
  }
}
