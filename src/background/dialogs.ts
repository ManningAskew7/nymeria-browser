import { backgroundLogger as logger } from '../utils/logger'
import {
  onCdpEvent,
  onSessionEnd,
  registerDetachGate,
  sendCommand,
} from './debuggerSession'

/**
 * Deliberate ownership of the Page domain's dialogs (backlog #169).
 *
 * Enabling `Page` makes this extension the owner of every JavaScript dialog
 * in the attached tab: each `javascriptDialogOpening` must be answered with
 * `Page.handleJavaScriptDialog` or the renderer stays suspended. That used to
 * be the reason `Page` was excluded from the capture domains; it is now the
 * point. Ownership spans exactly the attach (a command burst plus the 10s
 * detach linger), which is the window where a dialog is almost always a
 * consequence of the agent's own action.
 *
 * The answering policy, per dialog class:
 *
 *  - `alert`: answered immediately. OK is the only possible answer, the
 *    message is captured and reported to the agent, and any delay only
 *    prolongs the suspension for nothing.
 *  - `confirm` / `prompt`: left standing for the agent, who is told about the
 *    dialog by whichever command it interrupted and answers it deliberately
 *    with `chrome_dialog`. Unanswered at `DIALOG_GRACE_MS`, it is dismissed
 *    (the safe default: cancel does nothing) so a tab can never stay wedged
 *    by us. The user can also answer it on screen at any time; it is their
 *    dialog UI.
 *  - `beforeunload`: left standing and reported the same way (the developer's
 *    call: unsaved page state is the user's data, so leaving is a deliberate
 *    decision, `chrome_dialog(action="accept")`, not a default). The one
 *    exception is an agent-commanded tab CLOSE, which pre-registers intent
 *    here and gets its beforeunload accepted immediately: close is the
 *    recovery path and must always clear the tab.
 *
 * A dialog raised while NO attach is live is not ours and never will be: a
 * reactive `Page.enable` cannot take ownership of a dialog already standing
 * (measured; it is why the old chrome_dialog was useless). Those revert to
 * the recovery matrix in SKILL.md, and the messages here say so.
 *
 * File-chooser interception rides the same ownership: `doAttach` arms
 * `Page.setInterceptFileChooserDialog` once per attach, so while attached no
 * OS file chooser can open in the tab; `Page.fileChooserOpened` fires instead
 * and is recorded here for `act` to report. Interception is page-wide while
 * armed, so the user's own "Choose File" click during a burst + linger is
 * swallowed too; accepted and documented, the alternative was the one wedge
 * class nothing could detect or recover (see the #166 record).
 *
 * MV3 recycle mid-dialog is bounded by construction: a standing JS dialog is
 * ordinary visible browser UI the user can always answer themselves, so
 * losing the worker (and with it this state) merely returns to the pre-#169
 * status quo until the next attach.
 */

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/** How long a confirm/prompt/beforeunload stands before the safe default. */
export const DIALOG_GRACE_MS = 60_000

/**
 * The grace-deadline default is DISMISS for every held class: cancel does
 * nothing on a confirm/prompt, and "stay on the page" preserves unsaved
 * state on a beforeunload. (alert and close-intent beforeunload never reach
 * the deadline; they are answered at open.)
 */
const GRACE_DEFAULT_ACCEPT = false

/**
 * `Page.handleJavaScriptDialog` is a browser-process call and answers fast;
 * sized inside chrome_dialog's 5s backend budget so a failure stays ours and
 * named, same reasoning as the old dialog command's deadline.
 */
const ANSWER_CALL_DEADLINE_MS = 3_500

/**
 * How soon the class default retries after a FAILED answer call. Short: the
 * failed call was itself the policy (an alert ack, a timeout default) or the
 * agent's own answer, so nothing is waiting on a fresh decision; the point is
 * only that a failure must never leave the record with no armed fallback.
 */
const ANSWER_RETRY_MS = 5_000

/** How long a close-intent registration is honoured before it goes stale. */
const CLOSE_INTENT_TTL_MS = 15_000

/** How long a resolved dialog stays worth mentioning to a late chrome_dialog. */
const RESOLVED_RECENCY_MS = 120_000

export type AnsweredBy = 'agent' | 'policy' | 'timeout' | 'user' | 'orphaned'

export interface StandingDialog {
  type: DialogType
  message: string
  url: string
  defaultPrompt?: string
  openedAt: number
  /** When the grace timer fires the class default. */
  deadlineAt: number
}

export interface ResolvedDialog {
  type: DialogType
  message: string
  openedAt: number
  resolvedAt: number
  /** What Chrome reports the dialog resolved as; false for `orphaned`. */
  accepted: boolean
  by: AnsweredBy
}

export interface InterceptedChooser {
  at: number
  /** Chrome's chooser mode, `selectSingle` or `selectMultiple`. */
  mode: string
}

interface StandingRecord extends StandingDialog {
  timer: ReturnType<typeof setTimeout> | null
  /** Set the moment an answer goes out, so nothing double-answers. */
  answering: { by: AnsweredBy; accepted: boolean } | null
}

const standing = new Map<number, StandingRecord>()
const lastResolved = new Map<number, ResolvedDialog>()
const closeIntents = new Map<number, number>()
const lastChooser = new Map<number, InterceptedChooser>()
const standingWaiters = new Map<number, Set<(d: StandingDialog) => void>>()
const resolutionWaiters = new Map<number, Set<() => void>>()

function strip(rec: StandingRecord): StandingDialog {
  return {
    type: rec.type,
    message: rec.message,
    url: rec.url,
    ...(rec.defaultPrompt !== undefined ? { defaultPrompt: rec.defaultPrompt } : {}),
    openedAt: rec.openedAt,
    deadlineAt: rec.deadlineAt,
  }
}

/**
 * The dialog currently standing AND awaiting an answer, or null.
 *
 * A record whose answer is already in flight (an alert being auto-acked, a
 * timeout default going out) is not "standing" to callers: nothing they do
 * can race the answer usefully, and reporting it would tell an agent to
 * answer a dialog that is already being answered.
 */
export function standingDialog(tabId: number): StandingDialog | null {
  const rec = standing.get(tabId)
  return rec && rec.answering === null ? strip(rec) : null
}

/** The most recently resolved dialog, if it resolved within the recency window. */
export function lastResolvedDialog(tabId: number): ResolvedDialog | null {
  const r = lastResolved.get(tabId)
  return r && Date.now() - r.resolvedAt <= RESOLVED_RECENCY_MS ? r : null
}

/** A dialog that opened at/after `sinceTs` and has already been resolved. */
export function resolvedDialogSince(tabId: number, sinceTs: number): ResolvedDialog | null {
  const r = lastResolved.get(tabId)
  return r && r.openedAt >= sinceTs ? r : null
}

/** A file chooser intercepted at/after `sinceTs`, for act's verification. */
export function chooserInterceptedSince(tabId: number, sinceTs: number): InterceptedChooser | null {
  const c = lastChooser.get(tabId)
  return c && c.at >= sinceTs ? c : null
}

/**
 * Register that an agent-commanded close is about to hit this tab, so a
 * beforeunload it raises is accepted instead of held. Consumed by the first
 * beforeunload, expires on its own otherwise.
 */
export function expectBeforeunloadAccept(tabId: number): void {
  closeIntents.set(tabId, Date.now() + CLOSE_INTENT_TTL_MS)
}

/**
 * Resolves the moment a dialog is standing for this tab (immediately when one
 * already is). `cancel()` detaches the waiter; a cancelled signal's promise
 * simply never settles, which is safe in a `Promise.race`.
 */
/**
 * Race `work` against a dialog opening on this tab, and always clean up.
 *
 * The exported shape on purpose: the raw signal's cancelled promise never
 * settles, which is safe only inside a race, so callers get the race rather
 * than the handle. Used by navigate, history, and act's wait branch.
 */
export async function raceStandingDialog<T>(
  tabId: number,
  work: Promise<T>,
): Promise<{ kind: 'work'; value: T } | { kind: 'dialog'; dialog: StandingDialog }> {
  const sig = dialogStandingSignal(tabId)
  try {
    return await Promise.race([
      work.then((value) => ({ kind: 'work' as const, value })),
      sig.promise.then((dialog) => ({ kind: 'dialog' as const, dialog })),
    ])
  } finally {
    sig.cancel()
  }
}

export function dialogStandingSignal(tabId: number): {
  promise: Promise<StandingDialog>
  cancel: () => void
} {
  const current = standingDialog(tabId)
  if (current) {
    return { promise: Promise.resolve(current), cancel: () => undefined }
  }
  let entry: ((d: StandingDialog) => void) | null = null
  const promise = new Promise<StandingDialog>((resolve) => {
    entry = resolve
    let set = standingWaiters.get(tabId)
    if (!set) {
      set = new Set()
      standingWaiters.set(tabId, set)
    }
    set.add(resolve)
  })
  return {
    promise,
    cancel: () => {
      if (!entry) return
      const set = standingWaiters.get(tabId)
      if (set) {
        set.delete(entry)
        if (set.size === 0) standingWaiters.delete(tabId)
      }
    },
  }
}

function notifyStanding(tabId: number, d: StandingDialog): void {
  const set = standingWaiters.get(tabId)
  if (!set) return
  standingWaiters.delete(tabId)
  for (const resolve of set) resolve(d)
}

function notifyResolved(tabId: number): void {
  const set = resolutionWaiters.get(tabId)
  if (!set) return
  resolutionWaiters.delete(tabId)
  for (const resolve of set) resolve()
}

function waitForResolution(tabId: number, ms: number): Promise<void> {
  if (!standing.has(tabId)) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const set = resolutionWaiters.get(tabId)
      if (set) {
        set.delete(done)
        if (set.size === 0) resolutionWaiters.delete(tabId)
      }
      resolve()
    }, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    let set = resolutionWaiters.get(tabId)
    if (!set) {
      set = new Set()
      resolutionWaiters.set(tabId, set)
    }
    set.add(done)
  })
}

/**
 * Arm (or re-arm) the timer that fires the class default at `deadlineAt`.
 * The default is ACK for an alert (the only possible answer) and dismiss for
 * every held class. This is the ONE place the fallback timer is created, so
 * "a standing record always has an armed fallback" is an invariant a reader
 * can check at two call sites instead of five.
 */
function armFallback(tabId: number, rec: StandingRecord, delayMs: number): void {
  rec.deadlineAt = Date.now() + delayMs
  rec.timer = setTimeout(() => {
    const still = standing.get(tabId)
    if (!still || still !== rec || still.answering) return
    void sendAnswer(
      tabId,
      still,
      still.type === 'alert' ? 'policy' : 'timeout',
      still.type === 'alert' ? true : GRACE_DEFAULT_ACCEPT,
    )
  }, delayMs)
}

async function sendAnswer(
  tabId: number,
  rec: StandingRecord,
  by: AnsweredBy,
  accept: boolean,
  promptText?: string,
): Promise<boolean> {
  rec.answering = { by, accepted: accept }
  if (rec.timer) {
    clearTimeout(rec.timer)
    rec.timer = null
  }
  try {
    await sendCommand(
      tabId,
      'Page.handleJavaScriptDialog',
      {
        accept,
        ...(promptText != null ? { promptText } : {}),
      },
      { deadlineMs: ANSWER_CALL_DEADLINE_MS },
    )
    return true
  } catch (e) {
    // The dialog may have been answered by the user in the same instant, or
    // the tab may be going away. Un-mark so it is answerable again, and
    // RE-ARM the fallback this call cleared on entry: without it the record
    // stood forever with no timer (deadline 0 for an alert or close-intent),
    // while every message kept promising an automatic dismissal (review,
    // #169). The remaining grace is honoured where it exists; a record that
    // never had a deadline retries the class default shortly.
    rec.answering = null
    if (standing.get(tabId) === rec) {
      armFallback(tabId, rec, Math.max(rec.deadlineAt - Date.now(), ANSWER_RETRY_MS))
    }
    logger.warn(`handleJavaScriptDialog failed tab=${tabId} type=${rec.type}:`, e)
    return false
  }
}

/**
 * Answer the standing dialog on the agent's behalf. The outcome names what
 * happened when there is nothing to answer, because "no dialog" has three
 * different honest explanations with three different next moves.
 */
export async function answerStandingDialog(
  tabId: number,
  accept: boolean,
  promptText?: string,
): Promise<
  | { outcome: 'answered'; dialog: StandingDialog }
  | { outcome: 'already-resolved'; last: ResolvedDialog }
  | { outcome: 'none' }
  | { outcome: 'failed'; dialog: StandingDialog; error: string }
> {
  const rec = standing.get(tabId)
  if (!rec || rec.answering) {
    const last = lastResolvedDialog(tabId)
    if (last) return { outcome: 'already-resolved', last }
    return { outcome: 'none' }
  }
  const dialog = strip(rec)
  const sent = await sendAnswer(tabId, rec, 'agent', accept, promptText)
  if (!sent) {
    return {
      outcome: 'failed',
      dialog,
      error: 'Chrome did not accept the answer; the dialog may already be gone',
    }
  }
  return { outcome: 'answered', dialog }
}

function onDialogOpening(tabId: number, params: unknown): void {
  const p = params as {
    url?: string
    message?: string
    type?: string
    defaultPrompt?: string
  }
  const type: DialogType =
    p.type === 'confirm' || p.type === 'prompt' || p.type === 'beforeunload' ? p.type : 'alert'
  const rec: StandingRecord = {
    type,
    message: p.message ?? '',
    url: p.url ?? '',
    ...(type === 'prompt' && p.defaultPrompt !== undefined
      ? { defaultPrompt: p.defaultPrompt }
      : {}),
    openedAt: Date.now(),
    deadlineAt: 0,
    timer: null,
    answering: null,
  }
  standing.set(tabId, rec)

  if (type === 'alert') {
    void sendAnswer(tabId, rec, 'policy', true)
    return
  }
  if (type === 'beforeunload') {
    const intent = closeIntents.get(tabId)
    if (intent !== undefined && intent > Date.now()) {
      closeIntents.delete(tabId)
      void sendAnswer(tabId, rec, 'policy', true)
      return
    }
  }
  armFallback(tabId, rec, DIALOG_GRACE_MS)
  notifyStanding(tabId, strip(rec))
}

function onDialogClosed(tabId: number, params: unknown): void {
  const p = params as { result?: boolean }
  const rec = standing.get(tabId)
  if (!rec) return
  if (rec.timer) clearTimeout(rec.timer)
  standing.delete(tabId)
  lastResolved.set(tabId, {
    type: rec.type,
    message: rec.message,
    openedAt: rec.openedAt,
    resolvedAt: Date.now(),
    accepted: p.result === true,
    // No answer of ours in flight means a human clicked it on screen.
    by: rec.answering?.by ?? 'user',
  })
  notifyResolved(tabId)
}

function onFileChooserOpened(tabId: number, params: unknown): void {
  const p = params as { mode?: string }
  lastChooser.set(tabId, { at: Date.now(), mode: p.mode ?? 'selectSingle' })
}

/**
 * The detach gate: an owned dialog must be resolved before the attach that
 * owns it ends. Waits out the grace deadline (the timeout default answers
 * it), then answers the class default itself as a safety net if the record
 * somehow still stands. Bounded: never longer than the remaining grace + 2s.
 */
async function detachGate(tabId: number): Promise<void> {
  const rec = standing.get(tabId)
  if (!rec) return
  const remaining = rec.answering ? 2_000 : Math.max(0, rec.deadlineAt - Date.now()) + 2_000
  await waitForResolution(tabId, remaining)
  const still = standing.get(tabId)
  if (still && !still.answering) {
    await sendAnswer(tabId, still, 'timeout', GRACE_DEFAULT_ACCEPT)
  }
}

/**
 * The attach ended (voluntary detach done, or Chrome detached us). Ownership
 * ends with it: a dialog still standing reverts to plain user-answerable UI,
 * recorded as `orphaned` so a late chrome_dialog can say what happened.
 */
function onEnd(tabId: number): void {
  const rec = standing.get(tabId)
  if (rec) {
    if (rec.timer) clearTimeout(rec.timer)
    standing.delete(tabId)
    lastResolved.set(tabId, {
      type: rec.type,
      message: rec.message,
      openedAt: rec.openedAt,
      resolvedAt: Date.now(),
      accepted: false,
      by: 'orphaned',
    })
    notifyResolved(tabId)
  }
  closeIntents.delete(tabId)
}

/** The tab itself is gone; nothing about it is worth remembering. */
export function clearTabDialogState(tabId: number): void {
  const rec = standing.get(tabId)
  if (rec?.timer) clearTimeout(rec.timer)
  standing.delete(tabId)
  lastResolved.delete(tabId)
  closeIntents.delete(tabId)
  lastChooser.delete(tabId)
  standingWaiters.delete(tabId)
  notifyResolved(tabId)
}

/** Human-readable outcome for messages: who answered, and how. */
export function describeResolution(r: ResolvedDialog): string {
  switch (r.by) {
    case 'policy':
      return r.type === 'alert'
        ? 'auto-acknowledged (alerts have no decision to make; the message is preserved here)'
        : 'auto-accepted (an agent-commanded close was in flight)'
    case 'timeout':
      return 'dismissed automatically when nobody answered it within the grace window'
    case 'agent':
      return `${r.accepted ? 'accepted' : 'dismissed'} via chrome_dialog`
    case 'user':
      return `${r.accepted ? 'accepted' : 'dismissed'} by the user on screen`
    case 'orphaned':
      return (
        'left unanswered when the debug session ended; if it is still on screen, ' +
        'only the user can clear it now'
      )
  }
}

/** Whole seconds until the grace default fires; never below 1. */
export function graceSecondsLeft(d: StandingDialog): number {
  return Math.max(1, Math.round((d.deadlineAt - Date.now()) / 1000))
}

/**
 * The ONE prose sentence that teaches the answer route and the fallback.
 * Every surface that names a standing dialog composes this after its own
 * lead clause, so the wordings cannot drift when the grace policy changes.
 */
export function dialogAnswerSentence(tabId: number, d: StandingDialog): string {
  return (
    `Answer it with chrome_dialog(tab_id=${tabId}, action="accept" or "dismiss"` +
    `${d.type === 'prompt' ? ', prompt_text=...' : ''}); unanswered, it will be ` +
    `dismissed automatically in ~${graceSecondsLeft(d)}s`
  )
}

/** The payload-shaped view of a standing dialog, shared by act/navigate/reads. */
export function standingDialogPayload(tabId: number, d: StandingDialog): Record<string, unknown> {
  return {
    state: 'standing',
    type: d.type,
    message: d.message,
    ...(d.url ? { page_url: d.url } : {}),
    ...(d.defaultPrompt !== undefined ? { default_prompt: d.defaultPrompt } : {}),
    expires_in_ms: Math.max(0, d.deadlineAt - Date.now()),
    answer_with: `chrome_dialog(tab_id=${tabId}, action="accept" or "dismiss"${
      d.type === 'prompt' ? ', prompt_text=...' : ''
    })`,
    if_unanswered: 'dismissed automatically at the deadline',
  }
}

/** What a READ that hit a standing dialog should say. */
export function dialogBlockedReadError(tabId: number, d: StandingDialog): string {
  return (
    `this read could not run: the tab is showing a ${d.type} dialog: ` +
    `"${d.message}". The page is paused until it is answered. ` +
    `${dialogAnswerSentence(tabId, d)}. Nothing was changed on the page.`
  )
}

/**
 * A navigation (or back/forward) blocked by a dialog is a FAILED navigation,
 * named. Before ownership this was the documented lie: a "Leave site?" held
 * the tab on its old page while the command reported success. Hold-and-report
 * is deliberate (the developer's call): unsaved page state is the user's
 * data, so leaving is a decision, `chrome_dialog(action="accept")`, not a
 * default. Lives here with the other dialog copy so navigate and history
 * share it without a command-to-command import.
 */
export function blockedByDialogError(tabId: number, d: StandingDialog): string {
  if (d.type === 'beforeunload') {
    return (
      'the navigation is paused: the page asked to confirm leaving ' +
      '(a "Leave site?" dialog, so it likely has unsaved state). ' +
      `chrome_dialog(tab_id=${tabId}, action="accept") leaves and lets the ` +
      'navigation finish; "dismiss" stays on the current page. Unanswered, it ' +
      `is dismissed automatically in ~${graceSecondsLeft(d)}s and the tab stays ` +
      'where it is. If the unsaved state might matter, ask the user before ' +
      'accepting.'
    )
  }
  return (
    `the navigation is paused: the page raised a ${d.type} dialog: "${d.message}". ` +
    `${dialogAnswerSentence(tabId, d)}.`
  )
}

let installed = false
let uninstallers: Array<() => void> = []

/**
 * Bind the CDP event handlers, the detach gate, and the session-end cleanup.
 * Called explicitly from the background entry point at worker top level
 * (MV3 wants listeners bound synchronously), the same shape as the console
 * and network captures; idempotent. Tests that reset the session layer
 * (which drops every CDP event handler) must call `resetDialogsForTests`
 * afterwards to re-bind; it unsubscribes its own handles first, so the
 * calling order of the two resets does not matter and nothing duplicates.
 */
export function installDialogOwnership(): void {
  if (installed) return
  installed = true
  uninstallers.push(
    onCdpEvent((tabId, method, params) => {
      if (method === 'Page.javascriptDialogOpening') onDialogOpening(tabId, params)
      else if (method === 'Page.javascriptDialogClosed') onDialogClosed(tabId, params)
      else if (method === 'Page.fileChooserOpened') onFileChooserOpened(tabId, params)
    }),
  )
  registerDetachGate(detachGate)
  uninstallers.push(onSessionEnd(onEnd))
}

export function resetDialogsForTests(): void {
  for (const [, rec] of standing) {
    if (rec.timer) clearTimeout(rec.timer)
  }
  standing.clear()
  lastResolved.clear()
  closeIntents.clear()
  lastChooser.clear()
  standingWaiters.clear()
  resolutionWaiters.clear()
  for (const off of uninstallers) off()
  uninstallers = []
  installed = false
  installDialogOwnership()
}
