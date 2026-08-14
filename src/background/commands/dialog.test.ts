import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execDialog } from './dialog'
import {
  installCdpEventRouter,
  resetForTests as resetDebugger,
} from '../debuggerSession'
import { resetDialogsForTests } from '../dialogs'

const TAB = 7

type Fire = (tabId: number, method: string, params?: unknown) => void

/** Same real-route pattern as dialogs.test.ts: speak to the router as Chrome would. */
function cdpEvents(): Fire {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const route = addListener.mock.calls.at(-1)![0] as (
    source: { tabId?: number },
    method: string,
    params: unknown,
  ) => void
  return (tabId, method, params = {}) => route({ tabId }, method, params)
}

function mockCdp() {
  const sendCommand = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}))
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

beforeEach(() => {
  vi.useFakeTimers()
  resetDebugger()
  resetDialogsForTests()
  ;(chrome.debugger.attach as unknown) = vi.fn(async () => undefined)
  ;(chrome.debugger.detach as unknown) = vi.fn(async () => undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('execDialog', () => {
  it('answers the standing dialog and names what it answered', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    const result = await execDialog({ tab_id: TAB, action: 'accept' })

    expect(result.ok).toBe(true)
    const data = result.data as { action?: string; dialog?: { type?: string; message?: string } }
    expect(data.action).toBe('accept')
    expect(data.dialog?.type).toBe('confirm')
    expect(data.dialog?.message).toBe('Sure?')
    const answer = cdp.mock.calls.find((c) => c[1] === 'Page.handleJavaScriptDialog')
    expect(answer?.[2]).toEqual({ accept: true })
  })

  it('forwards prompt_text so a prompt can be filled', async () => {
    const cdp = mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?' })

    const result = await execDialog({ tab_id: TAB, action: 'accept', prompt_text: 'Nymeria' })

    expect(result.ok).toBe(true)
    const answer = cdp.mock.calls.find((c) => c[1] === 'Page.handleJavaScriptDialog')
    expect(answer?.[2]).toEqual({ accept: true, promptText: 'Nymeria' })
  })

  it('explains ownership honestly when nothing is standing, without a timeout', async () => {
    mockCdp()

    const result = await execDialog({ tab_id: TAB, action: 'dismiss' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/no dialog is standing/)
    // The measured limitation, taught instead of a blind 5s timeout: a
    // dialog raised outside an attach can never be answered from here.
    expect(error).toMatch(/only while the extension is attached/)
    expect(error).toMatch(/not currently attached/)
    expect(error).toMatch(/Nothing was sent/)
  })

  it('names who already answered when the agent arrives late', async () => {
    mockCdp()
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    fire(TAB, 'Page.javascriptDialogClosed', { result: true })

    const result = await execDialog({ tab_id: TAB, action: 'accept' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/the last one, a confirm \("Sure\?"\)/)
    expect(error).toMatch(/by the user on screen/)
  })

  it('reports a failed answer honestly, with the user-may-have-answered hint', async () => {
    const cdp = mockCdp()
    cdp.mockImplementation(async (_target: unknown, method: unknown) => {
      if (method === 'Page.handleJavaScriptDialog') throw new Error('boom')
      return {}
    })
    const fire = cdpEvents()
    fire(TAB, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })

    const result = await execDialog({ tab_id: TAB, action: 'accept' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/answering the confirm \("Sure\?"\) failed/)
    expect(error, 'the likeliest cause is named, with the next move').toMatch(/re-read the page/)
  })

  it('rejects an unknown action before touching anything', async () => {
    const cdp = mockCdp()
    const result = await execDialog({ tab_id: TAB, action: 'shrug' })
    expect(result.ok).toBe(false)
    expect(cdp).not.toHaveBeenCalled()
  })
})
