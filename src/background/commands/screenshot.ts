import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

interface ScreenshotArgs {
  tab_id: number
  full_page?: boolean
}

export async function execScreenshot(args: unknown): Promise<CommandResult> {
  const a = args as ScreenshotArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }

  if (!a.full_page) {
    const tab = await chrome.tabs.get(a.tab_id)
    if (tab.windowId === undefined) {
      return { ok: false, status: 'error', error: 'tab has no windowId' }
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    // dataUrl is "data:image/png;base64,...."
    const base64 = dataUrl.split(',', 2)[1] ?? ''
    return { ok: true, status: 'success', data: { mime: 'image/png', base64, full_page: false } }
  }

  // Full-page via CDP — captureBeyondViewport stitches the whole document.
  const resp = await sendCommand<{ data: string }>(a.tab_id, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })
  return { ok: true, status: 'success', data: { mime: 'image/png', base64: resp.data, full_page: true } }
}
