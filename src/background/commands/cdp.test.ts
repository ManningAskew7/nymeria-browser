import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CDP_DENIED_METHODS, execCdp } from './cdp'
import { sendCommand } from '../debuggerSession'

vi.mock('../debuggerSession', () => ({
  sendCommand: vi.fn(async () => ({ echoed: true })),
}))

const send = vi.mocked(sendCommand)

const TAB = 1

/**
 * The fourteen, pinned as a literal so an emptied, trimmed OR widened
 * shipped set fails here rather than drifting from the backend list, which
 * pins the same names in test_chrome_browser_tools.py. The two lists live
 * in different repos with no shared constant: these pins are the whole
 * alignment mechanism, so keep them exact in both directions.
 */
const EXPECTED_DENIED = [
  'Network.getAllCookies',
  'Network.getCookies',
  'Storage.getCookies',
  'DOMStorage.getDOMStorageItems',
  'IndexedDB.requestData',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.runScript',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnLoad',
  'Page.reload',
  'Fetch.enable',
  'Debugger.enable',
  'Page.enable',
]

beforeEach(() => {
  send.mockClear()
})

describe('execCdp', () => {
  it('requires a numeric tab_id and a method', async () => {
    const noTab = await execCdp({ method: 'Page.getLayoutMetrics' })
    expect(noTab.ok).toBe(false)
    expect(noTab.error).toMatch(/tab_id required/)

    const noMethod = await execCdp({ tab_id: TAB })
    expect(noMethod.ok).toBe(false)
    expect(noMethod.error).toMatch(/method required/)

    expect(send).not.toHaveBeenCalled()
  })

  it('denies exactly the agreed method set', () => {
    expect([...CDP_DENIED_METHODS].sort()).toEqual([...EXPECTED_DENIED].sort())
  })

  it('refuses every denied method without touching the debugger session', async () => {
    for (const method of EXPECTED_DENIED) {
      const result = await execCdp({ tab_id: TAB, method })
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`"${method}" is refused`)
      expect(result.error).toMatch(/Nothing was sent/)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('forwards an allowed method with its params under the escape deadline', async () => {
    const params = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
    const result = await execCdp({
      tab_id: TAB,
      method: 'Emulation.setDeviceMetricsOverride',
      params,
    })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      result: { echoed: true },
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(TAB, 'Emulation.setDeviceMetricsOverride', params, {
      deadlineMs: 55_000,
    })
  })

  it('defaults params to an empty object', async () => {
    await execCdp({ tab_id: TAB, method: 'Page.getLayoutMetrics' })
    expect(send).toHaveBeenCalledWith(TAB, 'Page.getLayoutMetrics', {}, { deadlineMs: 55_000 })
  })

  it('reports a sendCommand failure as its own named error', async () => {
    send.mockRejectedValueOnce(new Error('target crashed'))
    const result = await execCdp({ tab_id: TAB, method: 'Page.getLayoutMetrics' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('cdp Page.getLayoutMetrics failed')
    expect(result.error).toContain('target crashed')
  })
})
