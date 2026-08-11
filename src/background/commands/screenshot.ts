import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

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
  const metrics = await sendCommand<{ result?: { value?: Metrics } }>(a.tab_id, 'Runtime.evaluate', {
    expression:
      '({width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio,' +
      ' scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY)})',
    returnByValue: true,
  }).catch(() => ({ result: { value: undefined } }))
  const m = metrics.result?.value

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
