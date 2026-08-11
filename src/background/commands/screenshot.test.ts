import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execScreenshot } from './screenshot'
import { resetForTests as resetDebugger } from '../debuggerSession'

const TAB = 1

beforeEach(() => resetDebugger())

function installCdpMock() {
  const sendCommand = vi.fn(async (...call: unknown[]) => {
    const method = call[1] as string
    if (method === 'Page.captureScreenshot') return { data: 'PNGDATA' }
    if (method === 'Runtime.evaluate') {
      return { result: { value: { width: 1280, height: 720, scale: 2, scrollX: 0, scrollY: 400 } } }
    }
    return {}
  })
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

describe('execScreenshot', () => {
  it('captures the requested tab, not whichever tab the user is looking at', async () => {
    // captureVisibleTab is window-scoped: it returns the window's ACTIVE tab.
    // The agent routinely works in a background tab while the user browses in
    // the foreground, so that path returns the wrong page and leaks whatever
    // the user happens to have open.
    const mock = installCdpMock()
    const captureVisibleTab = vi.fn()
    ;(chrome.tabs.captureVisibleTab as unknown) = captureVisibleTab

    const result = await execScreenshot({ tab_id: TAB })

    expect(result.ok).toBe(true)
    expect(captureVisibleTab, 'must not use the window-scoped capture').not.toHaveBeenCalled()
    const capture = mock.mock.calls.find((c) => c[1] === 'Page.captureScreenshot')
    expect(capture?.[0], 'the capture must be bound to the requested tab').toEqual({ tabId: TAB })
  })

  it('reports viewport and scale so a screenshot pixel can be turned into a coordinate', async () => {
    installCdpMock()

    const result = await execScreenshot({ tab_id: TAB, full_page: false })

    const data = result.data as { viewport: { width: number }; scale: number; scroll: { y: number } }
    expect(data.viewport.width).toBe(1280)
    expect(data.scale).toBe(2)
    expect(data.scroll.y).toBe(400)
  })

  it('stitches beyond the viewport only when full_page is asked for', async () => {
    const mock = installCdpMock()

    await execScreenshot({ tab_id: TAB, full_page: true })
    await execScreenshot({ tab_id: TAB })

    const captures = mock.mock.calls.filter((c) => c[1] === 'Page.captureScreenshot')
    const beyond = (c: (typeof captures)[number]) =>
      (c[2] as { captureBeyondViewport?: boolean } | undefined)?.captureBeyondViewport
    expect(beyond(captures[0])).toBe(true)
    expect(beyond(captures[1])).toBe(false)
  })
})
