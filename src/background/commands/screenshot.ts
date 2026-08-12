import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'
import { withDeadline } from '../settle'

/**
 * The viewport metrics are a nice-to-have on a page that may be wedged, so
 * they get a short leash rather than the renderer's full patience.
 */
const METRICS_DEADLINE_MS = 2_000

interface ScreenshotArgs {
  tab_id: number
  full_page?: boolean
}

interface Metrics {
  width: number
  height: number
  scale: number
  scrollX: number
  scrollY: number
}

/**
 * Both paths go through CDP, deliberately.
 *
 * `chrome.tabs.captureVisibleTab(windowId)` captures whatever tab is ACTIVE in
 * that window, which is not the same thing as the tab we were asked about.
 * Since the whole point of this extension is that the agent works while the
 * user watches (and often works in a background tab), that is both the wrong
 * image and a disclosure: a screenshot of `tab_id` would silently return the
 * user's foreground tab, whatever it happened to be. `Page.captureScreenshot`
 * is bound to the debugger session, so it can only ever capture the tab the
 * agent actually attached to.
 */
export async function execScreenshot(args: unknown): Promise<CommandResult> {
  const a = args as ScreenshotArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const fullPage = a.full_page === true

  const resp = await sendCommand<{ data: string }>(a.tab_id, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage,
  })

  // The viewport box and device scale are what let the model turn a pixel it
  // can see into a `coordinate` it can act on. Without them the vision
  // fallback can look but not point.
  // Deadlined, not just caught: on a suspended page this call does not
  // reject, it never returns. The reader pre-flight in `commands/index.ts`
  // normally refuses a suspended page before capture even runs (measured
  // 2026-08-12: `Page.captureScreenshot` itself hangs on a dialog-suspended
  // tab, compositor or not), so this deadline covers the race where the page
  // suspends between that check and this call. Losing the metrics then costs
  // the vision fallback its coordinates and nothing else: far better than
  // losing the picture that is already in hand.
  const metrics = await withDeadline(
    sendCommand<{ result?: { value?: Metrics } }>(a.tab_id, 'Runtime.evaluate', {
      expression:
        '({width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio,' +
        ' scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY)})',
      returnByValue: true,
    }).catch(() => ({ result: { value: undefined } })),
    METRICS_DEADLINE_MS,
  )
  const m = metrics?.result?.value

  return {
    ok: true,
    status: 'success',
    data: {
      mime: 'image/png',
      base64: resp.data,
      full_page: fullPage,
      viewport: m ? { width: m.width, height: m.height } : null,
      scale: m?.scale ?? null,
      scroll: m ? { x: m.scrollX, y: m.scrollY } : null,
    },
  }
}
