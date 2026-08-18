import { backgroundLogger as logger } from '../../utils/logger'
import { postCommandResult } from '../api'
import { BUDGET_RESERVE_MS, type ExecContext } from '../budget'
import type { BrowserCommandEvent, CommandResult, CommandType } from '../../shared/types'
import { execAct } from './act'
import { execBatch } from './batch'
import { execCdp } from './cdp'
import { execConsole } from './console'
import { execDialog } from './dialog'
import { execExtractText } from './extract_text'
import { execHistory } from './history'
import { execNavigate } from './navigate'
import { execNetwork } from './network'
import { execReloadExtension } from './reload_extension'
import { execScreenshot } from './screenshot'
import { execSnapshot } from './snapshot'
import { execTabs } from './tabs'
import { dialogBlockedReadError, standingDialog } from '../dialogs'
import { refsReady } from '../snapshotRefs'
import { READ_LIVENESS_DEADLINE_MS, rendererResponsive, suspendedPageReadError } from '../settle'

type Executor = (args: unknown, ctx?: ExecContext) => Promise<CommandResult>

/**
 * Safety valve on the result body, not a model-facing cap.
 *
 * The wire can carry a lot; the agent's context cannot. Model-facing limits
 * (and spilling the overflow into the workspace) belong on the backend, which
 * is where the workspace actually is. This bound only stops one runaway
 * command from posting an unbounded body, which is a transport concern.
 */
const MAX_RESULT_BYTES = 8_000_000

/**
 * Which commands cannot produce anything on a suspended renderer.
 *
 * A `Record<CommandType, boolean>` rather than a set of names, so adding a
 * command type is a COMPILE ERROR until someone answers this question for it.
 * A set would let a thirteenth command be silently unclassified, and the whole
 * point of this table is that it must not quietly go stale.
 *
 * Measured 2026-08-12: a `chrome_find` against a tab held by an alert() rode
 * its full 20s transport budget and came back with a bare timeout, and the
 * agent worked around it by guessing a css= selector rather than learning the
 * tab was wedged.
 *
 * The falses are as deliberate as the trues. `act` does its own liveness
 * checking, twice, and must: its answer turns on whether the stall happened
 * before or after input went out, which a check out here cannot know.
 * `navigate` and `tabs` are driven from the browser process and keep working
 * on a suspended tab, which is exactly why navigating away is a recovery, and
 * gating them would break it. `history` is the same. `console` and `network`
 * read local buffers fed by CDP events and need nothing from the page, which
 * makes them the diagnostics an agent reaches for once a tab goes quiet.
 * `dialog` answers the recorded standing dialog from the BROWSER process
 * (#169), so the suspended renderer it exists to relieve is irrelevant to
 * it, and gating it would deadlock the cure on the disease. `batch` is not
 * itself a page read; its sub-commands come back through here individually.
 * `cdp` is the raw escape hatch and must not be second-guessed.
 *
 * `screenshot` was a false at first, on the theory that its image comes from
 * the compositor, not the renderer, so a picture of a frozen page is exactly
 * what an agent most wants and a pre-flight would throw it away. Measured
 * live 2026-08-12: the theory is wrong on real Chrome. Against an ACTIVE tab
 * held by an alert(), `Page.captureScreenshot` itself never returned and the
 * command rode its full 20s transport budget into a three-way-ambiguous
 * timeout. The pre-flight converts that into the same fast, named failure
 * the other readers give. (The probe still cannot see the OTHER screenshot
 * hang: on a backgrounded tab capture waits for a compositor frame while
 * evaluate answers instantly. Backlog #165, C-03.)
 */
const READS_THE_PAGE: Record<CommandType, boolean> = {
  snapshot: true,
  extract_text: true,
  act: false,
  screenshot: true,
  navigate: false,
  tabs: false,
  history: false,
  console: false,
  network: false,
  dialog: false,
  batch: false,
  cdp: false,
  // Talks only to chrome.runtime; a suspended renderer is irrelevant, and
  // reloading is exactly what a wedged extension needs.
  reload_extension: false,
}

async function runSingle(type: string, args: unknown, ctx?: ExecContext): Promise<CommandResult> {
  // Refs hydrate from storage.session once per worker life (#179). Gated
  // HERE, the one entry every command and every batch sub-command flows
  // through: a command arriving on a freshly recycled worker must not
  // resolve @refs (or split stale-read vs never-minted) against an empty
  // map and un-hydrated counters. Memoized, so every await after the first
  // costs a microtask. This does not violate the bookkeeping-never-blocks
  // rule: that rule is about a WRITE's rejection eating a command, and this
  // is an in-memory read whose promise cannot reject (total failure resolves
  // to the pre-#179 empty-map status quo).
  await refsReady()
  const executor = EXECUTORS[type as CommandType]
  if (!executor) {
    return { ok: false, status: 'error', error: `unknown command_type: ${String(type)}` }
  }
  const tabId = (args as { tab_id?: unknown } | null)?.tab_id
  let loadingAtRead = false
  if (READS_THE_PAGE[type as CommandType] && typeof tabId === 'number') {
    // A dialog we own is named outright (#169): faster than the liveness
    // probe, and the message carries the actual remedy (chrome_dialog)
    // instead of the two-cause guess.
    const dialog = standingDialog(tabId)
    if (dialog) {
      return { ok: false, status: 'error', error: dialogBlockedReadError(tabId, dialog) }
    }
    if (!(await rendererResponsive(tabId, READ_LIVENESS_DEADLINE_MS))) {
      return { ok: false, status: 'error', error: suspendedPageReadError() }
    }
    // Sampled BEFORE the read: "captured while the tab was still loading" is
    // the honest stamp, and a read against a mid-load document returns
    // whatever had committed with nothing else to explain a sparse result.
    // Annotate-only by decision (2026-08-14): no wait, no new hang class;
    // the agent decides whether to re-read.
    const t = await chrome.tabs.get(tabId).catch(() => null)
    loadingAtRead = t?.status === 'loading'
  }
  const result = await executor(args, ctx)
  if (loadingAtRead && result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    return { ...result, data: { ...(result.data as Record<string, unknown>), page_loading: true } }
  }
  return result
}

export const EXECUTORS: Record<CommandType, Executor> = {
  tabs: execTabs,
  navigate: execNavigate,
  history: execHistory,
  snapshot: execSnapshot,
  act: execAct,
  batch: (args, ctx) => execBatch(args, runSingle, ctx),
  extract_text: execExtractText,
  screenshot: execScreenshot,
  console: execConsole,
  network: execNetwork,
  dialog: execDialog,
  cdp: execCdp,
  reload_extension: execReloadExtension,
}

function errorToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** Replace an oversized body with an honest description of what was dropped. */
function capResult(payload: CommandResult, commandType: string): CommandResult {
  let size: number
  try {
    size = JSON.stringify(payload).length
  } catch {
    return {
      ok: false,
      status: 'error',
      error: `${commandType} produced a result that could not be serialized`,
    }
  }
  if (size <= MAX_RESULT_BYTES) return payload
  return {
    ok: false,
    status: 'error',
    error:
      `${commandType} produced a ${Math.round(size / 1_000_000)}MB result, over the ` +
      `${MAX_RESULT_BYTES / 1_000_000}MB transport limit. Narrow it (a selector, a smaller ` +
      'detail level, or a lower limit) and retry.',
  }
}

export interface DispatchHooks {
  onStart?: (event: BrowserCommandEvent) => void
  onResult?: (event: BrowserCommandEvent, result: CommandResult) => void
}

let hooks: DispatchHooks = {}

export function setDispatchHooks(h: DispatchHooks): void {
  hooks = h
}

export async function dispatchBrowserCommand(event: BrowserCommandEvent): Promise<void> {
  const { command_id, command_type, args } = event
  hooks.onStart?.(event)
  // The floor keeps a small wire budget from producing a spent-on-arrival
  // deadline: a command always gets at least a second of working room, and
  // the reserve absorbs the rest. Unreachable with today's backend (its
  // smallest published budget is 5s), kept as cross-repo drift insurance;
  // even fired, a 1s deadline stays inside the backend's `timeout_s + 1`
  // wait for every integer timeout, so the payload still lands.
  const budgetMs =
    typeof event.timeout_seconds === 'number' && event.timeout_seconds > 0
      ? event.timeout_seconds * 1000
      : null
  const ctx: ExecContext | undefined =
    budgetMs === null
      ? undefined
      : { deadline: Date.now() + Math.max(budgetMs - BUDGET_RESERVE_MS, 1_000), budgetMs }
  let payload: CommandResult
  // Through `runSingle`, the same entry a batch's sub-commands use. These were
  // two parallel paths that each looked up the executor themselves, so
  // anything added to one silently missed the other. Keep it one path.
  try {
    payload = await runSingle(String(command_type), args, ctx)
  } catch (e) {
    payload = { ok: false, status: 'error', error: errorToString(e) }
  }
  payload = capResult(payload, String(command_type))
  hooks.onResult?.(event, payload)
  try {
    const { delivered } = await postCommandResult(command_id, payload)
    if (!delivered) {
      logger.warn(`result for ${command_id} arrived after the agent moved on (delivered=false)`)
    }
  } catch (e) {
    logger.error(`failed to POST result for ${command_id}:`, e)
  }
}
